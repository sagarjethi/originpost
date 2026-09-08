import { createHash, randomBytes } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const expectedSchema = "org.originpost.compose-backup";

function argument(name) {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function capture(command, args) {
  const result = await execFile(command, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function digestFile(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      sizeBytes += chunk.byteLength;
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function runWithInput(command, args, inputPath) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["pipe", "ignore", "pipe"] });
    const input = createReadStream(inputPath);
    let errorText = "";
    child.stderr.on("data", (chunk) => { if (errorText.length < 8_192) errorText += chunk.toString("utf8") });
    input.pipe(child.stdin);
    input.on("error", rejectPromise);
    child.on("error", rejectPromise);
    child.on("close", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} restore failed with exit code ${code}: ${errorText.trim().slice(0, 1_000)}`)));
  });
}

async function waitFor(check, label) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${label} did not become ready${lastError instanceof Error ? `: ${lastError.message}` : "."}`);
}

const inventorySql = `
select json_build_object(
  'schemaMigrations', (select count(*)::int from schema_migrations),
  'latestMigration', (select max(name) from schema_migrations),
  'workspaces', (select count(*)::int from workspaces),
  'contentItems', (select count(*)::int from content_items),
  'mediaAssets', (select count(*)::int from media_assets),
  'auditEvents', (select count(*)::int from audit_events),
  'outboxEvents', (select count(*)::int from outbox_events),
  'requiredMediaKeys', coalesce((select json_agg(payload->>'objectKey' order by id) from media_assets where status='ready' and malware_scan_status in ('clean','disabled') and payload ? 'objectKey'), '[]'::json),
  'referencedMediaKeys', coalesce((select json_agg(payload->>'objectKey' order by id) from media_assets where payload ? 'objectKey' and status not in ('deleted','expired')), '[]'::json)
)::text;
`;

async function listObjects(client, bucket) {
  const keys = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }));
    for (const entry of page.Contents ?? []) if (entry.Key) keys.push(entry.Key);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort((left, right) => left.localeCompare(right));
}

async function digestBody(body) {
  if (!body || !(Symbol.asyncIterator in body)) throw new Error("Restored object did not return a stream.");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function main() {
  const requestedBackup = argument("--backup");
  if (!requestedBackup || !isAbsolute(requestedBackup)) throw new Error("Use --backup with an absolute backup directory.");
  const backupDirectory = resolve(requestedBackup);
  const sums = new Map();
  for (const line of (await readFile(resolve(backupDirectory, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match || sums.has(match[2])) throw new Error("Backup checksum inventory is malformed.");
    const path = resolve(backupDirectory, match[2]);
    const relativePath = relative(backupDirectory, path);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Backup checksum inventory contains a path outside the backup directory.");
    sums.set(match[2], match[1]);
  }
  const manifestChecksum = sums.get("manifest.json");
  if (!manifestChecksum || (await digestFile(resolve(backupDirectory, "manifest.json"))).sha256 !== manifestChecksum) throw new Error("Backup manifest checksum failed.");
  const manifest = JSON.parse(await readFile(resolve(backupDirectory, "manifest.json"), "utf8"));
  if (manifest.schema !== expectedSchema || manifest.version !== 1) throw new Error("Unsupported OriginPost backup manifest.");
  if (!manifest.database || !manifest.objectStorage || !Array.isArray(manifest.objectStorage.objects)) throw new Error("Backup manifest is incomplete.");

  const files = [manifest.database, ...manifest.objectStorage.objects];
  const expectedChecksumFiles = new Set(["manifest.json", ...files.map((entry) => entry.file)]);
  if (sums.size !== expectedChecksumFiles.size || [...sums.keys()].some((file) => !expectedChecksumFiles.has(file))) throw new Error("Backup checksum inventory does not exactly match the manifest.");
  for (const entry of files) {
    if (typeof entry.file !== "string" || typeof entry.sha256 !== "string" || typeof entry.sizeBytes !== "number") throw new Error("Backup manifest contains an invalid file entry.");
    const path = resolve(backupDirectory, entry.file);
    const relativePath = relative(backupDirectory, path);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Backup manifest contains a path outside the backup directory.");
    const digest = await digestFile(path);
    if (digest.sha256 !== entry.sha256 || digest.sha256 !== sums.get(entry.file) || digest.sizeBytes !== entry.sizeBytes) throw new Error(`Backup checksum failed for ${entry.file}.`);
  }

  const marker = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const postgresContainer = `originpost-restore-pg-${marker}`;
  const postgresVolume = `originpost-restore-pg-${marker}`;
  const minioContainer = `originpost-restore-minio-${marker}`;
  const minioVolume = `originpost-restore-minio-${marker}`;
  const postgresPassword = randomBytes(24).toString("base64url");
  const minioPassword = randomBytes(24).toString("base64url");
  const created = { postgresContainer: false, postgresVolume: false, minioContainer: false, minioVolume: false };

  try {
    await capture("docker", ["volume", "create", postgresVolume]); created.postgresVolume = true;
    await capture("docker", ["volume", "create", minioVolume]); created.minioVolume = true;
    await capture("docker", ["run", "-d", "--name", postgresContainer, "--network", "none", "-e", "POSTGRES_USER=originpost", "-e", `POSTGRES_PASSWORD=${postgresPassword}`, "-e", "POSTGRES_DB=originpost", "-v", `${postgresVolume}:/var/lib/postgresql/data`, "postgres:16-alpine"]); created.postgresContainer = true;
    await capture("docker", ["run", "-d", "--name", minioContainer, "-p", "127.0.0.1::9000", "-e", "MINIO_ROOT_USER=restore-drill", "-e", `MINIO_ROOT_PASSWORD=${minioPassword}`, "-v", `${minioVolume}:/data`, "minio/minio:latest", "server", "/data"]); created.minioContainer = true;

    await waitFor(async () => {
      try { await capture("docker", ["exec", postgresContainer, "pg_isready", "--username", "originpost", "--dbname", "originpost"]); return true } catch { return false }
    }, "Disposable PostgreSQL");
    const portOutput = await capture("docker", ["port", minioContainer, "9000/tcp"]);
    const port = Number(portOutput.trim().split(":").at(-1));
    if (!Number.isInteger(port) || port < 1) throw new Error("Could not resolve the disposable MinIO port.");
    const minioEndpoint = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(`${minioEndpoint}/minio/health/ready`)).ok, "Disposable MinIO");

    await runWithInput("docker", ["exec", "-i", postgresContainer, "pg_restore", "--username", "originpost", "--dbname", "originpost", "--no-owner", "--no-acl", "--exit-on-error"], resolve(backupDirectory, manifest.database.file));
    const restoredInventory = JSON.parse(await capture("docker", ["exec", postgresContainer, "psql", "--username", "originpost", "--dbname", "originpost", "--tuples-only", "--no-align", "--command", inventorySql]));
    if (JSON.stringify(restoredInventory) !== JSON.stringify(manifest.database.inventory)) throw new Error("Restored PostgreSQL inventory does not match the backup manifest.");

    const client = new S3Client({ endpoint: minioEndpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "restore-drill", secretAccessKey: minioPassword } });
    await client.send(new CreateBucketCommand({ Bucket: manifest.objectStorage.bucket }));
    for (const object of manifest.objectStorage.objects) {
      await client.send(new PutObjectCommand({
        Bucket: manifest.objectStorage.bucket,
        Key: object.key,
        Body: createReadStream(resolve(backupDirectory, object.file)),
        ContentLength: object.sizeBytes,
        ...(object.contentType ? { ContentType: object.contentType } : {}),
        ...(object.contentDisposition ? { ContentDisposition: object.contentDisposition } : {}),
        ...(object.cacheControl ? { CacheControl: object.cacheControl } : {}),
        ...(object.contentEncoding ? { ContentEncoding: object.contentEncoding } : {}),
        ...(object.contentLanguage ? { ContentLanguage: object.contentLanguage } : {}),
        Metadata: object.metadata ?? {},
      }));
    }

    const restoredKeys = await listObjects(client, manifest.objectStorage.bucket);
    const expectedKeys = manifest.objectStorage.objects.map((object) => object.key).sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(restoredKeys) !== JSON.stringify(expectedKeys)) throw new Error("Restored object key inventory does not match the backup manifest.");
    for (const object of manifest.objectStorage.objects) {
      const response = await client.send(new GetObjectCommand({ Bucket: manifest.objectStorage.bucket, Key: object.key }));
      const digest = await digestBody(response.Body);
      if (digest.sha256 !== object.sha256 || digest.sizeBytes !== object.sizeBytes) throw new Error(`Restored object checksum failed for ${object.key}.`);
      if ((response.ContentType ?? undefined) !== object.contentType) throw new Error(`Restored object content type changed for ${object.key}.`);
      if (JSON.stringify(response.Metadata ?? {}) !== JSON.stringify(object.metadata ?? {})) throw new Error(`Restored object metadata changed for ${object.key}.`);
    }
    const restoredKeySet = new Set(restoredKeys);
    const missingRequired = restoredInventory.requiredMediaKeys.filter((key) => !restoredKeySet.has(key));
    if (missingRequired.length) throw new Error(`Restored storage is missing ${missingRequired.length} usable media object(s).`);

    console.log(JSON.stringify({ verified: true, latestMigration: restoredInventory.latestMigration, databaseInventoryFieldsChecked: 7, objectCount: restoredKeys.length, objectBytes: manifest.objectStorage.totalBytes, missingRequiredMediaKeys: 0, missingLegacyOrRejectedMediaKeyCount: manifest.integrity?.missingReferencedMediaKeys?.length ?? 0 }, null, 2));
  } finally {
    if (created.postgresContainer) await execFile("docker", ["rm", "-f", postgresContainer]).catch(() => undefined);
    if (created.minioContainer) await execFile("docker", ["rm", "-f", minioContainer]).catch(() => undefined);
    if (created.postgresVolume) await execFile("docker", ["volume", "rm", postgresVolume]).catch(() => undefined);
    if (created.minioVolume) await execFile("docker", ["volume", "rm", minioVolume]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
