create table if not exists batch_operation_plans (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text not null,
  version integer not null check (version > 0),
  name text not null check (char_length(name) between 2 and 120),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('ready','processing','review_ready','partially_failed','completed','archived')),
  rows jsonb not null check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) between 1 and 100),
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  committed_at timestamptz,
  archived_at timestamptz,
  foreign key (workspace_id, brand_id) references brands(workspace_id, id) on delete restrict,
  unique (workspace_id, brand_id, source_sha256)
);

create index if not exists batch_operation_plans_workspace_brand_created_idx
  on batch_operation_plans (workspace_id, brand_id, created_at desc);

