create table if not exists connected_accounts (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'youtube')),
  display_name text not null,
  external_account_id text not null,
  credential_ref text,
  status text not null check (status in ('setup_required', 'healthy', 'expiring', 'refresh_failed', 'disconnected')),
  expires_at timestamptz,
  last_checked_at timestamptz,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  payload jsonb not null,
  unique (workspace_id, platform, external_account_id)
);

create index if not exists connected_accounts_workspace_status_idx
  on connected_accounts (workspace_id, status, updated_at desc);

create index if not exists connected_accounts_expiry_idx
  on connected_accounts (expires_at)
  where expires_at is not null and status <> 'disconnected';
