import type { MonitorFingerprint, MonitorRepository, MonitorRule, MonitorRun } from "@originpost/domain";
import type { Sql } from "postgres";

type RuleRow = { payload: MonitorRule };
type RunRow = { payload: MonitorRun };

function hydrateRun(run: MonitorRun): MonitorRun {
  return { ...run, trigger: run.trigger ?? "scheduled" };
}

function hydrateRule(rule: MonitorRule): MonitorRule {
  return { ...rule, brandId: rule.brandId ?? "brand_default" };
}

export class PostgresMonitorRepository implements MonitorRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, brandId?: string): Promise<MonitorRule[]> {
    const rows = brandId
      ? await this.sql<RuleRow[]>`select payload from monitor_rules where workspace_id = ${workspaceId} and brand_id = ${brandId} order by updated_at desc`
      : await this.sql<RuleRow[]>`select payload from monitor_rules where workspace_id = ${workspaceId} order by updated_at desc`;
    return rows.map((row) => hydrateRule(row.payload));
  }

  async listEnabled(): Promise<MonitorRule[]> {
    const rows = await this.sql<RuleRow[]>`select payload from monitor_rules where enabled = true order by updated_at desc`;
    return rows.map((row) => hydrateRule(row.payload));
  }

  async get(workspaceId: string, id: string): Promise<MonitorRule | null> {
    const rows = await this.sql<RuleRow[]>`select payload from monitor_rules where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0]?.payload ? hydrateRule(rows[0].payload) : null;
  }

  async save(rule: MonitorRule): Promise<void> {
    await this.sql`
      insert into monitor_rules (id, workspace_id, brand_id, name, query, interval_minutes, enabled, next_run_at, created_at, updated_at, payload)
      values (${rule.id}, ${rule.workspaceId}, ${rule.brandId}, ${rule.name}, ${rule.query}, ${rule.intervalMinutes}, ${rule.enabled},
        ${rule.enabled ? new Date(Date.now() + rule.intervalMinutes * 60_000).toISOString() : null}, ${rule.createdAt}, ${rule.updatedAt}, ${this.sql.json(rule as never)})
      on conflict (id) do update set brand_id = excluded.brand_id, name = excluded.name, query = excluded.query, interval_minutes = excluded.interval_minutes,
        enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at, payload = excluded.payload
      where monitor_rules.workspace_id = excluded.workspace_id
    `;
  }

  async startRun(run: MonitorRun): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`insert into monitor_runs (id, workspace_id, monitor_id, status, content_item_id, started_at, completed_at, payload)
      values (${run.id}, ${run.workspaceId}, ${run.monitorId}, ${run.status}, ${run.contentItemId ?? null}, ${run.startedAt}, ${run.completedAt ?? null}, ${this.sql.json(run as never)})
      on conflict do nothing returning id`;
    return rows.length === 1;
  }

  async recordSkipped(run: MonitorRun): Promise<void> {
    if (run.status !== "skipped") throw new Error("Only skipped monitor runs can be recorded through this method.");
    await this.sql`insert into monitor_runs (id, workspace_id, monitor_id, status, content_item_id, started_at, completed_at, payload)
      values (${run.id}, ${run.workspaceId}, ${run.monitorId}, ${run.status}, ${run.contentItemId ?? null}, ${run.startedAt}, ${run.completedAt ?? null}, ${this.sql.json(run as never)})`;
  }

  async finishRun(run: MonitorRun, fingerprints: MonitorFingerprint[]): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`update monitor_runs set status = ${run.status}, content_item_id = ${run.contentItemId ?? null}, completed_at = ${run.completedAt ?? null}, payload = ${sql.json(run as never)} where id = ${run.id} and workspace_id = ${run.workspaceId}`;
      for (const entry of fingerprints) {
        await sql`insert into monitor_fingerprints (workspace_id, monitor_id, fingerprint, source_url, content_item_id, first_seen_at)
          values (${entry.workspaceId}, ${entry.monitorId}, ${entry.fingerprint}, ${entry.sourceUrl}, ${entry.contentItemId}, ${entry.firstSeenAt}) on conflict do nothing`;
      }
    });
  }

  async recordFingerprints(fingerprints: MonitorFingerprint[]): Promise<void> {
    await this.sql.begin(async (sql) => {
      for (const entry of fingerprints) {
        await sql`insert into monitor_fingerprints (workspace_id, monitor_id, fingerprint, source_url, content_item_id, first_seen_at)
          values (${entry.workspaceId}, ${entry.monitorId}, ${entry.fingerprint}, ${entry.sourceUrl}, ${entry.contentItemId}, ${entry.firstSeenAt}) on conflict do nothing`;
      }
    });
  }

  async listRuns(workspaceId: string, monitorId: string, limit = 20): Promise<MonitorRun[]> {
    const rows = await this.sql<RunRow[]>`select payload from monitor_runs where workspace_id = ${workspaceId} and monitor_id = ${monitorId} order by started_at desc limit ${limit}`;
    return rows.map((row) => hydrateRun(row.payload));
  }

  async hasFingerprint(workspaceId: string, monitorId: string, fingerprint: string): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`select exists(select 1 from monitor_fingerprints where workspace_id = ${workspaceId} and monitor_id = ${monitorId} and fingerprint = ${fingerprint}) as exists`;
    return rows[0]?.exists ?? false;
  }
}
