create table if not exists encrypted_credentials (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  purpose text not null check (purpose in ('oauth-state', 'provider-token')),
  key_version text not null,
  algorithm text not null check (algorithm = 'aes-256-gcm'),
  iv text not null,
  auth_tag text not null,
  ciphertext text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists oauth_connection_states (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'youtube')),
  actor_id text not null,
  state_hash text not null unique,
  return_url text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists oauth_connection_states_active_idx
  on oauth_connection_states (platform, expires_at)
  where consumed_at is null;

create index if not exists encrypted_credentials_workspace_idx
  on encrypted_credentials (workspace_id, purpose, updated_at desc);
