import { DomainError, type AnalyticsReportDefinition, type AnalyticsReportRepository, type AnalyticsReportShare, type AnalyticsReportSnapshot, type AuditEvent } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type DefinitionRow = { payload: AnalyticsReportDefinition };
type SnapshotRow = { payload: AnalyticsReportSnapshot };
type ShareRow = { payload: AnalyticsReportShare };

function shareProjection(sql: Sql | TransactionSql) {
  return sql`jsonb_strip_nulls(jsonb_build_object(
    'id', id, 'workspaceId', workspace_id, 'reportId', report_id, 'snapshotId', snapshot_id,
    'tokenSha256', token_sha256, 'expiresAt', to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdBy', created_by, 'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revokedAt', case when revoked_at is null then null else to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'revokedBy', revoked_by
  ))`;
}

async function appendAudit(sql: Sql | TransactionSql, event: AuditEvent): Promise<void> {
  await sql`
    insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
    values (${event.id}, ${event.workspaceId}, ${event.contentItemId ?? null}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
    on conflict (id) do nothing
  `;
}

export class PostgresAnalyticsReportRepository implements AnalyticsReportRepository {
  constructor(private readonly sql: Sql) {}

  async listDefinitions(workspaceId: string, includeArchived = false): Promise<AnalyticsReportDefinition[]> {
    const rows = await this.sql<DefinitionRow[]>`
      select payload from analytics_report_definitions
      where workspace_id = ${workspaceId} and (${includeArchived} or status = 'active')
      order by updated_at desc, id
    `;
    return rows.map((row) => row.payload);
  }

  async getDefinition(workspaceId: string, reportId: string): Promise<AnalyticsReportDefinition | null> {
    const rows = await this.sql<DefinitionRow[]>`select payload from analytics_report_definitions where workspace_id = ${workspaceId} and id = ${reportId} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async saveDefinition(definition: AnalyticsReportDefinition, event: AuditEvent): Promise<void> {
    if (definition.workspaceId !== event.workspaceId || event.detail.reportId !== definition.id) throw new Error("Analytics report and audit event must have matching lineage.");
    await this.sql.begin(async (sql) => {
      const saved = await sql<{ id: string }[]>`
        insert into analytics_report_definitions (id, workspace_id, version, name, status, brand_ids, created_by, payload, created_at, updated_at)
        values (${definition.id}, ${definition.workspaceId}, ${definition.version}, ${definition.name}, ${definition.status}, ${sql.json(definition.brandIds as never)}, ${definition.createdBy}, ${sql.json(definition as never)}, ${definition.createdAt}, ${definition.updatedAt})
        on conflict (id) do update set version = excluded.version, name = excluded.name, status = excluded.status, brand_ids = excluded.brand_ids, payload = excluded.payload, updated_at = excluded.updated_at
        where analytics_report_definitions.workspace_id = excluded.workspace_id and analytics_report_definitions.version = excluded.version - 1
        returning id
      `;
      if (saved.length !== 1) throw new DomainError("This report changed while you were working.", "analytics_report_version_conflict", 409);
      await appendAudit(sql, event);
    });
  }

  async listSnapshots(workspaceId: string, reportId: string, limit = 20): Promise<AnalyticsReportSnapshot[]> {
    const bounded = Math.max(1, Math.min(limit, 100));
    const rows = await this.sql<SnapshotRow[]>`
      select payload from analytics_report_snapshots
      where workspace_id = ${workspaceId} and report_id = ${reportId}
      order by generated_at desc, id limit ${bounded}
    `;
    return rows.map((row) => row.payload);
  }

  async getSnapshot(workspaceId: string, reportId: string, snapshotId: string): Promise<AnalyticsReportSnapshot | null> {
    const rows = await this.sql<SnapshotRow[]>`select payload from analytics_report_snapshots where workspace_id = ${workspaceId} and report_id = ${reportId} and id = ${snapshotId} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async saveSnapshot(snapshot: AnalyticsReportSnapshot, event: AuditEvent): Promise<void> {
    if (snapshot.workspaceId !== event.workspaceId || event.detail.reportId !== snapshot.reportId || event.detail.snapshotId !== snapshot.id) throw new Error("Analytics snapshot and audit event must have matching lineage.");
    await this.sql.begin(async (sql) => {
      const saved = await sql<{ id: string }[]>`
        insert into analytics_report_snapshots (id, workspace_id, report_id, report_version, canonical_sha256, period_from, period_to, proof_count, group_count, generated_by, payload, generated_at)
        values (${snapshot.id}, ${snapshot.workspaceId}, ${snapshot.reportId}, ${snapshot.reportVersion}, ${snapshot.canonicalSha256}, ${snapshot.periodFrom}, ${snapshot.periodTo}, ${snapshot.proofRows.length}, ${snapshot.groups.length}, ${snapshot.generatedBy}, ${sql.json(snapshot as never)}, ${snapshot.generatedAt})
        on conflict (id) do nothing returning id
      `;
      if (saved.length !== 1) throw new DomainError("This immutable report snapshot already exists.", "analytics_report_snapshot_exists", 409);
      await appendAudit(sql, event);
    });
  }

  async saveShare(share: AnalyticsReportShare, event: AuditEvent): Promise<void> {
    if (share.workspaceId !== event.workspaceId || event.detail.reportId !== share.reportId || event.detail.shareId !== share.id) throw new Error("Analytics report share and audit event must have matching lineage.");
    await this.sql.begin(async (sql) => {
      const saved = await sql<{ id: string }[]>`
        insert into analytics_report_shares (id, workspace_id, report_id, snapshot_id, token_sha256, expires_at, created_by, created_at)
        values (${share.id}, ${share.workspaceId}, ${share.reportId}, ${share.snapshotId}, ${share.tokenSha256}, ${share.expiresAt}, ${share.createdBy}, ${share.createdAt})
        on conflict do nothing returning id
      `;
      if (saved.length !== 1) throw new DomainError("Could not create a unique report share link.", "analytics_report_share_exists", 409);
      await appendAudit(sql, event);
    });
  }

  async listShares(workspaceId: string, reportId: string, snapshotId?: string): Promise<AnalyticsReportShare[]> {
    const rows = await this.sql<ShareRow[]>`
      select ${shareProjection(this.sql)} as payload
      from analytics_report_shares
      where workspace_id = ${workspaceId} and report_id = ${reportId}
        and (${snapshotId ?? null}::text is null or snapshot_id = ${snapshotId ?? null})
      order by created_at desc, id
    `;
    return rows.map((row) => row.payload);
  }

  async getShareByTokenSha256(tokenSha256: string): Promise<AnalyticsReportShare | null> {
    const rows = await this.sql<ShareRow[]>`select ${shareProjection(this.sql)} as payload from analytics_report_shares where token_sha256 = ${tokenSha256} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async revokeShare(workspaceId: string, reportId: string, shareId: string, actorId: string, revokedAt: string, event: AuditEvent): Promise<AnalyticsReportShare | null> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<ShareRow[]>`
        update analytics_report_shares set revoked_at = ${revokedAt}, revoked_by = ${actorId}
        where workspace_id = ${workspaceId} and report_id = ${reportId} and id = ${shareId} and revoked_at is null
        returning ${shareProjection(sql)} as payload
      `;
      if (!rows[0]?.payload) return null;
      await appendAudit(sql, event);
      return rows[0].payload;
    });
  }
}
