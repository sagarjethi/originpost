import { createImageGeneration, type Actor, type AuditEvent } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresImageGenerationRepository } from "../src/postgres-image-generation-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-image-generation-integration";
const brandId = "brand-image-generation-integration";
const outputMediaId = "media-image-generation-integration";
const actor: Actor = { id: "image-editor", name: "Image editor", role: "creator", actorType: "human" };
const at = "2026-09-13T08:00:00.000Z";

suite("Postgres image generation repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresImageGenerationRepository(sql);

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Image Generation Integration','image-generation-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Image Generation Brand','image-generation','English','UTC','active',${actor.id},${at},${at}) on conflict(id) do nothing`;
    await sql`insert into media_assets(id,workspace_id,brand_id,kind,purpose,file_name,content_type,size_bytes,sha256,object_key,status,rights_state,created_by,created_at,ready_at,payload,upload_expires_at,inspection_status,width_pixels,height_pixels) values(${outputMediaId},${workspaceId},${brandId},'image','creative','generated.png','image/png',100,${"b".repeat(64)},'image-generation/generated.png','ready','owned',${actor.id},${at},${at},${sql.json({} as never)},'2026-09-14T08:00:00.000Z','ready',1024,1536) on conflict(id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from image_generations where workspace_id=${workspaceId}`;
    await sql`delete from media_assets where workspace_id=${workspaceId}`;
    await sql`delete from audit_events where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("replays an exact idempotency key and completes only with the active lease", async () => {
    const made = createImageGeneration({ workspaceId, brandId, provider: "openai", model: "gpt-image-2.5-sunburst", prompt: "A clearly illustrative skyline with no text or logos.", visualIntent: "illustration", size: "1024x1536", quality: "medium", altText: "Illustrated skyline", idempotencyKey: "postgres-image-generation-1", leaseOwner: "image-worker-1", leaseExpiresAt: "2099-09-13T08:10:00.000Z", actor, now: at });
    await expect(repository.create(made.record, made.event)).resolves.toMatchObject({ created: true });
    await expect(repository.create({ ...made.record, id: "image-generation-replay" }, made.event)).resolves.toMatchObject({ created: false, record: { id: made.record.id } });
    const event: AuditEvent = { id: "image-generation-completed-postgres", workspaceId, actorId: "image-generator", actorType: "system", action: "image-generation.completed", detail: {}, createdAt: at };
    await expect(repository.complete({ workspaceId, id: made.record.id, leaseOwner: "wrong", outputMediaId, outputSha256: "b".repeat(64), finishedAt: at, event })).resolves.toBeNull();
    await expect(repository.complete({ workspaceId, id: made.record.id, leaseOwner: "image-worker-1", outputMediaId, outputSha256: "b".repeat(64), providerRequestId: "req-image", finishedAt: at, event })).resolves.toMatchObject({ status: "ready", outputMediaId, providerRequestId: "req-image" });
  });
});
