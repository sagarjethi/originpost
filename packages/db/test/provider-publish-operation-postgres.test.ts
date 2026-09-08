import type { ProviderPublishOperation } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresProviderPublishOperationRepository } from "../src/postgres-provider-publish-operation-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-provider-claim-integration";
const brandId = "brand-provider-claim-integration";
const contentItemId = "content-provider-claim-integration";
const targetId = "target-provider-claim-integration";
const at = "2026-09-01T10:00:00.000Z";

suite("Postgres provider publication execution claims", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresProviderPublishOperationRepository(sql);
  const seed: ProviderPublishOperation = {
    id: "provider-operation-claim-integration", workspaceId, contentItemId, targetId, attemptId: "attempt-1", platform: "instagram",
    status: "creating", containerId: "", childContainerIds: [], createdAt: at, updatedAt: at,
  };

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Provider claim integration','provider-claim-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Provider claim brand','provider-claim','English','UTC','active','provider-claim-test',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into content_items(id,workspace_id,brand_id,version,title,status,risk_level,payload,created_at,updated_at) values(${contentItemId},${workspaceId},${brandId},1,'Provider claim','scheduled','low',${sql.json({} as never)},${at},${at}) on conflict(id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from provider_publish_operations where workspace_id=${workspaceId}`;
    await sql`delete from content_items where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("atomically elects one writer and fences it after repository-clock expiry", async () => {
    const claims = await Promise.all([
      repository.claimExecution(seed, "worker-a", 900),
      repository.claimExecution(seed, "worker-b", 900),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    await expect(repository.get(workspaceId, targetId)).resolves.toMatchObject({ status: "creating", containerId: "" });

    const originalOwner = claims.find((claim) => claim.claimed)!.operation.claimOwner!;
    const replacementOwner = originalOwner === "worker-a" ? "worker-b" : "worker-a";
    await sql`update provider_publish_operations set claim_expires_at=clock_timestamp()-interval '1 second' where workspace_id=${workspaceId} and target_id=${targetId}`;
    const replacement = await repository.claimExecution(seed, replacementOwner, 900);
    expect(replacement).toMatchObject({ claimed: true, created: false, operation: { claimOwner: replacementOwner, status: "creating" } });
    await expect(repository.saveClaimed({ ...replacement.operation, status: "processing", containerId: "stale-container" }, originalOwner)).resolves.toBe(false);
    await expect(repository.saveClaimed({ ...replacement.operation, status: "uncertain" }, replacementOwner)).resolves.toBe(true);
    await expect(repository.listByStatus(workspaceId, ["uncertain"])).resolves.toEqual([expect.objectContaining({ targetId, status: "uncertain" })]);
  });
});
