import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestSchema = "org.originpost.compose-backup";
const databaseFile = "postgres.dump";
const manifestFile = "manifest.json";
const sumsFile = "SHA256SUMS";

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

async function dumpDatabase(path) {
  await new Promise((resolvePromise, rejectPromise) => {
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const child = spawn("docker", ["compose", "exec", "-T", "postgres", "pg_dump", "--username", "originpost", "--dbname", "originpost", "--format", "custom", "--no-owner", "--no-acl"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => { if (errorText.length < 8_192) errorText += chunk.toString("utf8") });
    child.stdout.pipe(output);
    child.on("error", rejectPromise);
    output.on("error", rejectPromise);
    child.on("close", (code) => {
      output.end(() => code === 0 ? resolvePromise() : rejectPromise(new Error(`pg_dump failed with exit code ${code}: ${errorText.trim().slice(0, 1_000)}`)));
    });
  });
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

async function databaseInventory() {
  const value = await capture("docker", ["compose", "exec", "-T", "postgres", "psql", "--username", "originpost", "--dbname", "originpost", "--tuples-only", "--no-align", "--command", inventorySql]);
  return JSON.parse(value);
}

function objectStore() {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const bucket = process.env.S3_BUCKET ?? "originpost-media";
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY are required. Load the deployment environment without printing it.");
  return {
    bucket,
    client: new S3Client({ endpoint, region: process.env.S3_REGION ?? "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }),
  };
}

async function listObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }));
    for (const entry of page.Contents ?? []) if (entry.Key) objects.push(entry.Key);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects.sort((left, right) => left.localeCompare(right));
}

async function backupObject(client, bucket, key, outputDirectory, index) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body || !(Symbol.asyncIterator in response.Body)) throw new Error(`Object ${key} did not return a stream.`);
  const keyDigest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  const file = `objects/${String(index).padStart(6, "0")}-${keyDigest}.bin`;
  const path = resolve(outputDirectory, file);
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of response.Body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      hash.update(bytes);
      await handle.write(bytes);
    }
  } finally {
    await handle.close();
  }
  if (response.ContentLength !== undefined && response.ContentLength !== sizeBytes) throw new Error(`Object ${key} changed size during backup.`);
  return {
    key,
    file,
    sha256: hash.digest("hex"),
    sizeBytes,
    ...(response.ContentType ? { contentType: response.ContentType } : {}),
    ...(response.ContentDisposition ? { contentDisposition: response.ContentDisposition } : {}),
    ...(response.CacheControl ? { cacheControl: response.CacheControl } : {}),
    ...(response.ContentEncoding ? { contentEncoding: response.ContentEncoding } : {}),
    ...(response.ContentLanguage ? { contentLanguage: response.ContentLanguage } : {}),
    metadata: response.Metadata ?? {},
  };
}

async function main() {
  const requestedOutput = argument("--output");
  if (!requestedOutput || !isAbsolute(requestedOutput)) throw new Error("Use --output with a new absolute directory outside the repository.");
  const outputDirectory = resolve(requestedOutput);
  const relativeToRepository = relative(repositoryRoot, outputDirectory);
  if (!relativeToRepository.startsWith("..") && !isAbsolute(relativeToRepository)) throw new Error("Backup output must be outside the public repository.");

  const running = new Set((await capture("docker", ["compose", "ps", "--status", "running", "--services"])).split("\n").filter(Boolean));
  const activeWriters = ["api", "worker", "web", "telegram-bot"].filter((service) => running.has(service));
  if (activeWriters.length) throw new Error(`Stop write-capable services before backup: ${activeWriters.join(", ")}. PostgreSQL and MinIO must remain running.`);
  if (!running.has("postgres") || !running.has("minio")) throw new Error("The PostgreSQL and MinIO Compose services must be running.");

  await mkdir(outputDirectory, { mode: 0o700 });
  try {
    await mkdir(resolve(outputDirectory, "objects"), { mode: 0o700 });
    await dumpDatabase(resolve(outputDirectory, databaseFile));
    const database = await digestFile(resolve(outputDirectory, databaseFile));
    const inventory = await databaseInventory();
    const { client, bucket } = objectStore();
    const keys = await listObjects(client, bucket);
    const objects = [];
    for (const [index, key] of keys.entries()) objects.push(await backupObject(client, bucket, key, outputDirectory, index));

    const keySet = new Set(keys);
    const missingRequiredMediaKeys = inventory.requiredMediaKeys.filter((key) => !keySet.has(key));
    if (missingRequiredMediaKeys.length) throw new Error(`Backup integrity failed: ${missingRequiredMediaKeys.length} usable media object(s) are missing from storage.`);
    const missingReferencedMediaKeys = inventory.referencedMediaKeys.filter((key) => !keySet.has(key));
    const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
    const manifest = {
      schema: manifestSchema,
      version: 1,
      createdAt: new Date().toISOString(),
      applicationVersion: packageJson.version,
      database: { file: databaseFile, ...database, inventory },
      objectStorage: { bucket, objectCount: objects.length, totalBytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0), objects },
      integrity: { missingRequiredMediaKeys, missingReferencedMediaKeys },
    };
    await writeFile(resolve(outputDirectory, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const sums = [];
    for (const file of [databaseFile, ...objects.map((object) => object.file), manifestFile]) {
      const digest = await digestFile(resolve(outputDirectory, file));
      sums.push(`${digest.sha256}  ${file}`);
    }
    await writeFile(resolve(outputDirectory, sumsFile), `${sums.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ outputDirectory, databaseBytes: database.sizeBytes, objectCount: objects.length, objectBytes: manifest.objectStorage.totalBytes, latestMigration: inventory.latestMigration, missingReferencedMediaKeyCount: missingReferencedMediaKeys.length }, null, 2));
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
