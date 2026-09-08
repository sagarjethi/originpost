create table if not exists monitor_rules (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  query text not null,
  interval_minutes integer not null check (interval_minutes between 10 and 1440),
  enabled boolean not null,
  next_run_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  payload jsonb not null
);

create table if not exists monitor_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  monitor_id text not null references monitor_rules(id) on delete cascade,
  status text not null check (status in ('running', 'completed', 'failed')),
  content_item_id text references content_items(id) on delete set null,
  started_at timestamptz not null,
  completed_at timestamptz,
  payload jsonb not null
);

create table if not exists monitor_fingerprints (
  workspace_id text not null references workspaces(id) on delete cascade,
  monitor_id text not null references monitor_rules(id) on delete cascade,
  fingerprint text not null,
  source_url text not null,
  content_item_id text not null references content_items(id) on delete cascade,
  first_seen_at timestamptz not null,
  primary key (workspace_id, monitor_id, fingerprint)
);

create index if not exists monitor_rules_workspace_enabled_idx on monitor_rules (workspace_id, enabled, updated_at desc);
create index if not exists monitor_runs_workspace_monitor_started_idx on monitor_runs (workspace_id, monitor_id, started_at desc);
