create table if not exists workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  display_name text not null,
  role text not null check (role in ('owner', 'manager', 'creator', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists content_items (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  title text not null,
  status text not null,
  risk_level text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists content_items_workspace_updated_idx
  on content_items (workspace_id, updated_at desc);

create table if not exists source_evidence (
  id text primary key,
  content_item_id text not null references content_items(id) on delete cascade,
  kind text not null,
  title text not null,
  source_url text,
  publisher text,
  published_at timestamptz,
  captured_at timestamptz not null,
  sha256 text,
  rights_state text not null,
  confidence integer not null check (confidence between 0 and 100),
  payload jsonb not null
);

create table if not exists approvals (
  id text primary key,
  content_item_id text not null references content_items(id) on delete cascade,
  actor_id text not null,
  decision text not null,
  note text,
  created_at timestamptz not null,
  payload jsonb not null
);

create table if not exists publish_targets (
  id text primary key,
  content_item_id text not null references content_items(id) on delete cascade,
  platform text not null,
  account_id text not null,
  scheduled_for timestamptz not null,
  status text not null,
  payload jsonb not null
);

create table if not exists publish_proofs (
  id text primary key,
  content_item_id text not null references content_items(id) on delete restrict,
  platform text not null,
  account_id text not null,
  external_post_id text not null,
  live_url text not null,
  published_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (platform, account_id, external_post_id)
);

create table if not exists audit_events (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text references content_items(id) on delete set null,
  actor_id text not null,
  actor_type text not null,
  action text not null,
  detail jsonb not null,
  created_at timestamptz not null
);

create index if not exists audit_events_content_created_idx
  on audit_events (content_item_id, created_at asc);

insert into workspaces (id, name, slug)
values ('default', 'My workspace', 'my-workspace')
on conflict (id) do nothing;

insert into workspace_members (workspace_id, user_id, display_name, role)
values ('default', 'local-owner', 'Local Owner', 'owner')
on conflict (workspace_id, user_id) do nothing;
