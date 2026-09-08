import type { OperationalCheckId, OperationalIncident, OperationalIncidentRepository, OperationalIncidentStatus } from "@originpost/domain";
import type { Sql } from "postgres";

type Row = {
  workspace_id: string;
  check_id: OperationalCheckId;
  status: OperationalIncidentStatus;
  fingerprint: string;
  opened_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
};

function hydrate(row: Row): OperationalIncident {
  return {
    workspaceId: row.workspace_id,
    checkId: row.check_id,
    status: row.status,
    fingerprint: row.fingerprint,
    openedAt: row.opened_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
  };
}

export class PostgresOperationalIncidentRepository implements OperationalIncidentRepository {
  constructor(private readonly sql: Sql) {}

  async observe(input: {
    workspaceId: string;
    checkId: OperationalCheckId;
    status?: OperationalIncidentStatus | undefined;
    fingerprint?: string | undefined;
    observedAt: string;
  }) {
    return this.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.checkId}`}, 0))`;
      const rows = await sql<Row[]>`select * from workspace_operational_incidents where workspace_id = ${input.workspaceId} and check_id = ${input.checkId} limit 1 for update`;
      const current = rows[0];
      if (!input.status || !input.fingerprint) {
        if (!current || current.resolved_at) return { transition: "already_resolved" as const, incident: current ? hydrate(current) : null };
        const resolved = await sql<Row[]>`update workspace_operational_incidents set last_seen_at = ${input.observedAt}, resolved_at = ${input.observedAt} where workspace_id = ${input.workspaceId} and check_id = ${input.checkId} returning *`;
        return { transition: "resolved" as const, incident: hydrate(resolved[0]!) };
      }
      if (!current || current.resolved_at) {
        const opened = await sql<Row[]>`
          insert into workspace_operational_incidents (workspace_id, check_id, status, fingerprint, opened_at, last_seen_at, resolved_at)
          values (${input.workspaceId}, ${input.checkId}, ${input.status}, ${input.fingerprint}, ${input.observedAt}, ${input.observedAt}, null)
          on conflict (workspace_id, check_id) do update set status = excluded.status, fingerprint = excluded.fingerprint,
            opened_at = excluded.opened_at, last_seen_at = excluded.last_seen_at, resolved_at = null
          returning *
        `;
        return { transition: "opened" as const, incident: hydrate(opened[0]!) };
      }
      const changed = current.status !== input.status || current.fingerprint !== input.fingerprint;
      const updated = await sql<Row[]>`update workspace_operational_incidents set status = ${input.status}, fingerprint = ${input.fingerprint}, last_seen_at = ${input.observedAt} where workspace_id = ${input.workspaceId} and check_id = ${input.checkId} returning *`;
      return { transition: changed ? "changed" as const : "unchanged" as const, incident: hydrate(updated[0]!) };
    });
  }
}
