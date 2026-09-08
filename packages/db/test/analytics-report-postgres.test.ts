import {
  createAnalyticsReportDefinition,
  createAnalyticsReportSnapshot,
  type Actor,
  type AnalyticsReportShare,
  type AuditEvent,
} from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAnalyticsReportRepository } from "../src/postgres-analytics-report-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-report-integration";
const ownerId = "owner-report-integration";
const at = "2026-09-01T04:00:00.000Z";

suite("Postgres analytics client report repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresAnalyticsReportRepository(sql);
  const actor: Actor = { id: ownerId, name: "Report owner", role: "owner", actorType: "human" };
  const audit = (id: string, action: string, detail: Record<string, unknown>): AuditEvent => ({ id, workspaceId, actorId: ownerId, actorType: "human", action, detail, createdAt: at });

  beforeAll(async () => {
    await sql`insert into workspaces (id, name, slug, created_at) values (${workspaceId}, 'Report integration', 'report-integration', ${at})`;
    await sql`insert into auth_users (id, email, display_name, password_hash, status, created_at, updated_at) values (${ownerId}, 'report-integration@example.invalid', 'Report owner', 'disabled', 'active', ${at}, ${at})`;
    await sql`insert into workspace_members (workspace_id, user_id, display_name, role, created_at, updated_at) values (${workspaceId}, ${ownerId}, 'Report owner', 'owner', ${at}, ${at})`;
  });

  afterAll(async () => { await sql.end(); });

  it("round-trips immutable snapshots and revocable token-hash-only shares", async () => {
    const definitionResult = createAnalyticsReportDefinition({
      workspaceId, name: "Client report", brandIds: ["brand-report"], range: { mode: "rolling", days: 30 },
      platforms: ["instagram"], accountIds: [], metricKeys: ["views"], actor, now: at,
    });
    await repository.saveDefinition(definitionResult.definition, definitionResult.event);
    const snapshotResult = createAnalyticsReportSnapshot({
      definition: definitionResult.definition, actor, generatedAt: at,
      proofRows: [{
        proofId: "proof-report", contentItemId: "content-report", brandId: "brand-report", brandName: "Report brand",
        title: "Verified post", platform: "instagram", accountId: "account-report", accountName: "Instagram",
        externalPostId: "external-report", liveUrl: "https://www.instagram.com/p/report/", publishedAt: "2026-08-31T04:00:00.000Z",
        status: "ready", metrics: [{ key: "views", value: 42, unit: "count", rawMetric: "views", source: "instagram_media_insights", coverage: "instagram_only", definitionVersion: "2026-01" }], caveats: [],
      }],
    });
    await repository.saveSnapshot(snapshotResult.snapshot, snapshotResult.event);
    expect(await repository.getSnapshot(workspaceId, definitionResult.definition.id, snapshotResult.snapshot.id)).toMatchObject({ canonicalSha256: snapshotResult.snapshot.canonicalSha256 });
    await expect(sql`update analytics_report_snapshots set payload = '{}'::jsonb where id = ${snapshotResult.snapshot.id}`).rejects.toThrow(/append-only/i);

    const share: AnalyticsReportShare = {
      id: "share-report", workspaceId, reportId: definitionResult.definition.id, snapshotId: snapshotResult.snapshot.id,
      tokenSha256: "a".repeat(64), expiresAt: "2026-09-15T04:00:00.000Z", createdBy: ownerId, createdAt: at,
    };
    await repository.saveShare(share, audit("audit-report-share", "analytics.report-shared", { reportId: share.reportId, shareId: share.id }));
    expect(await repository.getShareByTokenSha256(share.tokenSha256)).toMatchObject({ id: share.id, tokenSha256: share.tokenSha256 });
    expect(await repository.listShares(workspaceId, share.reportId, share.snapshotId)).toHaveLength(1);
    const revoked = await repository.revokeShare(workspaceId, share.reportId, share.id, ownerId, "2026-09-01T05:00:00.000Z", audit("audit-report-revoke", "analytics.report-share-revoked", { reportId: share.reportId, shareId: share.id }));
    expect(revoked).toMatchObject({ id: share.id, revokedBy: ownerId, revokedAt: "2026-09-01T05:00:00.000Z" });
  });
});
