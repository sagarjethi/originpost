create table if not exists media_assets (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text references content_items(id) on delete set null,
  kind text not null check (kind in ('image', 'video', 'audio', 'document')),
  purpose text not null check (purpose in ('creative', 'evidence', 'source')),
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  object_key text not null,
  status text not null check (status in ('pending', 'ready', 'rejected')),
  rights_state text not null check (rights_state in ('unknown', 'reference-only', 'cleared', 'owned')),
  alt_text text,
  source_url text,
  last_error text,
  created_by text not null,
  created_at timestamptz not null,
  ready_at timestamptz,
  payload jsonb not null,
  unique (workspace_id, object_key)
);

create index if not exists media_assets_workspace_created_idx
  on media_assets (workspace_id, created_at desc);

create index if not exists media_assets_workspace_item_idx
  on media_assets (workspace_id, content_item_id, created_at desc);
