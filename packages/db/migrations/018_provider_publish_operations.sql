create table if not exists provider_publish_operations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text not null references content_items(id) on delete cascade,
  target_id text not null,
  attempt_id text not null,
  platform text not null check (platform = 'instagram'),
  status text not null check (status in ('processing', 'ready', 'finalizing', 'published', 'uncertain', 'failed')),
  container_id text not null,
  external_post_id text,
  live_url text,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  payload jsonb not null,
  unique (workspace_id, target_id)
);

create index if not exists provider_publish_operations_workspace_status_idx
  on provider_publish_operations (workspace_id, status, updated_at desc);
