-- Parent provider authorizations and temporal links to their derived accounts.
-- Provider subjects and refresh-token identifiers are stored only as keyed
-- lookup HMACs. Existing connected accounts remain unlinked and unchanged.

create table if not exists provider_grants (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  provider text not null check (provider in ('meta', 'google')),
  authorization_kind text not null check (authorization_kind in ('instagram_login', 'facebook_login', 'google_oauth')),
  client_id text not null,
  lookup_key_version text not null,
  subject_lookup_hmac text check (subject_lookup_hmac is null or subject_lookup_hmac ~ '^[0-9a-f]{64}$'),
  refresh_token_lookup_hmac text check (refresh_token_lookup_hmac is null or refresh_token_lookup_hmac ~ '^[0-9a-f]{64}$'),
  risc_token_prefix_lookup_hmac text check (risc_token_prefix_lookup_hmac is null or risc_token_prefix_lookup_hmac ~ '^[0-9a-f]{64}$'),
  risc_token_digest_lookup_hmac text check (risc_token_digest_lookup_hmac is null or risc_token_digest_lookup_hmac ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('active', 'expiring', 'refresh_failed', 'reauthorization_required', 'deauthorized', 'revoked', 'deletion_pending', 'deleted', 'superseded')),
  scopes jsonb not null check (jsonb_typeof(scopes) = 'array' and jsonb_array_length(scopes) <= 100),
  version bigint not null default 1 check (version >= 1),
  issued_at timestamptz not null,
  access_expires_at timestamptz,
  data_access_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  next_refresh_at timestamptz,
  next_validation_at timestamptz,
  last_checked_at timestamptz,
  last_healthy_at timestamptz,
  last_error_code text,
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) <= 500),
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint provider_grants_provider_lookup_check check (
    (provider = 'meta' and authorization_kind in ('facebook_login', 'instagram_login') and subject_lookup_hmac is not null)
    or (provider = 'google' and authorization_kind = 'google_oauth' and refresh_token_lookup_hmac is not null)
  ),
  unique (id, workspace_id, provider)
);

create unique index if not exists provider_grants_meta_identity_idx
  on provider_grants (workspace_id, client_id, authorization_kind, lookup_key_version, subject_lookup_hmac)
  where provider = 'meta' and status <> 'deleted';

create unique index if not exists provider_grants_google_identity_idx
  on provider_grants (workspace_id, client_id, lookup_key_version, refresh_token_lookup_hmac)
  where provider = 'google' and status <> 'deleted';

create index if not exists provider_grants_callback_lookup_idx
  on provider_grants (provider, client_id, lookup_key_version, subject_lookup_hmac, status)
  where subject_lookup_hmac is not null;

create index if not exists provider_grants_refresh_due_idx
  on provider_grants (next_refresh_at, provider, status)
  where next_refresh_at is not null and status in ('active', 'expiring', 'refresh_failed');

create index if not exists provider_grants_validation_due_idx
  on provider_grants (next_validation_at, provider, status)
  where next_validation_at is not null and status in ('active', 'expiring', 'refresh_failed');

create table if not exists provider_grant_accounts (
  id text primary key,
  workspace_id text not null,
  provider_grant_id text not null,
  provider text not null check (provider in ('meta', 'google')),
  account_id text not null,
  brand_id text not null,
  platform text not null check (platform in ('instagram', 'facebook', 'youtube')),
  linked_at timestamptz not null,
  unlinked_at timestamptz,
  constraint provider_grant_accounts_grant_fk foreign key (provider_grant_id, workspace_id, provider)
    references provider_grants(id, workspace_id, provider) on delete cascade,
  constraint provider_grant_accounts_account_fk foreign key (account_id, workspace_id, brand_id, platform)
    references connected_accounts(id, workspace_id, brand_id, platform) on delete cascade,
  constraint provider_grant_accounts_provider_platform_check check (
    (provider = 'meta' and platform in ('instagram', 'facebook'))
    or (provider = 'google' and platform = 'youtube')
  ),
  constraint provider_grant_accounts_time_check check (unlinked_at is null or unlinked_at >= linked_at),
  unique (workspace_id, id)
);

create unique index if not exists provider_grant_accounts_current_account_idx
  on provider_grant_accounts (workspace_id, account_id)
  where unlinked_at is null;

create index if not exists provider_grant_accounts_current_grant_idx
  on provider_grant_accounts (workspace_id, provider_grant_id, account_id)
  where unlinked_at is null;

