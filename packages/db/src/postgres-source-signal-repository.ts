import type { SourceSignal, SourceSignalRepository, SourceSignalState, SourceSignalListQuery } from "@originpost/domain";
import type { Sql } from "postgres";

type Row = { payload: SourceSignal };

function updatedSignal(existing: SourceSignal, incoming: SourceSignal): SourceSignal {
  return {
    ...incoming,
    id: existing.id,
    version: existing.version + 1,
    state: existing.state,
    occurrenceCount: existing.occurrenceCount + 1,
    firstSeenAt: existing.firstSeenAt,
    ...(existing.contentItemId ? { contentItemId: existing.contentItemId, savedBy: existing.savedBy, savedAt: existing.savedAt } : {}),
    ...(existing.dismissedBy ? { dismissedBy: existing.dismissedBy, dismissedAt: existing.dismissedAt, dismissReason: existing.dismissReason } : {}),
    ...(existing.state === "saving" ? { pendingContentItemId: existing.pendingContentItemId, saveClaimId: existing.saveClaimId, saveLeaseExpiresAt: existing.saveLeaseExpiresAt } : {}),
  };
}

export class PostgresSourceSignalRepository implements SourceSignalRepository {
  constructor(private readonly sql: Sql) {}

  async ingest(signals: SourceSignal[]) {
    return this.sql.begin(async (sql) => {
      let newCount = 0; let updatedCount = 0; const stored: SourceSignal[] = [];
      for (const signal of signals) {
        const rows = await sql<Row[]>`select payload from source_signals where workspace_id = ${signal.workspaceId} and monitor_id = ${signal.monitorId} and event_fingerprint = ${signal.eventFingerprint} for update`;
        const existing = rows[0]?.payload;
        if (!existing) {
          await sql`insert into source_signals (id,workspace_id,brand_id,monitor_id,monitor_run_id,version,state,urgency,score,event_fingerprint,title,first_seen_at,last_seen_at,occurrence_count,content_item_id,pending_content_item_id,save_claim_id,save_lease_expires_at,payload)
            values (${signal.id},${signal.workspaceId},${signal.brandId},${signal.monitorId},${signal.monitorRunId},${signal.version},${signal.state},${signal.urgency},${signal.score},${signal.eventFingerprint},${signal.title},${signal.firstSeenAt},${signal.lastSeenAt},${signal.occurrenceCount},${signal.contentItemId ?? null},${signal.pendingContentItemId ?? null},${signal.saveClaimId ?? null},${signal.saveLeaseExpiresAt ?? null},${sql.json(signal as never)})`;
          stored.push(structuredClone(signal)); newCount += 1; continue;
        }
        const next = updatedSignal(existing, signal);
        await sql`update source_signals set monitor_run_id=${next.monitorRunId}, version=${next.version}, state=${next.state}, urgency=${next.urgency}, score=${next.score}, title=${next.title}, last_seen_at=${next.lastSeenAt}, occurrence_count=${next.occurrenceCount}, content_item_id=${next.contentItemId ?? null}, pending_content_item_id=${next.pendingContentItemId ?? null}, save_claim_id=${next.saveClaimId ?? null}, save_lease_expires_at=${next.saveLeaseExpiresAt ?? null}, payload=${sql.json(next as never)} where id=${existing.id} and workspace_id=${existing.workspaceId}`;
        stored.push(next); updatedCount += 1;
      }
      return { signals: stored, newCount, updatedCount };
    });
  }

  async list(input: SourceSignalListQuery): Promise<SourceSignal[]> {
    const limit = Math.max(1, Math.min(200, input.limit ?? 100)); const search = input.search?.trim() ? `%${input.search.trim()}%` : undefined;
    const rows = await this.sql<Row[]>`select payload from source_signals where workspace_id=${input.workspaceId}
      and (${input.brandId ?? null}::text is null or brand_id=${input.brandId ?? null})
      and (${input.state ?? null}::text is null or state=${input.state ?? null})
      and (${input.monitorId ?? null}::text is null or monitor_id=${input.monitorId ?? null})
      and (${search ?? null}::text is null or title ilike ${search ?? null} or payload::text ilike ${search ?? null})
      and (${input.publishedAfter ?? null}::text is null or payload->>'publishedAt' >= ${input.publishedAfter ?? null})
      and (${input.publishedBefore ?? null}::text is null or payload->>'publishedAt' is null or payload->>'publishedAt' <= ${input.publishedBefore ?? null})
      order by case when ${input.sort ?? "priority"}='newest' then payload->>'publishedAt' end desc nulls last,
      case when ${input.sort ?? "priority"}='discovered' then first_seen_at end desc nulls last,
      case when ${input.sort ?? "priority"}='priority' then score end desc nulls last, first_seen_at desc,id asc limit ${limit} offset ${input.offset ?? 0}`;
    return rows.map((row) => row.payload);
  }

  async get(workspaceId: string, id: string): Promise<SourceSignal | null> { const rows = await this.sql<Row[]>`select payload from source_signals where workspace_id=${workspaceId} and id=${id} limit 1`; return rows[0]?.payload ?? null; }

  async claimSave(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; claimId: string; leaseExpiresAt: string; contentItemId: string }): Promise<SourceSignal | null> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<Row[]>`select payload from source_signals where workspace_id=${input.workspaceId} and id=${input.id} and version=${input.expectedVersion} for update`;
      const current = rows[0]?.payload; if (!current) return null;
      if (current.state !== "new" && current.state !== "saving") return null;
      const next: SourceSignal = { ...current, version: current.version + 1, state: "saving", pendingContentItemId: input.contentItemId, saveClaimId: input.claimId, saveLeaseExpiresAt: input.leaseExpiresAt };
      const changed = await sql<{ id: string }[]>`update source_signals set version=${next.version},state='saving',content_item_id=null,pending_content_item_id=${input.contentItemId},save_claim_id=${input.claimId},save_lease_expires_at=${input.leaseExpiresAt},payload=${sql.json(next as never)} where workspace_id=${input.workspaceId} and id=${input.id} and version=${input.expectedVersion} and (state='new' or (state='saving' and save_lease_expires_at <= clock_timestamp())) returning id`;
      return changed[0] ? next : null;
    });
  }

  async finishSave(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; claimId: string; contentItemId: string }): Promise<SourceSignal | null> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<Row[]>`select payload from source_signals where workspace_id=${input.workspaceId} and id=${input.id} and version=${input.expectedVersion} for update`;
      const current = rows[0]?.payload; if (!current || current.state !== "saving" || current.saveClaimId !== input.claimId || current.pendingContentItemId !== input.contentItemId) return null;
      const next: SourceSignal = { ...current, version: current.version + 1, state: "saved", contentItemId: input.contentItemId, savedBy: input.actorId, savedAt: input.at };
      delete next.pendingContentItemId; delete next.saveClaimId; delete next.saveLeaseExpiresAt;
      const changed = await sql<{ id: string }[]>`update source_signals set version=${next.version},state='saved',content_item_id=${input.contentItemId},pending_content_item_id=null,save_claim_id=null,save_lease_expires_at=null,payload=${sql.json(next as never)} where workspace_id=${input.workspaceId} and id=${input.id} and version=${input.expectedVersion} and state='saving' and save_claim_id=${input.claimId} and pending_content_item_id=${input.contentItemId} returning id`;
      return changed[0] ? next : null;
    });
  }

  async triage(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; action: "dismissed" | "restored"; reason?: string }): Promise<SourceSignal | null> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<Row[]>`select payload from source_signals where workspace_id=${input.workspaceId} and id=${input.id} and version=${input.expectedVersion} for update`;
      const current = rows[0]?.payload; if (!current) return null;
      let next: SourceSignal;
      if (input.action === "dismissed") { if (current.state !== "new") return null; next = { ...current, version: current.version + 1, state: "dismissed", dismissedBy: input.actorId, dismissedAt: input.at, ...(input.reason?.trim() ? { dismissReason: input.reason.trim().slice(0, 300) } : {}) }; }
      else { if (current.state !== "dismissed") return null; next = { ...current, version: current.version + 1, state: "new" }; delete next.dismissedBy; delete next.dismissedAt; delete next.dismissReason; }
      const changed = await sql<{ id: string }[]>`update source_signals set version=${next.version},state=${next.state},payload=${sql.json(next as never)} where workspace_id=${input.workspaceId} and id=${input.id} and version=${input.expectedVersion} returning id`;
      return changed[0] ? next : null;
    });
  }

  async summary(workspaceId: string, brandId?: string) {
    const rows = await this.sql<{ state: SourceSignalState; urgency: string; count: number }[]>`select state,urgency,count(*)::int as count from source_signals where workspace_id=${workspaceId} and (${brandId ?? null}::text is null or brand_id=${brandId ?? null}) group by state,urgency`;
    const count = (state: SourceSignalState) => rows.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0);
    return { new: count("new"), saving: count("saving"), saved: count("saved"), dismissed: count("dismissed"), highUrgency: rows.filter((row) => row.state === "new" && row.urgency === "high").reduce((sum, row) => sum + row.count, 0) };
  }
}
