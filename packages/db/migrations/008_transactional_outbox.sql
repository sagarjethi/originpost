create table if not exists outbox_events (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  topic text not null,
  dedupe_key text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  available_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);

create index if not exists outbox_events_dispatch_idx
  on outbox_events (available_at, created_at)
  where status in ('pending', 'processing');

create index if not exists outbox_events_workspace_status_idx
  on outbox_events (workspace_id, status, created_at desc);
