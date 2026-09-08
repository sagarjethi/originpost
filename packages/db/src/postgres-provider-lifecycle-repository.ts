import { createHash } from "node:crypto";
import type { ProviderDataDeletionRequest, ProviderGrant, ProviderLifecycleRepository } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type DeletionRow = {
  id: string;
  provider: "meta";
  client_id: string;
  lookup_key_version: string;
  subject_lookup_hmac: string;
  grant_generation_sha256: string;
  confirmation_nonce: string;
  confirmation_code_sha256: string;
  status: ProviderDataDeletionRequest["status"];
  scope_count: number;
  completed_scope_count: number;
  public_summary: string;
  requested_at: Date;
  completed_at: Date | null;
  updated_at: Date;
};

type GrantRow = { id: string; workspace_id: string; version: number; issued_at: Date };
type AccountRow = { id: string; workspace_id: string; credential_ref: string | null };

function deletion(row: DeletionRow): ProviderDataDeletionRequest {
  return {
    id: row.id,
    provider: row.provider,
    clientId: row.client_id,
    lookupKeyVersion: row.lookup_key_version,
    subjectLookupHmac: row.subject_lookup_hmac,
    grantGenerationSha256: row.grant_generation_sha256,
    confirmationNonce: row.confirmation_nonce,
    confirmationCodeSha256: row.confirmation_code_sha256,
    status: row.status,
    scopeCount: row.scope_count,
    completedScopeCount: row.completed_scope_count,
    publicSummary: row.public_summary,
    requestedAt: row.requested_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    updatedAt: row.updated_at.toISOString(),
  };
}

function accountCredentialId(ref: string | null): string | null {
  return ref?.startsWith("secret:") ? ref.slice(7) : null;
}

async function matchingGrants(sql: Sql | TransactionSql, clientId: string, lookupCandidates: Array<{ version: string; digest: string }>, includeDeleted = false): Promise<GrantRow[]> {
  return sql<GrantRow[]>`
    select id, workspace_id, version::int, issued_at
    from provider_grants
    where provider = 'meta' and client_id = ${clientId}
      and exists (
        select 1 from jsonb_to_recordset(${sql.json(lookupCandidates as never)}) as candidate(version text, digest text)
        where candidate.version = provider_grants.lookup_key_version and candidate.digest = provider_grants.subject_lookup_hmac
      )
      and status <> 'superseded'
      and (${includeDeleted} or status <> 'deleted')
    order by workspace_id, id
    for update
  `;
}

async function linkedAccounts(sql: Sql | TransactionSql, grants: GrantRow[]): Promise<AccountRow[]> {
  if (!grants.length) return [];
  const grantIds = grants.map((grant) => grant.id);
  return sql<AccountRow[]>`
    select account.id, account.workspace_id, account.credential_ref
    from provider_grant_accounts link
    join connected_accounts account on account.id = link.account_id and account.workspace_id = link.workspace_id
    where link.provider_grant_id = any(${grantIds}) and link.unlinked_at is null
    order by account.workspace_id, account.id
    for update of account
  `;
}

async function blockAccess(sql: Sql | TransactionSql, grants: GrantRow[], accounts: AccountRow[], event: "deauthorized" | "deletion_pending" | "reauthorization_required", at: string, errorCode?: string, errorSummary?: string): Promise<void> {
  const grantErrorCode = errorCode ?? (event === "deauthorized" ? "provider_deauthorized" : event === "deletion_pending" ? "provider_data_deletion" : "provider_validation_rejected");
  const grantErrorSummary = errorSummary ?? (event === "deauthorized" ? "The provider removed this authorization. Reconnect to restore access." : event === "deletion_pending" ? "Provider-derived data deletion is in progress." : "The provider no longer confirms this authorization. Reconnect to restore access.");
  const grantIds = grants.map((grant) => grant.id);
  if (grantIds.length) {
    await sql`
      update provider_grants set status = ${event}, version = version + 1,
        last_checked_at = ${at}, last_error_code = ${grantErrorCode},
        last_error_summary = ${grantErrorSummary},
        next_refresh_at = null, next_validation_at = null, updated_at = ${at}
      where id = any(${grantIds}) and status not in ('deleted', 'superseded')
    `;
  }
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length) {
    const payloadUpdate = {
      status: "disconnected",
      capabilities: [],
      lastCheckedAt: at,
      lastErrorCode: grantErrorCode,
      lastErrorStep: event === "deletion_pending" ? "Provider data deletion" : "Reconnect provider access",
      lastErrorSummary: grantErrorSummary,
      updatedAt: at,
    };
    await sql`
      update connected_accounts set credential_ref = null, status = 'disconnected', expires_at = null,
        last_checked_at = ${at}, updated_at = ${at},
        payload = (payload - 'credentialRef' - 'expiresAt' - 'lastHealthyAt') || ${sql.json(payloadUpdate as never)}
      where id = any(${accountIds})
    `;
    const credentialIds = accounts.map((account) => accountCredentialId(account.credential_ref)).filter((id): id is string => Boolean(id));
    if (credentialIds.length) await sql`delete from encrypted_credentials where id = any(${credentialIds})`;
  }
}

async function notifyAndAudit(sql: Sql | TransactionSql, grants: GrantRow[], event: "deauthorized" | "deletion_pending", at: string, requestId?: string): Promise<void> {
  const byWorkspace = new Map<string, string[]>();
  for (const grant of grants) byWorkspace.set(grant.workspace_id, [...(byWorkspace.get(grant.workspace_id) ?? []), grant.id]);
  for (const [workspaceId, grantIds] of byWorkspace) {
    const stable = createHash("sha256").update(`${event}:${workspaceId}:${grantIds.join(",")}:${requestId ?? ""}`).digest("hex");
    const actionUrl = grantIds.length === 1 ? `/?module=channels&grant=${encodeURIComponent(grantIds[0]!)}` : "/?module=channels";
    await sql`
      insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
      values (${`audit_provider_${stable.slice(0, 32)}`}, ${workspaceId}, null, 'originpost-provider-callback', 'system',
        ${event === "deauthorized" ? "provider-grant.deauthorized" : "provider-data-deletion.requested"},
        ${sql.json({ grantCount: grantIds.length, ...(requestId ? { deletionRequestId: requestId } : {}) } as never)}, ${at})
      on conflict (id) do nothing
    `;
    await sql`
      insert into workspace_notifications (id, workspace_id, kind, severity, title, body, action_url, dedupe_key, created_at)
      values (${`notification_provider_${stable.slice(0, 32)}`}, ${workspaceId}, 'connection_attention', 'warning',
        ${event === "deauthorized" ? "Provider access was removed" : "Provider data deletion started"},
        ${event === "deauthorized" ? "Publishing was blocked for every account linked to this provider authorization. Reconnect from Channels if access should be restored." : "Publishing was blocked and OriginPost started removing provider-derived data. Workspace-authored drafts and media are retained."},
        ${actionUrl}, ${`provider-lifecycle:${stable}`}, ${at})
      on conflict (workspace_id, dedupe_key) do nothing
    `;
  }
}

export class PostgresProviderLifecycleRepository implements ProviderLifecycleRepository {
  constructor(private readonly sql: Sql) {}

  async listProviderGrants(workspaceId: string, brandId?: string): Promise<Array<{ grant: ProviderGrant; accountIds: string[] }>> {
    const rows = await this.sql<Array<{ grant: ProviderGrant; account_ids: string[] }>>`
      select jsonb_build_object(
        'id', provider_grant.id, 'workspaceId', provider_grant.workspace_id, 'provider', provider_grant.provider,
        'authorizationKind', provider_grant.authorization_kind, 'clientId', provider_grant.client_id,
        'lookupKeyVersion', provider_grant.lookup_key_version, 'subjectLookupHmac', provider_grant.subject_lookup_hmac,
        'refreshTokenLookupHmac', provider_grant.refresh_token_lookup_hmac,
        'riscTokenPrefixLookupHmac', provider_grant.risc_token_prefix_lookup_hmac,
        'riscTokenDigestLookupHmac', provider_grant.risc_token_digest_lookup_hmac,
        'status', provider_grant.status, 'scopes', provider_grant.scopes, 'version', provider_grant.version,
        'issuedAt', to_char(provider_grant.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'accessExpiresAt', case when provider_grant.access_expires_at is null then null else to_char(provider_grant.access_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'dataAccessExpiresAt', case when provider_grant.data_access_expires_at is null then null else to_char(provider_grant.data_access_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'refreshTokenExpiresAt', case when provider_grant.refresh_token_expires_at is null then null else to_char(provider_grant.refresh_token_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'nextRefreshAt', case when provider_grant.next_refresh_at is null then null else to_char(provider_grant.next_refresh_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'nextValidationAt', case when provider_grant.next_validation_at is null then null else to_char(provider_grant.next_validation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'lastCheckedAt', case when provider_grant.last_checked_at is null then null else to_char(provider_grant.last_checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'lastHealthyAt', case when provider_grant.last_healthy_at is null then null else to_char(provider_grant.last_healthy_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'lastErrorCode', provider_grant.last_error_code, 'lastErrorSummary', provider_grant.last_error_summary,
        'createdBy', provider_grant.created_by,
        'createdAt', to_char(provider_grant.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', to_char(provider_grant.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) as grant,
      array_agg(link.account_id order by link.account_id) as account_ids
      from provider_grants provider_grant
      join provider_grant_accounts link on link.workspace_id = provider_grant.workspace_id and link.provider_grant_id = provider_grant.id and link.unlinked_at is null
      where provider_grant.workspace_id = ${workspaceId} and (${brandId ?? null}::text is null or link.brand_id = ${brandId ?? null})
      group by provider_grant.id
      order by provider_grant.updated_at desc, provider_grant.id
    `;
    return rows.map((row) => ({ grant: row.grant, accountIds: row.account_ids }));
  }

  async recordProviderGrantValidation(input: { workspaceId: string; grantId: string; expectedVersion: number; outcome: "healthy" | "transient_failure" | "review_required" | "reauthorization_required"; checkedAt: string; nextValidationAt?: string; errorCode?: string; errorSummary?: string }): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const grants = await sql<GrantRow[]>`
        select id, workspace_id, version::int, issued_at from provider_grants
        where workspace_id = ${input.workspaceId} and id = ${input.grantId}
          and version = ${input.expectedVersion} and status in ('active','expiring','refresh_failed')
        limit 1 for update
      `;
      const grant = grants[0];
      if (!grant) return false;
      if (input.outcome === "reauthorization_required") {
        const accounts = await linkedAccounts(sql, grants);
        await blockAccess(sql, grants, accounts, "reauthorization_required", input.checkedAt, input.errorCode, input.errorSummary);
        const stable = createHash("sha256").update(`${grant.id}:${grant.version}:blocked`).digest("hex");
        await sql`
          insert into workspace_notifications (id, workspace_id, kind, severity, title, body, action_url, dedupe_key, created_at)
          values (${`notification_provider_validation_${stable.slice(0, 24)}`}, ${input.workspaceId}, 'connection_attention', 'warning',
            'Provider access needs reconnection', 'Provider validation failed permanently. Publishing was blocked for every linked account.',
            ${`/?module=channels&grant=${encodeURIComponent(grant.id)}`}, ${`provider-validation:${grant.id}:${grant.version}:blocked`}, ${input.checkedAt})
          on conflict (workspace_id, dedupe_key) do nothing
        `;
      } else {
        await sql`
          update provider_grants set status = ${input.outcome === "healthy" ? "active" : "refresh_failed"}, version = version + 1,
            last_checked_at = ${input.checkedAt},
            last_healthy_at = case when ${input.outcome === "healthy"} then ${input.checkedAt} else last_healthy_at end,
            last_error_code = ${input.outcome === "healthy" ? null : input.errorCode ?? "provider_validation_unavailable"},
            last_error_summary = ${input.outcome === "healthy" ? null : input.errorSummary ?? "Provider validation is temporarily unavailable and will retry."},
            next_validation_at = ${input.nextValidationAt ?? null}, updated_at = ${input.checkedAt}
          where workspace_id = ${input.workspaceId} and id = ${input.grantId} and version = ${input.expectedVersion}
        `;
      }
      if (input.outcome === "review_required") {
        const stable = createHash("sha256").update(`${grant.id}:${grant.version}:review`).digest("hex");
        await sql`
          insert into workspace_notifications (id, workspace_id, kind, severity, title, body, action_url, dedupe_key, created_at)
          values (${`notification_provider_validation_${stable.slice(0, 24)}`}, ${input.workspaceId}, 'connection_attention', 'warning',
            'Provider access needs review', ${input.errorSummary ?? "OriginPost could not verify every account linked to this authorization. Review it in Channels."},
            ${`/?module=channels&grant=${encodeURIComponent(grant.id)}`}, ${`provider-validation:${grant.id}:${grant.version}:review`}, ${input.checkedAt})
          on conflict (workspace_id, dedupe_key) do nothing
        `;
      }
      const stable = createHash("sha256").update(`${grant.id}:${grant.version}:${input.outcome}`).digest("hex");
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${`audit_provider_validation_${stable.slice(0, 28)}`}, ${input.workspaceId}, null, 'originpost-provider-validator', 'system',
          ${`provider-grant.validation-${input.outcome.replaceAll("_", "-")}`},
          ${sql.json({ providerGrantId: grant.id, expectedVersion: grant.version, outcome: input.outcome } as never)}, ${input.checkedAt})
        on conflict (id) do nothing
      `;
      return true;
    });
  }

  async receiveMetaDeauthorization(input: { id: string; clientId: string; lookupKeyVersion: string; subjectLookupHmac: string; lookupCandidates: Array<{ version: string; digest: string }>; payloadSha256: string; receivedAt: string }): Promise<{ created: boolean; matchedGrants: number; affectedAccounts: number }> {
    return this.sql.begin(async (sql) => {
      const existing = await sql<{ matched_grants: number; affected_accounts: number }[]>`
        select matched_grants, affected_accounts from provider_lifecycle_receipts
        where provider = 'meta' and event_type = 'deauthorization' and client_id = ${input.clientId} and payload_sha256 = ${input.payloadSha256}
        limit 1 for update
      `;
      if (existing[0]) return { created: false, matchedGrants: existing[0].matched_grants, affectedAccounts: existing[0].affected_accounts };
      const grants = await matchingGrants(sql, input.clientId, input.lookupCandidates);
      const accounts = await linkedAccounts(sql, grants);
      await blockAccess(sql, grants, accounts, "deauthorized", input.receivedAt);
      await notifyAndAudit(sql, grants, "deauthorized", input.receivedAt);
      await sql`
        insert into provider_lifecycle_receipts (id, provider, event_type, client_id, lookup_key_version, subject_lookup_hmac, payload_sha256, status, matched_grants, affected_accounts, received_at, processed_at)
        values (${input.id}, 'meta', 'deauthorization', ${input.clientId}, ${input.lookupKeyVersion}, ${input.subjectLookupHmac}, ${input.payloadSha256}, 'processed', ${grants.length}, ${accounts.length}, ${input.receivedAt}, ${input.receivedAt})
      `;
      return { created: true, matchedGrants: grants.length, affectedAccounts: accounts.length };
    });
  }

  async receiveMetaDataDeletion(input: { receiptId: string; requestId: string; clientId: string; lookupKeyVersion: string; subjectLookupHmac: string; lookupCandidates: Array<{ version: string; digest: string }>; payloadSha256: string; confirmationNonce: string; confirmationCodeSha256: string; receivedAt: string }): Promise<{ created: boolean; matchedGrants: number; affectedAccounts: number; request: ProviderDataDeletionRequest }> {
    return this.sql.begin(async (sql) => {
      const exact = await sql<(DeletionRow & { matched_grants: number; affected_accounts: number })[]>`
        select request.*, receipt.matched_grants, receipt.affected_accounts
        from provider_lifecycle_receipts receipt
        join provider_data_deletion_requests request on request.id = receipt.deletion_request_id
        where receipt.provider = 'meta' and receipt.event_type = 'data_deletion'
          and receipt.client_id = ${input.clientId} and receipt.payload_sha256 = ${input.payloadSha256}
        limit 1 for update of receipt, request
      `;
      if (exact[0]) return { created: false, matchedGrants: exact[0].matched_grants, affectedAccounts: exact[0].affected_accounts, request: deletion(exact[0]) };

      const grants = await matchingGrants(sql, input.clientId, input.lookupCandidates, true);
      const accounts = await linkedAccounts(sql, grants);
      const generation = createHash("sha256").update(grants.length ? grants.map((grant) => `${grant.id}:${grant.issued_at.toISOString()}`).join("|") : `no-data:${input.clientId}:${input.lookupKeyVersion}:${input.subjectLookupHmac}`).digest("hex");
      const prior = await sql<DeletionRow[]>`
        select request.* from provider_data_deletion_requests request
        where request.provider = 'meta' and request.client_id = ${input.clientId}
          and request.grant_generation_sha256 = ${generation}
          and exists (
            select 1 from jsonb_to_recordset(${sql.json(input.lookupCandidates as never)}) as candidate(version text, digest text)
            where candidate.version = request.lookup_key_version and candidate.digest = request.subject_lookup_hmac
          )
        order by request.requested_at
        limit 1 for update
      `;
      const inserted = prior[0] ? [] : await sql<DeletionRow[]>`
          insert into provider_data_deletion_requests (id, provider, client_id, lookup_key_version, subject_lookup_hmac, grant_generation_sha256, confirmation_nonce, confirmation_code_sha256, status, scope_count, completed_scope_count, public_summary, requested_at, completed_at, updated_at)
          values (${input.requestId}, 'meta', ${input.clientId}, ${input.lookupKeyVersion}, ${input.subjectLookupHmac}, ${generation}, ${input.confirmationNonce}, ${input.confirmationCodeSha256},
            ${grants.length ? "pending" : "completed"}, ${new Set(grants.map((grant) => grant.workspace_id)).size}, 0,
            ${grants.length ? "OriginPost is removing provider-derived data. Workspace-authored drafts and media are retained." : "No matching OriginPost provider authorization or provider-derived data was found."},
            ${input.receivedAt}, ${grants.length ? null : input.receivedAt}, ${input.receivedAt})
          on conflict (provider, client_id, lookup_key_version, subject_lookup_hmac, grant_generation_sha256) do nothing
          returning *
        `;
      const requestRow = prior[0] ?? inserted[0] ?? (await sql<DeletionRow[]>`
        select * from provider_data_deletion_requests where provider = 'meta' and client_id = ${input.clientId}
          and lookup_key_version = ${input.lookupKeyVersion} and subject_lookup_hmac = ${input.subjectLookupHmac}
          and grant_generation_sha256 = ${generation} limit 1 for update
      `)[0];
      if (!requestRow) throw new Error("Provider data deletion request could not be persisted.");
      const created = Boolean(inserted[0]);

      if (created && grants.length) {
        const byWorkspace = new Map<string, string[]>();
        for (const grant of grants) byWorkspace.set(grant.workspace_id, [...(byWorkspace.get(grant.workspace_id) ?? []), grant.id]);
        for (const [workspaceId, grantIds] of byWorkspace) {
          await sql`insert into provider_data_deletion_scopes (request_id, workspace_id, grant_ids, status, created_at, updated_at) values (${requestRow.id}, ${workspaceId}, ${sql.json(grantIds as never)}, 'pending', ${input.receivedAt}, ${input.receivedAt})`;
          await sql`
            insert into outbox_events (id, workspace_id, topic, dedupe_key, payload, available_at, created_at)
            values (${`outbox_provider_deletion_${requestRow.id}_${workspaceId}`}, ${workspaceId}, 'provider.data-deletion', ${`provider-data-deletion:${requestRow.id}:${workspaceId}`},
              ${sql.json({ workspaceId, deletionRequestId: requestRow.id } as never)}, ${input.receivedAt}, ${input.receivedAt})
            on conflict (workspace_id, dedupe_key) do nothing
          `;
        }
        await blockAccess(sql, grants, accounts, "deletion_pending", input.receivedAt);
        await notifyAndAudit(sql, grants, "deletion_pending", input.receivedAt, requestRow.id);
      }
      await sql`
        insert into provider_lifecycle_receipts (id, provider, event_type, client_id, lookup_key_version, subject_lookup_hmac, payload_sha256, status, matched_grants, affected_accounts, deletion_request_id, received_at, processed_at)
        values (${input.receiptId}, 'meta', 'data_deletion', ${input.clientId}, ${input.lookupKeyVersion}, ${input.subjectLookupHmac}, ${input.payloadSha256}, 'processed', ${grants.length}, ${accounts.length}, ${requestRow.id}, ${input.receivedAt}, ${input.receivedAt})
        on conflict (provider, event_type, client_id, payload_sha256) do nothing
      `;
      return { created, matchedGrants: grants.length, affectedAccounts: accounts.length, request: deletion(requestRow) };
    });
  }

  async getDataDeletionByConfirmationSha256(confirmationCodeSha256: string): Promise<ProviderDataDeletionRequest | null> {
    const rows = await this.sql<DeletionRow[]>`select * from provider_data_deletion_requests where confirmation_code_sha256 = ${confirmationCodeSha256} limit 1`;
    return rows[0] ? deletion(rows[0]) : null;
  }

  async getDataDeletionScope(requestId: string, workspaceId: string): Promise<{ status: ProviderDataDeletionRequest["status"]; accountIds: string[]; hasPrivateData: boolean } | null> {
    const rows = await this.sql<{ status: ProviderDataDeletionRequest["status"]; account_ids: string[]; has_private_data: boolean }[]>`
      select scope.status, coalesce(array_agg(distinct link.account_id) filter (where link.account_id is not null), '{}') as account_ids,
        exists (
          select 1 from private_conversations conversation
          where conversation.workspace_id = scope.workspace_id
            and conversation.account_id in (
              select current_link.account_id from provider_grant_accounts current_link
              where current_link.workspace_id = scope.workspace_id
                and current_link.provider_grant_id in (select jsonb_array_elements_text(scope.grant_ids))
                and current_link.unlinked_at is null
            )
        ) as has_private_data
      from provider_data_deletion_scopes scope
      left join provider_grant_accounts link on link.workspace_id = scope.workspace_id and link.provider_grant_id in (select jsonb_array_elements_text(scope.grant_ids)) and link.unlinked_at is null
      where scope.request_id = ${requestId} and scope.workspace_id = ${workspaceId}
      group by scope.status, scope.workspace_id, scope.grant_ids
    `;
    return rows[0] ? { status: rows[0].status, accountIds: rows[0].account_ids, hasPrivateData: rows[0].has_private_data } : null;
  }

  async processDataDeletionScope(requestId: string, workspaceId: string, processedAt: string): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const scopeRows = await sql<{ status: string; grant_ids: string[] }[]>`select status, grant_ids from provider_data_deletion_scopes where request_id = ${requestId} and workspace_id = ${workspaceId} limit 1 for update`;
      const scope = scopeRows[0];
      if (!scope || scope.status === "completed") return false;
      const grantIds = scope.grant_ids;
      const accountRows = await sql<{ account_id: string }[]>`select distinct account_id from provider_grant_accounts where workspace_id = ${workspaceId} and provider_grant_id = any(${grantIds}) and unlinked_at is null`;
      const accountIds = accountRows.map((row) => row.account_id);
      if (accountIds.length) {
        await sql`delete from post_analytics_snapshots where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
        await sql`delete from provider_webhook_receipts where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
        await sql`delete from engagement_threads where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
        await sql`delete from instagram_collaborator_status_snapshots where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
        await sql`delete from instagram_collaborator_polls where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
        await sql`delete from instagram_collaborator_candidates where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
        await sql`
          update connected_accounts set display_name = 'Deleted provider account', external_account_id = 'deleted:' || id,
            credential_ref = null, status = 'disconnected', expires_at = null, updated_at = ${processedAt},
            payload = jsonb_build_object(
              'id', id, 'workspaceId', workspace_id, 'brandId', brand_id, 'platform', platform,
              'displayName', 'Deleted provider account', 'externalAccountId', 'deleted:' || id,
              'capabilities', '[]'::jsonb, 'status', 'disconnected', 'lastCheckedAt', ${processedAt},
              'lastErrorCode', 'provider_data_deleted', 'lastErrorStep', 'Reconnect provider access',
              'lastErrorSummary', 'Provider-derived account data was removed from OriginPost.',
              'createdBy', created_by, 'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'updatedAt', ${processedAt}
            )
          where workspace_id = ${workspaceId} and id = any(${accountIds})
        `;
      }
      await sql`update provider_grants set status = 'deleted', scopes = '[]'::jsonb, last_error_code = null, last_error_summary = null, next_refresh_at = null, next_validation_at = null, version = version + 1, updated_at = ${processedAt} where workspace_id = ${workspaceId} and id = any(${grantIds})`;
      await sql`update provider_data_deletion_scopes set status = 'completed', deleted_account_count = ${accountIds.length}, last_error_code = null, completed_at = ${processedAt}, updated_at = ${processedAt} where request_id = ${requestId} and workspace_id = ${workspaceId}`;
      const counts = await sql<{ total: number; completed: number }[]>`select count(*)::int as total, count(*) filter (where status = 'completed')::int as completed from provider_data_deletion_scopes where request_id = ${requestId}`;
      const count = counts[0] ?? { total: 0, completed: 0 };
      await sql`update provider_data_deletion_requests set status = case when ${count.completed} = ${count.total} then 'completed' else 'processing' end, scope_count = ${count.total}, completed_scope_count = ${count.completed}, completed_at = case when ${count.completed} = ${count.total} then ${processedAt} else null end, public_summary = case when ${count.completed} = ${count.total} then 'OriginPost removed the provider-derived data covered by this request. Workspace-authored drafts and media were retained.' else public_summary end, updated_at = ${processedAt} where id = ${requestId}`;
      const stable = createHash("sha256").update(`${requestId}:${workspaceId}:completed`).digest("hex");
      await sql`
        insert into workspace_notifications (id, workspace_id, kind, severity, title, body, action_url, dedupe_key, created_at)
        values (${`notification_provider_deletion_${stable.slice(0, 24)}`}, ${workspaceId}, 'connection_attention', 'info',
          'Provider data deletion completed', 'OriginPost removed the provider-derived data covered by this workspace scope. Workspace-authored drafts and media were retained.',
          '/?module=channels', ${`provider-deletion:${requestId}:${workspaceId}:completed`}, ${processedAt})
        on conflict (workspace_id, dedupe_key) do nothing
      `;
      return true;
    });
  }

  async failDataDeletionScope(requestId: string, workspaceId: string, errorCode: string, failedAt: string): Promise<void> {
    const safeCode = errorCode.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "deletion_failed";
    await this.sql.begin(async (sql) => {
      await sql`update provider_data_deletion_scopes set status = 'needs_review', last_error_code = ${safeCode}, updated_at = ${failedAt}, completed_at = null where request_id = ${requestId} and workspace_id = ${workspaceId} and status <> 'completed'`;
      await sql`update provider_data_deletion_requests set status = 'needs_review', completed_at = null, public_summary = 'OriginPost could not finish this deletion automatically. The request is retained for operator review.', updated_at = ${failedAt} where id = ${requestId} and status <> 'completed'`;
      await sql`
        update provider_grants provider_grant set last_checked_at = ${failedAt}, last_error_code = ${safeCode},
          last_error_summary = 'OriginPost could not finish provider-data deletion automatically. The request is retained for operator review.', updated_at = ${failedAt}
        where provider_grant.workspace_id = ${workspaceId} and provider_grant.id in (
          select jsonb_array_elements_text(scope.grant_ids) from provider_data_deletion_scopes scope
          where scope.request_id = ${requestId} and scope.workspace_id = ${workspaceId}
        ) and provider_grant.status = 'deletion_pending'
      `;
      const stable = createHash("sha256").update(`${requestId}:${workspaceId}:needs-review`).digest("hex");
      await sql`
        insert into workspace_notifications (id, workspace_id, kind, severity, title, body, action_url, dedupe_key, created_at)
        values (${`notification_provider_deletion_${stable.slice(0, 24)}`}, ${workspaceId}, 'connection_attention', 'warning',
          'Provider data deletion needs review', 'OriginPost could not finish this deletion automatically. The request is retained for operator review.',
          '/?module=channels', ${`provider-deletion:${requestId}:${workspaceId}:needs-review`}, ${failedAt})
        on conflict (workspace_id, dedupe_key) do nothing
      `;
    });
  }
}
