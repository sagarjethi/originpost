import { createBatchPlan, type Actor, type AuditEvent } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresBatchPlanRepository } from "../src/postgres-batch-plan-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-batch-integration";
const brandId = "brand-batch-integration";
const ownerId = "owner-batch-integration";
const at = "2026-09-01T05:00:00.000Z";

suite("Postgres batch operations repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresBatchPlanRepository(sql);
  const actor: Actor = { id: ownerId, name: "Batch owner", role: "owner", actorType: "human" };
  const event = (id: string, action: string): AuditEvent => ({ id, workspaceId, actorId: ownerId, actorType: "human", action, detail: { brandId }, createdAt: at });

  beforeAll(async () => {
    await sql`insert into workspaces (id,name,slug,created_at) values (${workspaceId},'Batch integration','batch-integration',${at}) on conflict (id) do nothing`;
    await sql`insert into auth_users (id,email,display_name,password_hash,status,created_at,updated_at) values (${ownerId},'batch-integration@example.invalid','Batch owner','disabled','active',${at},${at}) on conflict (id) do nothing`;
    await sql`insert into workspace_members (workspace_id,user_id,display_name,role,created_at,updated_at) values (${workspaceId},${ownerId},'Batch owner','owner',${at},${at}) on conflict (workspace_id,user_id) do nothing`;
    await sql`insert into brands (id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values (${brandId},${workspaceId},'Batch brand','batch','English','UTC','active',${ownerId},${at},${at}) on conflict (id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql`delete from auth_users where id=${ownerId}`;
    await sql.end();
  });

  it("round-trips plans, deduplicates source input, and enforces optimistic replacement", async () => {
    const plan = createBatchPlan({ id: "batch-postgres", workspaceId, brandId, name: "Postgres batch", actor, rows: [{ externalRef: "row-1", title: "First row", caption: "First caption", platform: "facebook", format: "text" }] }, at);
    const created = await repository.create(plan, event("audit-batch-created", "batch.preview-created"));
    expect(created).toMatchObject({ created: true, plan: { id: plan.id, version: 1, sourceSha256: plan.sourceSha256 } });
    const replay = await repository.create({ ...plan, id: "batch-postgres-replay" }, event("audit-batch-replay", "batch.preview-created"));
    expect(replay).toMatchObject({ created: false, plan: { id: plan.id } });

    const processing = { ...plan, version: 2, status: "processing" as const, updatedAt: "2026-09-01T05:01:00.000Z" };
    expect(await repository.replace(workspaceId, plan.id, 1, processing, event("audit-batch-processing", "batch.prepare-started"))).toMatchObject({ version: 2, status: "processing" });
    await expect(repository.replace(workspaceId, plan.id, 1, { ...processing, version: 3 }, event("audit-batch-stale", "batch.prepare-started"))).resolves.toBeNull();
    expect(await repository.get(workspaceId, plan.id)).toMatchObject({ version: 2, status: "processing" });
    expect(await repository.list(workspaceId, brandId)).toEqual([expect.objectContaining({ id: plan.id })]);
  });
});
