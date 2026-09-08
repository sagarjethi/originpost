import type { AnalyticsRepository, AuditEvent, PostAnalyticsSnapshot } from "@originpost/domain";
import type { Sql } from "postgres";

type SnapshotRow = { payload: PostAnalyticsSnapshot };

export class PostgresAnalyticsRepository implements AnalyticsRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, options: { brandId?: string; proofId?: string; limit?: number } = {}): Promise<PostAnalyticsSnapshot[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
    const rows = options.brandId && options.proofId
      ? await this.sql<SnapshotRow[]>`select payload from post_analytics_snapshots where workspace_id = ${workspaceId} and brand_id = ${options.brandId} and proof_id = ${options.proofId} order by captured_at desc limit ${limit}`
      : options.brandId
        ? await this.sql<SnapshotRow[]>`select payload from post_analytics_snapshots where workspace_id = ${workspaceId} and brand_id = ${options.brandId} order by captured_at desc limit ${limit}`
        : options.proofId
          ? await this.sql<SnapshotRow[]>`select payload from post_analytics_snapshots where workspace_id = ${workspaceId} and proof_id = ${options.proofId} order by captured_at desc limit ${limit}`
          : await this.sql<SnapshotRow[]>`select payload from post_analytics_snapshots where workspace_id = ${workspaceId} order by captured_at desc limit ${limit}`;
    return rows.map((row) => row.payload);
  }

  async latestForProof(workspaceId: string, proofId: string): Promise<PostAnalyticsSnapshot | null> {
    return (await this.list(workspaceId, { proofId, limit: 1 }))[0] ?? null;
  }

  async save(snapshot: PostAnalyticsSnapshot, event: AuditEvent): Promise<void> {
    if (snapshot.workspaceId !== event.workspaceId || snapshot.contentItemId !== event.contentItemId) throw new Error("Analytics and audit event must belong to the same content item.");
    await this.sql.begin(async (sql) => {
      await sql`
        insert into post_analytics_snapshots (
          id, workspace_id, brand_id, content_item_id, proof_id, platform, account_id,
          external_post_id, status, captured_at, created_at, payload
        ) values (
          ${snapshot.id}, ${snapshot.workspaceId}, ${snapshot.brandId}, ${snapshot.contentItemId}, ${snapshot.proofId},
          ${snapshot.platform}, ${snapshot.accountId}, ${snapshot.externalPostId}, ${snapshot.status},
          ${snapshot.capturedAt}, ${snapshot.createdAt}, ${sql.json(snapshot as never)}
        ) on conflict (id) do nothing
      `;
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, ${event.contentItemId ?? null}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
    });
  }
}
