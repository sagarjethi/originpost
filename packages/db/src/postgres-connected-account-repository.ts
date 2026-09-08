import { randomUUID } from "node:crypto";
import type { AuditEvent, ConnectedAccount, ConnectedAccountRepository, EncryptedCredential, ProviderGrantChange, WorkspaceNotification } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type AccountRow = { brand_id: string; payload: ConnectedAccount };

function hydrate(row: AccountRow): ConnectedAccount {
  return { ...row.payload, brandId: row.payload.brandId ?? row.brand_id };
}

export class PostgresConnectedAccountRepository implements ConnectedAccountRepository {
  constructor(private readonly sql: Sql) {}

  private async currentGrantIds(sql: Sql | TransactionSql, workspaceId: string, accountIds: string[]): Promise<string[]> {
    if (!accountIds.length) return [];
    const rows = await sql<{ provider_grant_id: string }[]>`
      select distinct provider_grant_id from provider_grant_accounts
      where workspace_id = ${workspaceId} and account_id = any(${accountIds}) and unlinked_at is null
      order by provider_grant_id
    `;
    return rows.map((row) => row.provider_grant_id);
  }

  private async lockGrants(sql: Sql | TransactionSql, workspaceId: string, grantIds: string[]): Promise<void> {
    const ordered = [...new Set(grantIds)].sort();
    for (const grantId of ordered) await sql`select pg_advisory_xact_lock(hashtextextended(${`originpost:provider-grant:${workspaceId}:${grantId}`}, 0))`;
    if (ordered.length) await sql`select id from provider_grants where workspace_id = ${workspaceId} and id = any(${ordered}) order by id for update`;
  }

  private async saveCredential(sql: Sql | TransactionSql, value: EncryptedCredential): Promise<void> {
    await sql`insert into encrypted_credentials (id, workspace_id, purpose, key_version, algorithm, iv, auth_tag, ciphertext, created_at, updated_at) values (${value.id}, ${value.workspaceId}, ${value.purpose}, ${value.keyVersion}, ${value.algorithm}, ${value.iv}, ${value.authTag}, ${value.ciphertext}, ${value.createdAt}, ${value.updatedAt}) on conflict (id) do update set key_version = excluded.key_version, algorithm = excluded.algorithm, iv = excluded.iv, auth_tag = excluded.auth_tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at where encrypted_credentials.workspace_id = excluded.workspace_id`;
  }

  private async saveGrant(sql: Sql | TransactionSql, change: ProviderGrantChange): Promise<void> {
    const value = change.grant;
    if (!value) throw new Error("A provider grant is required for linking.");
    await sql`
      insert into provider_grants (
        id, workspace_id, provider, authorization_kind, client_id, lookup_key_version,
        subject_lookup_hmac, refresh_token_lookup_hmac, risc_token_prefix_lookup_hmac,
        risc_token_digest_lookup_hmac, status, scopes, version, issued_at,
        access_expires_at, data_access_expires_at, refresh_token_expires_at,
        next_refresh_at, next_validation_at, last_checked_at, last_healthy_at,
        last_error_code, last_error_summary, created_by, created_at, updated_at
      ) values (
        ${value.id}, ${value.workspaceId}, ${value.provider}, ${value.authorizationKind}, ${value.clientId}, ${value.lookupKeyVersion},
        ${value.subjectLookupHmac ?? null}, ${value.refreshTokenLookupHmac ?? null}, ${value.riscTokenPrefixLookupHmac ?? null},
        ${value.riscTokenDigestLookupHmac ?? null}, ${value.status}, ${sql.json(value.scopes as never)}, ${value.version}, ${value.issuedAt},
        ${value.accessExpiresAt ?? null}, ${value.dataAccessExpiresAt ?? null}, ${value.refreshTokenExpiresAt ?? null},
        ${value.nextRefreshAt ?? null}, ${value.nextValidationAt ?? null}, ${value.lastCheckedAt ?? null}, ${value.lastHealthyAt ?? null},
        ${value.lastErrorCode ?? null}, ${value.lastErrorSummary ?? null}, ${value.createdBy}, ${value.createdAt}, ${value.updatedAt}
      )
      on conflict (id) do update set
        lookup_key_version = excluded.lookup_key_version,
        subject_lookup_hmac = excluded.subject_lookup_hmac,
        refresh_token_lookup_hmac = excluded.refresh_token_lookup_hmac,
        risc_token_prefix_lookup_hmac = excluded.risc_token_prefix_lookup_hmac,
        risc_token_digest_lookup_hmac = excluded.risc_token_digest_lookup_hmac,
        status = excluded.status,
        scopes = (
          select coalesce(jsonb_agg(scope order by scope), '[]'::jsonb)
          from (
            select distinct jsonb_array_elements_text(provider_grants.scopes || excluded.scopes) as scope
          ) merged_scopes
        ),
        version = provider_grants.version + 1, issued_at = excluded.issued_at,
        access_expires_at = excluded.access_expires_at,
        data_access_expires_at = excluded.data_access_expires_at,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        next_refresh_at = excluded.next_refresh_at, next_validation_at = excluded.next_validation_at,
        last_checked_at = excluded.last_checked_at, last_healthy_at = excluded.last_healthy_at,
        last_error_code = excluded.last_error_code, last_error_summary = excluded.last_error_summary,
        updated_at = excluded.updated_at
      where provider_grants.workspace_id = excluded.workspace_id
        and provider_grants.provider = excluded.provider
        and provider_grants.authorization_kind = excluded.authorization_kind
        and provider_grants.client_id = excluded.client_id
    `;
  }

  private async linkGrant(sql: Sql | TransactionSql, account: ConnectedAccount, change: ProviderGrantChange): Promise<void> {
    if (!change.grant) throw new Error("A provider grant is required for linking.");
    const displaced = await sql<{ provider_grant_id: string }[]>`update provider_grant_accounts set unlinked_at = ${account.updatedAt} where workspace_id = ${account.workspaceId} and account_id = ${account.id} and unlinked_at is null and provider_grant_id <> ${change.grant.id} returning provider_grant_id`;
    await sql`
      insert into provider_grant_accounts (id, workspace_id, provider_grant_id, provider, account_id, brand_id, platform, linked_at, unlinked_at)
      select ${`grant_link_${randomUUID()}`}, ${account.workspaceId}, ${change.grant.id}, ${change.grant.provider}, ${account.id}, ${account.brandId}, ${account.platform}, ${account.updatedAt}, null
      where not exists (select 1 from provider_grant_accounts where workspace_id = ${account.workspaceId} and account_id = ${account.id} and provider_grant_id = ${change.grant.id} and unlinked_at is null)
      on conflict (id) do nothing
    `;
    await this.touchDisplacedGrants(sql, account.workspaceId, displaced.map((row) => row.provider_grant_id), account.updatedAt);
  }

  private async unlinkGrant(sql: Sql | TransactionSql, account: ConnectedAccount): Promise<void> {
    const displaced = await sql<{ provider_grant_id: string }[]>`update provider_grant_accounts set unlinked_at = ${account.updatedAt} where workspace_id = ${account.workspaceId} and account_id = ${account.id} and unlinked_at is null returning provider_grant_id`;
    await this.touchDisplacedGrants(sql, account.workspaceId, displaced.map((row) => row.provider_grant_id), account.updatedAt);
  }

  private async touchDisplacedGrants(sql: Sql | TransactionSql, workspaceId: string, grantIds: string[], at: string): Promise<void> {
    if (!grantIds.length) return;
    await sql`
      update provider_grants provider_grant set
        status = case when exists (select 1 from provider_grant_accounts link where link.workspace_id = provider_grant.workspace_id and link.provider_grant_id = provider_grant.id and link.unlinked_at is null) then provider_grant.status else 'superseded' end,
        version = version + 1,
        next_refresh_at = case when exists (select 1 from provider_grant_accounts link where link.workspace_id = provider_grant.workspace_id and link.provider_grant_id = provider_grant.id and link.unlinked_at is null) then provider_grant.next_refresh_at else null end,
        next_validation_at = case when exists (select 1 from provider_grant_accounts link where link.workspace_id = provider_grant.workspace_id and link.provider_grant_id = provider_grant.id and link.unlinked_at is null) then provider_grant.next_validation_at else null end,
        updated_at = ${at}
      where provider_grant.workspace_id = ${workspaceId} and provider_grant.id = any(${grantIds})
        and provider_grant.status in ('active','expiring','refresh_failed','reauthorization_required')
    `;
  }

  async list(workspaceId: string, brandId?: string): Promise<ConnectedAccount[]> {
    const rows = brandId
      ? await this.sql<AccountRow[]>`select brand_id, payload from connected_accounts where workspace_id = ${workspaceId} and brand_id = ${brandId} order by updated_at desc`
      : await this.sql<AccountRow[]>`select brand_id, payload from connected_accounts where workspace_id = ${workspaceId} order by updated_at desc`;
    return rows.map(hydrate);
  }

  async get(workspaceId: string, id: string): Promise<ConnectedAccount | null> {
    const rows = await this.sql<AccountRow[]>`select brand_id, payload from connected_accounts where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0] ? hydrate(rows[0]) : null;
  }

  async save(account: ConnectedAccount, event: AuditEvent, credentialChange?: { save?: EncryptedCredential; deleteId?: string }, providerGrantChange?: ProviderGrantChange): Promise<void> {
    if (account.workspaceId !== event.workspaceId) throw new Error("Account and audit event must belong to the same workspace.");
    if (credentialChange?.save && credentialChange.save.workspaceId !== account.workspaceId) throw new Error("Account and credential must belong to the same workspace.");
    if (providerGrantChange && Boolean(providerGrantChange.grant) === Boolean(providerGrantChange.unlink)) throw new Error("A provider grant change must link one grant or unlink the account.");
    if (providerGrantChange?.grant && providerGrantChange.grant.workspaceId !== account.workspaceId) throw new Error("Account and provider grant must belong to the same workspace.");
    await this.sql.begin(async (sql) => {
      const currentGrantIds = providerGrantChange ? await this.currentGrantIds(sql, account.workspaceId, [account.id]) : [];
      await this.lockGrants(sql, account.workspaceId, [...currentGrantIds, ...(providerGrantChange?.grant ? [providerGrantChange.grant.id] : [])]);
      if (credentialChange?.save) await this.saveCredential(sql, credentialChange.save);
      if (providerGrantChange?.grant) await this.saveGrant(sql, providerGrantChange);
      await sql`
        insert into connected_accounts (
          id, workspace_id, brand_id, platform, display_name, external_account_id, credential_ref,
          status, expires_at, last_checked_at, created_by, created_at, updated_at, payload
        ) values (
          ${account.id}, ${account.workspaceId}, ${account.brandId}, ${account.platform}, ${account.displayName},
          ${account.externalAccountId}, ${account.credentialRef ?? null}, ${account.status},
          ${account.expiresAt ?? null}, ${account.lastCheckedAt ?? null}, ${account.createdBy},
          ${account.createdAt}, ${account.updatedAt}, ${sql.json(account as never)}
        )
        on conflict (id) do update set
          brand_id = excluded.brand_id,
          display_name = excluded.display_name,
          external_account_id = excluded.external_account_id,
          credential_ref = excluded.credential_ref,
          status = excluded.status,
          expires_at = excluded.expires_at,
          last_checked_at = excluded.last_checked_at,
          updated_at = excluded.updated_at,
          payload = excluded.payload
        where connected_accounts.workspace_id = excluded.workspace_id
      `;
      if (providerGrantChange?.grant) await this.linkGrant(sql, account, providerGrantChange);
      else if (providerGrantChange?.unlink) await this.unlinkGrant(sql, account);
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
      if (credentialChange?.deleteId && credentialChange.deleteId !== credentialChange.save?.id) {
        await sql`delete from encrypted_credentials where workspace_id = ${account.workspaceId} and id = ${credentialChange.deleteId}`;
      }
    });
  }

  async saveCredentialRefreshResult(account: ConnectedAccount, event: AuditEvent, fence: { expectedCredentialRef: string; expectedExpiresAt: string }, credentialChange?: { save?: EncryptedCredential; deleteId?: string }, notification?: WorkspaceNotification): Promise<boolean> {
    if (account.workspaceId !== event.workspaceId) throw new Error("Account and audit event must belong to the same workspace.");
    if (credentialChange?.save && credentialChange.save.workspaceId !== account.workspaceId) throw new Error("Account and credential must belong to the same workspace.");
    return this.sql.begin(async (sql) => {
      const currentGrantIds = await this.currentGrantIds(sql, account.workspaceId, [account.id]);
      await this.lockGrants(sql, account.workspaceId, currentGrantIds);
      const locked = await sql<AccountRow[]>`
        select brand_id, payload from connected_accounts
        where workspace_id = ${account.workspaceId} and id = ${account.id}
          and platform = ${account.platform}
          and credential_ref = ${fence.expectedCredentialRef}
          and expires_at = ${fence.expectedExpiresAt}
          and status not in ('disconnected', 'setup_required')
        for update
      `;
      if (!locked.length) return false;
      const current = hydrate(locked[0]!);
      const lifecycleResult: ConnectedAccount = {
        ...current,
        credentialRef: account.credentialRef,
        status: account.status,
        expiresAt: account.expiresAt,
        lastCheckedAt: account.lastCheckedAt,
        lastHealthyAt: account.lastHealthyAt,
        lastErrorCode: account.lastErrorCode,
        lastErrorStep: account.lastErrorStep,
        lastErrorSummary: account.lastErrorSummary,
        updatedAt: account.updatedAt,
      };
      if (credentialChange?.save) {
        const value = credentialChange.save;
        await sql`insert into encrypted_credentials (id, workspace_id, purpose, key_version, algorithm, iv, auth_tag, ciphertext, created_at, updated_at) values (${value.id}, ${value.workspaceId}, ${value.purpose}, ${value.keyVersion}, ${value.algorithm}, ${value.iv}, ${value.authTag}, ${value.ciphertext}, ${value.createdAt}, ${value.updatedAt}) on conflict (id) do update set key_version = excluded.key_version, algorithm = excluded.algorithm, iv = excluded.iv, auth_tag = excluded.auth_tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at where encrypted_credentials.workspace_id = excluded.workspace_id`;
      }
      const saved = await sql<{ id: string }[]>`
        update connected_accounts set
          brand_id = ${lifecycleResult.brandId}, display_name = ${lifecycleResult.displayName}, external_account_id = ${lifecycleResult.externalAccountId},
          credential_ref = ${lifecycleResult.credentialRef ?? null}, status = ${lifecycleResult.status}, expires_at = ${lifecycleResult.expiresAt ?? null},
          last_checked_at = ${lifecycleResult.lastCheckedAt ?? null}, updated_at = ${lifecycleResult.updatedAt}, payload = ${sql.json(lifecycleResult as never)}
        where workspace_id = ${account.workspaceId} and id = ${account.id}
          and platform = ${account.platform}
          and credential_ref = ${fence.expectedCredentialRef}
          and expires_at = ${fence.expectedExpiresAt}
          and status not in ('disconnected', 'setup_required')
        returning id
      `;
      if (!saved.length) throw new Error("The connected account refresh fence changed while its row was locked.");
      const grantStatus = lifecycleResult.status === "healthy" ? "active" : lifecycleResult.status === "expiring" ? "expiring" : lifecycleResult.status === "refresh_failed" ? "refresh_failed" : "reauthorization_required";
      const nextRefreshAt = lifecycleResult.expiresAt
        ? new Date(Math.max(Date.parse(lifecycleResult.updatedAt), Date.parse(lifecycleResult.expiresAt) - (lifecycleResult.platform === "instagram" ? 7 * 24 * 60 * 60_000 : 15 * 60_000))).toISOString()
        : null;
      await sql`
        update provider_grants provider_grant set status = ${grantStatus}, access_expires_at = ${lifecycleResult.expiresAt ?? null},
          next_refresh_at = ${grantStatus === "active" || grantStatus === "expiring" ? nextRefreshAt : null},
          last_checked_at = ${lifecycleResult.lastCheckedAt ?? null}, last_healthy_at = ${lifecycleResult.lastHealthyAt ?? null},
          last_error_code = ${lifecycleResult.lastErrorCode ?? null}, last_error_summary = ${lifecycleResult.lastErrorSummary ?? null},
          version = version + 1, updated_at = ${lifecycleResult.updatedAt}
        where provider_grant.workspace_id = ${account.workspaceId} and provider_grant.id in (
          select link.provider_grant_id from provider_grant_accounts link
          where link.workspace_id = ${account.workspaceId} and link.account_id = ${account.id} and link.unlinked_at is null
        ) and provider_grant.status not in ('deauthorized','revoked','deletion_pending','deleted','superseded')
      `;
      await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt}) on conflict (id) do nothing`;
      if (notification) {
        if (notification.workspaceId !== account.workspaceId) throw new Error("Account and notification must belong to the same workspace.");
        await sql`insert into workspace_notifications (id, workspace_id, kind, severity, title, body, content_item_id, target_id, monitor_id, account_id, action_url, dedupe_key, created_at, read_at, read_by) values (${notification.id}, ${notification.workspaceId}, ${notification.kind}, ${notification.severity}, ${notification.title}, ${notification.body}, ${notification.contentItemId ?? null}, ${notification.targetId ?? null}, ${notification.monitorId ?? null}, ${notification.accountId ?? null}, ${notification.actionUrl ?? null}, ${notification.dedupeKey}, ${notification.createdAt}, ${notification.readAt ?? null}, ${notification.readBy ?? null}) on conflict (workspace_id, dedupe_key) do nothing`;
      }
      if (credentialChange?.deleteId && credentialChange.deleteId !== credentialChange.save?.id) await sql`delete from encrypted_credentials where workspace_id = ${account.workspaceId} and id = ${credentialChange.deleteId}`;
      return true;
    });
  }

  async completeOAuthSelection(workspaceId: string, selectionCredentialId: string, entries: Array<{ account: ConnectedAccount; event: AuditEvent; credentialChange: { save: EncryptedCredential; deleteId?: string } }>, providerGrantChange?: ProviderGrantChange): Promise<boolean> {
    for (const { account, event, credentialChange } of entries) {
      if (account.workspaceId !== workspaceId || event.workspaceId !== workspaceId || credentialChange.save.workspaceId !== workspaceId) throw new Error("OAuth selection completion must stay in one workspace.");
    }
    if (providerGrantChange && (!providerGrantChange.grant || providerGrantChange.unlink || providerGrantChange.grant.workspaceId !== workspaceId)) throw new Error("OAuth grant completion must link one grant in the same workspace.");
    return this.sql.begin(async (sql) => {
      const consumed = await sql<{ id: string }[]>`delete from encrypted_credentials where workspace_id = ${workspaceId} and id = ${selectionCredentialId} and purpose = 'provider-discovery' returning id`;
      if (!consumed.length) return false;
      const currentGrantIds = await this.currentGrantIds(sql, workspaceId, entries.map(({ account }) => account.id));
      await this.lockGrants(sql, workspaceId, [...currentGrantIds, ...(providerGrantChange?.grant ? [providerGrantChange.grant.id] : [])]);
      if (providerGrantChange?.grant) await this.saveGrant(sql, providerGrantChange);
      for (const { account, event, credentialChange } of entries) {
        const value = credentialChange.save;
        await this.saveCredential(sql, value);
        await sql`insert into connected_accounts (id, workspace_id, brand_id, platform, display_name, external_account_id, credential_ref, status, expires_at, last_checked_at, created_by, created_at, updated_at, payload) values (${account.id}, ${account.workspaceId}, ${account.brandId}, ${account.platform}, ${account.displayName}, ${account.externalAccountId}, ${account.credentialRef ?? null}, ${account.status}, ${account.expiresAt ?? null}, ${account.lastCheckedAt ?? null}, ${account.createdBy}, ${account.createdAt}, ${account.updatedAt}, ${sql.json(account as never)}) on conflict (id) do update set brand_id = excluded.brand_id, display_name = excluded.display_name, external_account_id = excluded.external_account_id, credential_ref = excluded.credential_ref, status = excluded.status, expires_at = excluded.expires_at, last_checked_at = excluded.last_checked_at, updated_at = excluded.updated_at, payload = excluded.payload where connected_accounts.workspace_id = excluded.workspace_id`;
        if (providerGrantChange?.grant) await this.linkGrant(sql, account, providerGrantChange);
        await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt}) on conflict (id) do nothing`;
        if (credentialChange.deleteId && credentialChange.deleteId !== value.id) await sql`delete from encrypted_credentials where workspace_id = ${workspaceId} and id = ${credentialChange.deleteId}`;
      }
      return true;
    });
  }
}
