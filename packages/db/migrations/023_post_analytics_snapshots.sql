create table if not exists post_analytics_snapshots (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text not null references brands(id) on delete restrict,
  content_item_id text not null references content_items(id) on delete restrict,
  proof_id text not null references publish_proofs(id) on delete restrict,
  platform text not null check (platform in ('instagram', 'youtube')),
  account_id text not null,
  external_post_id text not null,
  status text not null check (status in ('ready', 'pending', 'unavailable', 'privacy_threshold', 'expired', 'hidden', 'permission_missing', 'unsupported', 'failed')),
  captured_at timestamptz not null,
  created_at timestamptz not null,
  payload jsonb not null
);

create index if not exists post_analytics_workspace_brand_captured_idx
  on post_analytics_snapshots (workspace_id, brand_id, captured_at desc);

create index if not exists post_analytics_workspace_proof_captured_idx
  on post_analytics_snapshots (workspace_id, proof_id, captured_at desc);
