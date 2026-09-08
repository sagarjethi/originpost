import type { ProviderPublishOperation, ProviderPublishOperationRepository } from "@originpost/domain";
import type { Sql } from "postgres";

type Row = { payload: ProviderPublishOperation; claim_owner: string | null; claim_expires_at: Date | string | null };

function hydrate(row: Row): ProviderPublishOperation {
  return {
    ...row.payload,
    ...(row.claim_owner ? { claimOwner: row.claim_owner } : { claimOwner: undefined }),
    ...(row.claim_expires_at ? { claimExpiresAt: new Date(row.claim_expires_at).toISOString() } : { claimExpiresAt: undefined }),
  };
}

export class PostgresProviderPublishOperationRepository implements ProviderPublishOperationRepository {
  constructor(private readonly sql: Sql) {}
  async get(workspaceId: string, targetId: string): Promise<ProviderPublishOperation | null> {
    const rows = await this.sql<Row[]>`select payload, claim_owner, claim_expires_at from provider_publish_operations where workspace_id = ${workspaceId} and target_id = ${targetId} limit 1`;
    return rows[0] ? hydrate(rows[0]) : null;
  }
  async listByStatus(workspaceId: string, statuses: ProviderPublishOperation["status"][]): Promise<ProviderPublishOperation[]> {
    if (!statuses.length) return [];
    const rows = await this.sql<Row[]>`select payload, claim_owner, claim_expires_at from provider_publish_operations where workspace_id = ${workspaceId} and status = any(${statuses}) order by updated_at desc`;
    return rows.map(hydrate);
  }
  async save(value: ProviderPublishOperation): Promise<void> {
    await this.sql`insert into provider_publish_operations (id, workspace_id, content_item_id, target_id, attempt_id, platform, status, container_id, external_post_id, live_url, last_error, claim_owner, claim_expires_at, created_at, updated_at, payload)
      values (${value.id}, ${value.workspaceId}, ${value.contentItemId}, ${value.targetId}, ${value.attemptId}, ${value.platform}, ${value.status}, ${value.containerId}, ${value.externalPostId ?? null}, ${value.liveUrl ?? null}, ${value.lastError ?? null}, ${value.claimOwner ?? null}, ${value.claimExpiresAt ?? null}, ${value.createdAt}, ${value.updatedAt}, ${this.sql.json(value as never)})
      on conflict (workspace_id, target_id) do update set attempt_id = excluded.attempt_id, status = excluded.status, container_id = excluded.container_id, external_post_id = excluded.external_post_id, live_url = excluded.live_url, last_error = excluded.last_error, claim_owner = excluded.claim_owner, claim_expires_at = excluded.claim_expires_at, updated_at = excluded.updated_at, payload = excluded.payload`;
  }

  async claimExecution(value: ProviderPublishOperation, owner: string, leaseSeconds = 900): Promise<{ claimed: boolean; created: boolean; operation: ProviderPublishOperation }> {
    return this.sql.begin(async (sql) => {
      const inserted = await sql<Row[]>`
        insert into provider_publish_operations (
          id, workspace_id, content_item_id, target_id, attempt_id, platform, status, container_id,
          external_post_id, live_url, last_error, claim_owner, claim_expires_at, created_at, updated_at, payload
        ) values (
          ${value.id}, ${value.workspaceId}, ${value.contentItemId}, ${value.targetId}, ${value.attemptId}, ${value.platform}, ${value.status}, ${value.containerId},
          ${value.externalPostId ?? null}, ${value.liveUrl ?? null}, ${value.lastError ?? null}, ${owner}, clock_timestamp() + (${leaseSeconds} * interval '1 second'),
          ${value.createdAt}, ${value.updatedAt}, ${sql.json(value as never)}
        ) on conflict do nothing
        returning payload, claim_owner, claim_expires_at
      `;
      if (inserted[0]) return { claimed: true, created: true, operation: hydrate(inserted[0]) };

      const claimed = await sql<Row[]>`
        update provider_publish_operations
        set claim_owner = ${owner}, claim_expires_at = clock_timestamp() + (${leaseSeconds} * interval '1 second')
        where workspace_id = ${value.workspaceId} and target_id = ${value.targetId}
          and (claim_owner is null or claim_expires_at is null or claim_expires_at <= clock_timestamp())
        returning payload, claim_owner, claim_expires_at
      `;
      if (claimed[0]) return { claimed: true, created: false, operation: hydrate(claimed[0]) };
      const existing = await sql<Row[]>`select payload, claim_owner, claim_expires_at from provider_publish_operations where workspace_id = ${value.workspaceId} and target_id = ${value.targetId} limit 1`;
      if (!existing[0]) throw new Error("Provider publication claim disappeared while it was being acquired.");
      return { claimed: false, created: false, operation: hydrate(existing[0]) };
    });
  }

  async saveClaimed(value: ProviderPublishOperation, owner: string, leaseSeconds = 900): Promise<boolean> {
    const saved = await this.sql<{ id: string }[]>`
      update provider_publish_operations set
        attempt_id = ${value.attemptId}, status = ${value.status}, container_id = ${value.containerId},
        external_post_id = ${value.externalPostId ?? null}, live_url = ${value.liveUrl ?? null}, last_error = ${value.lastError ?? null},
        claim_expires_at = clock_timestamp() + (${leaseSeconds} * interval '1 second'), updated_at = ${value.updatedAt}, payload = ${this.sql.json(value as never)}
      where workspace_id = ${value.workspaceId} and target_id = ${value.targetId}
        and claim_owner = ${owner} and claim_expires_at > clock_timestamp()
      returning id
    `;
    return saved.length === 1;
  }
}
