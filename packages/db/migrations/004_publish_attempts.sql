create table if not exists publish_attempts (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text not null references content_items(id) on delete cascade,
  target_id text not null,
  attempt_no integer not null check (attempt_no > 0),
  idempotency_key text not null,
  status text not null check (status in ('started', 'published', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  payload jsonb not null,
  unique (workspace_id, target_id, attempt_no),
  unique (workspace_id, idempotency_key, attempt_no)
);

create index if not exists publish_attempts_workspace_target_idx
  on publish_attempts (workspace_id, target_id, attempt_no desc);
create index if not exists publish_attempts_workspace_status_idx
  on publish_attempts (workspace_id, status, started_at);
