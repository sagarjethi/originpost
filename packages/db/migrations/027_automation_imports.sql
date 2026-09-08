create table if not exists automation_import_sessions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  api_key_id text not null references automation_api_keys(id) on delete restrict,
  brand_id text not null references brands(id) on delete restrict,
  format text not null check (format in ('csv','json')),
  source_sha256 text not null,
  status text not null check (status in ('staged','processing','committed','failed')),
  rows jsonb not null,
  failure_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  committed_at timestamptz,
  unique (workspace_id, api_key_id, source_sha256)
);

create index if not exists automation_import_sessions_workspace_idx
  on automation_import_sessions (workspace_id, created_at desc);
