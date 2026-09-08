create table if not exists telegram_update_receipts (
  workspace_id text not null references workspaces(id) on delete cascade,
  update_id bigint not null,
  chat_id text not null,
  status text not null check (status in ('processing', 'completed', 'failed')),
  leased_until timestamptz not null,
  attempts integer not null default 1,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, update_id)
);

create index if not exists telegram_update_receipts_status_lease_idx
  on telegram_update_receipts (workspace_id, status, leased_until);
