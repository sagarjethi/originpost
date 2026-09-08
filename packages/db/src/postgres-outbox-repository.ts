import type { CredentialRefreshPlatform, OutboxMessage, OutboxRepository, OutboxStats, OutboxStatus, OutboxTopic, ProviderGrantProvider } from "@originpost/domain";
import type { Sql } from "postgres";

type OutboxRow = {
  id: string;
  workspace_id: string;
  topic: OutboxTopic;
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  available_at: Date;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  processed_at: Date | null;
  created_at: Date;
};

function mapRow(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    topic: row.topic,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    status: row.status,
    availableAt: row.available_at.toISOString(),
    attempts: row.attempts,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.toISOString() } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.processed_at ? { processedAt: row.processed_at.toISOString() } : {}),
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: Sql) {}

  async claimAvailable(owner: string, limit = 25, leaseSeconds = 60): Promise<OutboxMessage[]> {
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const rows = await this.sql<OutboxRow[]>`
      with claimable as (
        select id
        from outbox_events
        where available_at <= now()
          and (status = 'pending' or (status = 'processing' and lease_expires_at < now()))
        order by available_at asc, created_at asc
        for update skip locked
        limit ${limit}
      )
      update outbox_events as event
      set status = 'processing', attempts = event.attempts + 1, lease_owner = ${owner},
          lease_expires_at = ${leaseExpiresAt}, updated_at = now()
      from claimable
      where event.id = claimable.id
      returning event.*
    `;
    return rows.map(mapRow);
  }

  async complete(workspaceId: string, id: string): Promise<void> {
    await this.sql`update outbox_events set status = 'processed', processed_at = now(), lease_owner = null, lease_expires_at = null, last_error = null, updated_at = now() where workspace_id = ${workspaceId} and id = ${id}`;
  }

  async fail(workspaceId: string, id: string, error: string, retryAt: string, maxAttempts = 10): Promise<void> {
    await this.sql`
      update outbox_events
      set status = case when attempts >= ${maxAttempts} then 'failed' else 'pending' end,
          available_at = ${retryAt}, lease_owner = null, lease_expires_at = null,
          last_error = ${error.slice(0, 500)}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}
    `;
  }

  async recoverPublishTargets(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id, workspace_id, topic, dedupe_key, payload, available_at, created_at)
      select
        'outbox_recovery_' || md5(target.workspace_id || ':' || target.id),
        target.workspace_id,
        'publish.target.requested',
        'publish-target:' || target.id,
        jsonb_build_object(
          'workspaceId', target.workspace_id,
          'contentItemId', target.content_item_id,
          'targetId', target.id,
          'recoveryKey', md5(target.id || ':' || clock_timestamp()::text || ':' || random()::text)
        ),
        target.scheduled_for,
        now()
      from publish_targets as target
      where target.status in ('queued', 'publishing')
      on conflict (workspace_id, dedupe_key) do update set
        status = 'pending',
        payload = excluded.payload,
        available_at = least(excluded.available_at, now()),
        attempts = 0,
        lease_owner = null,
        lease_expires_at = null,
        last_error = null,
        processed_at = null,
        updated_at = now()
      where outbox_events.status in ('processed', 'failed')
      returning id
    `;
    return rows.length;
  }

  async recoverRemoteCorrections(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id, workspace_id, topic, dedupe_key, payload, available_at, created_at)
      select 'outbox_correction_' || md5(operation.workspace_id || ':' || operation.id), operation.workspace_id,
        'remote-correction.requested', 'remote-correction:' || operation.id,
        jsonb_build_object('workspaceId',operation.workspace_id,'contentItemId',operation.content_item_id,'operationId',operation.id,'mode',case when operation.status in ('finalizing','uncertain') then 'reconcile' else 'execute' end), now(), now()
      from remote_correction_operations operation
      where operation.status in ('approved','pre_write','finalizing','uncertain')
      on conflict (workspace_id,dedupe_key) do update set status='pending',available_at=now(),attempts=0,lease_owner=null,lease_expires_at=null,last_error=null,processed_at=null,updated_at=now()
      where outbox_events.status in ('processed','failed')
      returning id`;
    return rows.length;
  }

  async recoverAgentBoardPlugins(): Promise<number> {
    const reconcileRows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id,workspace_id,topic,dedupe_key,payload,available_at,created_at)
      select 'outbox_board_' || md5(plugin.workspace_id || ':' || plugin.board_id || ':' || plugin.desired_configuration_epoch::text),
        plugin.workspace_id,
        'board.plugin.reconcile',
        'board-plugin:' || plugin.board_id || ':epoch:' || plugin.desired_configuration_epoch::text,
        jsonb_build_object('workspaceId',plugin.workspace_id,'brandId',plugin.brand_id,'boardId',plugin.board_id,'configurationEpoch',plugin.desired_configuration_epoch),
        now(),now()
      from board_hermes_plugins plugin
      join agent_boards board on board.id=plugin.board_id and board.workspace_id=plugin.workspace_id and board.brand_id=plugin.brand_id
      where board.status<>'archived' and (plugin.state in ('provisioning','attention') or plugin.observed_configuration_epoch<plugin.desired_configuration_epoch)
      on conflict(workspace_id,dedupe_key) do update set status='pending',available_at=now(),attempts=0,lease_owner=null,lease_expires_at=null,last_error=null,processed_at=null,updated_at=now()
      where outbox_events.status in ('processed','failed')
      returning id`;
    const deactivateRows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id,workspace_id,topic,dedupe_key,payload,available_at,created_at)
      select 'outbox_board_deactivate_' || md5(plugin.workspace_id || ':' || plugin.board_id || ':' || plugin.capability_epoch::text),
        plugin.workspace_id,
        'board.plugin.deactivate',
        'board-plugin:' || plugin.board_id || ':deactivate:epoch:' || plugin.desired_configuration_epoch::text,
        jsonb_build_object('workspaceId',plugin.workspace_id,'brandId',plugin.brand_id,'boardId',plugin.board_id,'configurationEpoch',plugin.desired_configuration_epoch,'capabilityEpoch',plugin.capability_epoch),
        now(),now()
      from board_hermes_plugins plugin
      join agent_boards board on board.id=plugin.board_id and board.workspace_id=plugin.workspace_id and board.brand_id=plugin.brand_id
      where board.status='archived' and not (board.payload ? 'runtimeDeactivatedAt')
      on conflict(workspace_id,dedupe_key) do update set status='pending',available_at=now(),attempts=0,lease_owner=null,lease_expires_at=null,last_error=null,processed_at=null,updated_at=now()
      where outbox_events.status in ('processed','failed')
      returning id`;
    return reconcileRows.length + deactivateRows.length;
  }

  async recoverCredentialRefreshes(platforms: CredentialRefreshPlatform[]): Promise<number> {
    if (platforms.length === 0) return 0;
    const includeInstagram = platforms.includes("instagram");
    const includeYouTube = platforms.includes("youtube");
    const rows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id, workspace_id, topic, dedupe_key, payload, available_at, created_at)
      select
        'outbox_credential_refresh_' || md5(account.workspace_id || ':' || account.id || ':' || account.expires_at::text),
        account.workspace_id,
        'channel.credential-refresh',
        'credential-refresh:' || account.id || ':expires:' || extract(epoch from account.expires_at)::bigint::text,
        jsonb_build_object(
          'workspaceId', account.workspace_id,
          'accountId', account.id,
          'platform', account.platform,
          'expectedExpiresAt', to_char(account.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'expectedCredentialRef', account.credential_ref
        ),
        now(),
        now()
      from connected_accounts account
      where account.status in ('healthy', 'expiring')
        and account.credential_ref like 'secret:%'
        and account.expires_at is not null
        and (
          (${includeYouTube} and account.platform = 'youtube' and account.expires_at <= now() + interval '15 minutes')
          or (${includeInstagram} and account.platform = 'instagram' and account.expires_at <= now() + interval '7 days'
            and nullif(account.payload->>'lastHealthyAt', '')::timestamptz <= now() - interval '24 hours')
        )
      on conflict (workspace_id, dedupe_key) do nothing
      returning id
    `;
    return rows.length;
  }

  async recoverProviderGrantValidations(providers: ProviderGrantProvider[]): Promise<number> {
    if (!providers.length) return 0;
    const rows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id, workspace_id, topic, dedupe_key, payload, available_at, created_at)
      select
        'outbox_provider_validation_' || md5(provider_grant.workspace_id || ':' || provider_grant.id || ':' || provider_grant.version::text),
        provider_grant.workspace_id,
        'provider.grant-validation',
        'provider-grant-validation:' || provider_grant.id || ':version:' || provider_grant.version::text,
        jsonb_build_object('workspaceId', provider_grant.workspace_id, 'grantId', provider_grant.id, 'expectedVersion', provider_grant.version),
        now(), now()
      from provider_grants provider_grant
      where provider_grant.provider = any(${providers}::text[])
        and provider_grant.status in ('active','expiring','refresh_failed')
        and provider_grant.next_validation_at is not null and provider_grant.next_validation_at <= now()
        and exists (
          select 1 from provider_grant_accounts link
          join connected_accounts account on account.workspace_id = link.workspace_id and account.id = link.account_id
          where link.workspace_id = provider_grant.workspace_id and link.provider_grant_id = provider_grant.id
            and link.unlinked_at is null and account.credential_ref like 'secret:%'
        )
      on conflict (workspace_id, dedupe_key) do update set
        status = 'pending', available_at = now(), attempts = 0, lease_owner = null,
        lease_expires_at = null, last_error = null, processed_at = null, updated_at = now()
      where outbox_events.status = 'failed'
      returning id
    `;
    return rows.length;
  }

  async recoverProviderDataDeletions(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      insert into outbox_events (id, workspace_id, topic, dedupe_key, payload, available_at, created_at)
      select
        'outbox_provider_deletion_' || md5(scope.request_id || ':' || scope.workspace_id),
        scope.workspace_id,
        'provider.data-deletion',
        'provider-data-deletion:' || scope.request_id || ':' || scope.workspace_id,
        jsonb_build_object('workspaceId', scope.workspace_id, 'deletionRequestId', scope.request_id),
        now(),
        now()
      from provider_data_deletion_scopes scope
      where scope.status in ('pending', 'processing')
      on conflict (workspace_id, dedupe_key) do update
        set status = 'pending', available_at = now(), attempts = 0, lease_owner = null,
          lease_expires_at = null, last_error = null, processed_at = null, updated_at = now()
      where outbox_events.status in ('processed', 'failed')
      returning id
    `;
    return rows.length;
  }

  async stats(workspaceId?: string): Promise<OutboxStats> {
    const rows = workspaceId
      ? await this.sql<{ status: OutboxStatus; count: number; oldest_pending_at: Date | null }[]>`
          select status, count(*)::int as count,
            min(available_at) filter (where status = 'pending') as oldest_pending_at
          from outbox_events where workspace_id = ${workspaceId} group by status`
      : await this.sql<{ status: OutboxStatus; count: number; oldest_pending_at: Date | null }[]>`
          select status, count(*)::int as count,
            min(available_at) filter (where status = 'pending') as oldest_pending_at
          from outbox_events group by status`;
    const count = (status: OutboxStatus) => rows.find((row) => row.status === status)?.count ?? 0;
    const oldest = rows.find((row) => row.oldest_pending_at)?.oldest_pending_at;
    return { pending: count("pending"), processing: count("processing"), processed: count("processed"), failed: count("failed"), ...(oldest ? { oldestPendingAt: oldest.toISOString() } : {}) };
  }

  async list(workspaceId: string, status?: OutboxStatus, limit = 50): Promise<OutboxMessage[]> {
    const rows = status
      ? await this.sql<OutboxRow[]>`select * from outbox_events where workspace_id = ${workspaceId} and status = ${status} order by created_at desc limit ${limit}`
      : await this.sql<OutboxRow[]>`select * from outbox_events where workspace_id = ${workspaceId} order by created_at desc limit ${limit}`;
    return rows.map(mapRow);
  }

  async retry(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update outbox_events set status = 'pending', attempts = 0, available_at = now(),
        lease_owner = null, lease_expires_at = null, last_error = null, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id} and status = 'failed'
      returning id
    `;
    return rows.length === 1;
  }
}
