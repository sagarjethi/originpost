import { createHash } from "node:crypto";
import { CopyObjectCommand, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable, Transform } from "node:stream";
import { memoryFixtureFor } from "./memory-media-fixtures.js";

export interface ObjectUploadRequest {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ObjectByteRange {
  start: number;
  end: number;
}

export interface MediaObjectStore {
  createUpload(request: ObjectUploadRequest): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>;
  finalize(request: ObjectUploadRequest): Promise<{ objectKey: string }>;
  writeGenerated(request: ObjectUploadRequest, bytes: Uint8Array): Promise<{ objectKey: string }>;
  writeCaptured(request: ObjectUploadRequest, body: AsyncIterable<Uint8Array>): Promise<{ objectKey: string }>;
  promoteCaptured(sourceObjectKey: string, target: ObjectUploadRequest): Promise<{ objectKey: string }>;
  createDownload(objectKey: string, fileName: string): Promise<{ url: string; expiresAt: string }>;
  read(objectKey: string, range?: ObjectByteRange): Promise<{ body: unknown; contentType?: string; contentLength?: number }>;
  delete(objectKey: string): Promise<void>;
}

export class MemoryMediaObjectStore implements MediaObjectStore {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async createUpload(request: ObjectUploadRequest) {
    this.objects.set(request.objectKey, { bytes: memoryFixtureFor(request.contentType), contentType: request.contentType });
    return { url: `https://upload.invalid/${encodeURIComponent(request.objectKey)}`, headers: { "content-type": request.contentType }, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  }
  async finalize(request: ObjectUploadRequest): Promise<{ objectKey: string }> {
    const objectKey = finalizedObjectKey(request);
    const stored = this.objects.get(request.objectKey);
    if (stored) this.objects.set(objectKey, stored);
    return { objectKey };
  }
  async writeGenerated(request: ObjectUploadRequest, bytes: Uint8Array): Promise<{ objectKey: string }> {
    assertGeneratedBytes(request, bytes);
    const objectKey = finalizedObjectKey(request);
    this.objects.set(objectKey, { bytes: Buffer.from(bytes), contentType: request.contentType });
    return { objectKey };
  }
  async writeCaptured(request: ObjectUploadRequest, body: AsyncIterable<Uint8Array>): Promise<{ objectKey: string }> {
    const bytes = await verifiedCapturedBytes(request, body);
    this.objects.set(request.objectKey, { bytes, contentType: request.contentType });
    return { objectKey: request.objectKey };
  }
  async promoteCaptured(sourceObjectKey: string, target: ObjectUploadRequest): Promise<{ objectKey: string }> {
    const source = this.objects.get(sourceObjectKey);
    if (!source) throw new Error("Captured media is unavailable.");
    assertGeneratedBytes(target, source.bytes);
    if (source.contentType.toLowerCase() !== target.contentType.toLowerCase()) throw new Error("Captured content type does not match the receipt.");
    this.objects.set(target.objectKey, { bytes: Buffer.from(source.bytes), contentType: target.contentType });
    return { objectKey: target.objectKey };
  }
  async createDownload(objectKey: string) { return { url: `https://download.invalid/${encodeURIComponent(objectKey)}`, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
  async read(objectKey: string, range?: ObjectByteRange) {
    const stored = this.objects.get(objectKey);
    if (!stored) {
      const contentLength = range ? range.end - range.start + 1 : 0;
      return { body: Buffer.alloc(contentLength), contentType: "application/octet-stream", contentLength };
    }
    const bytes = range ? stored.bytes.subarray(range.start, Math.min(stored.bytes.byteLength, range.end + 1)) : stored.bytes;
    return { body: bytes, contentType: stored.contentType, contentLength: bytes.byteLength };
  }
  async delete(objectKey: string): Promise<void> { this.objects.delete(objectKey) }
}

export class S3MediaObjectStore implements MediaObjectStore {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private bucketReady?: Promise<void>;

  constructor(private readonly options: { endpoint: string; publicEndpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
    const clientOptions = { region: options.region, forcePathStyle: true, credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } };
    this.client = new S3Client({ ...clientOptions, endpoint: options.endpoint });
    this.publicClient = options.publicEndpoint && options.publicEndpoint !== options.endpoint
      ? new S3Client({ ...clientOptions, endpoint: options.publicEndpoint })
      : this.client;
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try { await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket })) }
      catch { await this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket })) }
    })();
    return this.bucketReady;
  }

  async createUpload(request: ObjectUploadRequest) {
    await this.ensureBucket();
    const expiresIn = 900;
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: request.objectKey,
      ContentType: request.contentType,
      ContentLength: request.sizeBytes,
      Metadata: { "originpost-sha256": request.sha256 },
    });
    const url = await getSignedUrl(this.publicClient, command, { expiresIn });
    return {
      url,
      // AWS hoists the signed metadata into the query string. Sending it again as
      // an unsigned header makes MinIO reject the request.
      headers: { "content-type": request.contentType },
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async finalize(request: ObjectUploadRequest): Promise<{ objectKey: string }> {
    await this.ensureBucket();
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: request.objectKey }));
    if (!response.Body) throw new Error("Uploaded object is empty.");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) { size += chunk.byteLength; hash.update(chunk) }
    if (size !== request.sizeBytes) throw new Error("Uploaded file size does not match the request.");
    if ((response.ContentType ?? "").toLowerCase() !== request.contentType.toLowerCase()) throw new Error("Uploaded content type does not match the request.");
    if (hash.digest("hex") !== request.sha256) throw new Error("Uploaded file hash does not match the request.");
    if (!response.ETag) throw new Error("Uploaded object is missing an entity tag.");

    const objectKey = finalizedObjectKey(request);
    const source = [this.options.bucket, ...request.objectKey.split("/")].map(encodeURIComponent).join("/")
      + (response.VersionId ? `?versionId=${encodeURIComponent(response.VersionId)}` : "");
    await this.client.send(new CopyObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      CopySource: source,
      CopySourceIfMatch: response.ETag,
      MetadataDirective: "COPY",
    }));
    return { objectKey };
  }

  async writeGenerated(request: ObjectUploadRequest, bytes: Uint8Array): Promise<{ objectKey: string }> {
    await this.ensureBucket();
    assertGeneratedBytes(request, bytes);
    const objectKey = finalizedObjectKey(request);
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: request.contentType,
      ContentLength: request.sizeBytes,
      Metadata: { "originpost-sha256": request.sha256, "originpost-generated": "true" },
    }));
    return { objectKey };
  }

  async writeCaptured(request: ObjectUploadRequest, body: AsyncIterable<Uint8Array>): Promise<{ objectKey: string }> {
    await this.ensureBucket();
    const hash = createHash("sha256");
    let size = 0;
    const verifying = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        hash.update(bytes);
        callback(null, bytes);
      },
    });
    const source = Readable.from(body);
    source.on("error", (error) => verifying.destroy(error));
    source.pipe(verifying);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: request.objectKey,
        Body: verifying,
        ContentType: request.contentType,
        ContentLength: request.sizeBytes,
        Metadata: { "originpost-sha256": request.sha256, "originpost-quarantine": "true" },
      }));
      if (size !== request.sizeBytes || hash.digest("hex") !== request.sha256) throw new Error("Captured file bytes changed while being stored.");
      return { objectKey: request.objectKey };
    } catch (error) {
      source.destroy();
      verifying.destroy();
      await this.delete(request.objectKey).catch(() => undefined);
      throw error;
    }
  }

  async promoteCaptured(sourceObjectKey: string, target: ObjectUploadRequest): Promise<{ objectKey: string }> {
    await this.ensureBucket();
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: sourceObjectKey }));
    if (!response.Body || !response.ETag) throw new Error("Captured media is unavailable.");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) { size += chunk.byteLength; hash.update(chunk) }
    if (size !== target.sizeBytes || hash.digest("hex") !== target.sha256) throw new Error("Captured media no longer matches its receipt.");
    if ((response.ContentType ?? "").toLowerCase() !== target.contentType.toLowerCase()) throw new Error("Captured content type no longer matches its receipt.");
    const source = [this.options.bucket, ...sourceObjectKey.split("/")].map(encodeURIComponent).join("/")
      + (response.VersionId ? `?versionId=${encodeURIComponent(response.VersionId)}` : "");
    await this.client.send(new CopyObjectCommand({
      Bucket: this.options.bucket,
      Key: target.objectKey,
      CopySource: source,
      CopySourceIfMatch: response.ETag,
      MetadataDirective: "COPY",
    }));
    return { objectKey: target.objectKey };
  }

  async createDownload(objectKey: string, fileName: string) {
    await this.ensureBucket();
    const expiresIn = 300;
    const safeName = fileName.replace(/["\r\n]/g, "_");
    const url = await getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey, ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  async read(objectKey: string, range?: ObjectByteRange) {
    await this.ensureBucket();
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: objectKey,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    }));
    if (!response.Body) throw new Error("Stored media object is empty.");
    return { body: response.Body, ...(response.ContentType ? { contentType: response.ContentType } : {}), ...(response.ContentLength !== undefined ? { contentLength: response.ContentLength } : {}) };
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }));
  }
}

function finalizedObjectKey(request: ObjectUploadRequest): string {
  return `${request.objectKey}.final-${request.sha256}`;
}

function assertGeneratedBytes(request: ObjectUploadRequest, bytes: Uint8Array): void {
  if (bytes.byteLength !== request.sizeBytes) throw new Error("Generated file size does not match the request.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== request.sha256) throw new Error("Generated file hash does not match the request.");
}

async function verifiedCapturedBytes(request: ObjectUploadRequest, body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > request.sizeBytes) throw new Error("Captured file exceeds its observed size.");
    hash.update(bytes);
    chunks.push(bytes);
  }
  if (size !== request.sizeBytes || hash.digest("hex") !== request.sha256) throw new Error("Captured file bytes changed while being stored.");
  return Buffer.concat(chunks, size);
}
