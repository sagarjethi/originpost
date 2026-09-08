-- Immutable, proof-backed analytics report snapshots and revocable client links.

create table if not exists analytics_report_definitions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  version integer not null check (version > 0),
  name text not null check (char_length(name) between 1 and 120),
  status text not null check (status in ('active', 'archived')),
  brand_ids jsonb not null check (jsonb_typeof(brand_ids) = 'array' and jsonb_array_length(brand_ids) between 1 and 50),
  created_by text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint analytics_report_creator_fk foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id) on delete restrict,
  unique (workspace_id, id)
);

create index if not exists analytics_report_definitions_workspace_idx
  on analytics_report_definitions (workspace_id, status, updated_at desc, id);

create table if not exists analytics_report_snapshots (
  id text primary key,
  workspace_id text not null,
  report_id text not null,
  report_version integer not null check (report_version > 0),
  canonical_sha256 text not null check (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  period_from timestamptz not null,
  period_to timestamptz not null,
  proof_count integer not null check (proof_count >= 0),
  group_count integer not null check (group_count >= 0),
  generated_by text not null,
  payload jsonb not null,
  generated_at timestamptz not null,
  constraint analytics_report_snapshot_period_check check (period_from <= period_to),
  constraint analytics_report_snapshot_report_fk foreign key (workspace_id, report_id) references analytics_report_definitions(workspace_id, id) on delete restrict,
  constraint analytics_report_snapshot_generator_fk foreign key (workspace_id, generated_by) references workspace_members(workspace_id, user_id) on delete restrict,
  unique (workspace_id, report_id, id),
  unique (workspace_id, canonical_sha256)
);

create index if not exists analytics_report_snapshots_report_idx
  on analytics_report_snapshots (workspace_id, report_id, generated_at desc, id);

create table if not exists analytics_report_shares (
  id text primary key,
  workspace_id text not null,
  report_id text not null,
  snapshot_id text not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  constraint analytics_report_share_snapshot_fk foreign key (workspace_id, report_id, snapshot_id) references analytics_report_snapshots(workspace_id, report_id, id) on delete restrict,
  constraint analytics_report_share_creator_fk foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint analytics_report_share_revoker_fk foreign key (workspace_id, revoked_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint analytics_report_share_revocation_check check ((revoked_at is null) = (revoked_by is null)),
  constraint analytics_report_share_expiry_check check (expires_at > created_at),
  unique (workspace_id, report_id, id)
);

create index if not exists analytics_report_shares_active_idx
  on analytics_report_shares (workspace_id, report_id, expires_at desc, id)
  where revoked_at is null;

create or replace function originpost_block_analytics_report_snapshot_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'analytics report snapshots are append-only';
end $$;

drop trigger if exists analytics_report_snapshots_append_only on analytics_report_snapshots;
create trigger analytics_report_snapshots_append_only before update or delete on analytics_report_snapshots
for each row execute function originpost_block_analytics_report_snapshot_mutation();
