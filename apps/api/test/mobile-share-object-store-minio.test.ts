import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { memoryFixtureFor } from "../src/media/memory-media-fixtures.js";
import { S3MediaObjectStore } from "../src/media/media-object-store.js";

const endpoint = process.env.TEST_S3_ENDPOINT;
const suite = endpoint ? describe : describe.skip;

suite("mobile Share Capture on S3-compatible storage", () => {
  const store = endpoint ? new S3MediaObjectStore({
    endpoint,
    publicEndpoint: process.env.TEST_S3_PUBLIC_ENDPOINT ?? endpoint,
    region: process.env.TEST_S3_REGION ?? "us-east-1",
    bucket: process.env.TEST_S3_BUCKET ?? "originpost-media",
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "originpost",
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "originpost-secret",
  }) : undefined;
  const prefix = `qa/mobile-share-${randomUUID()}`;
  const sourceKey = `${prefix}/quarantine`;
  const targetKey = `${prefix}/ready`;

  afterEach(async () => {
    if (!store) return;
    await Promise.all([sourceKey, targetKey].map((key) => store.delete(key).catch(() => undefined)));
  });

  it("streams, verifies, conditionally promotes, and isolates the ready object from a reused quarantine key", async () => {
    const original = memoryFixtureFor("image/png");
    const originalHash = createHash("sha256").update(original).digest("hex");
    await store!.writeCaptured({ objectKey: sourceKey, contentType: "image/png", sizeBytes: original.byteLength, sha256: originalHash }, (async function* () { yield original })());
    await store!.promoteCaptured(sourceKey, { objectKey: targetKey, contentType: "image/png", sizeBytes: original.byteLength, sha256: originalHash });

    const changed = Buffer.from(original);
    changed[changed.byteLength - 1] = changed[changed.byteLength - 1]! ^ 1;
    const changedHash = createHash("sha256").update(changed).digest("hex");
    await store!.writeCaptured({ objectKey: sourceKey, contentType: "image/png", sizeBytes: changed.byteLength, sha256: changedHash }, (async function* () { yield changed })());

    const ready = await store!.read(targetKey);
    const chunks: Buffer[] = [];
    for await (const chunk of ready.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(original);
    expect(ready).toMatchObject({ contentType: "image/png", contentLength: original.byteLength });
  });

  it("signs browser transfers with the public endpoint while keeping server operations private", async () => {
    const bytes = memoryFixtureFor("image/png");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await store!.createUpload({ objectKey: sourceKey, contentType: "image/png", sizeBytes: bytes.byteLength, sha256 });
    const expected = new URL(process.env.TEST_S3_PUBLIC_ENDPOINT ?? endpoint!);
    expect(new URL(upload.url).origin).toBe(expected.origin);
  });
});
