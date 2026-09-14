-- Immutable project-template snapshots and resumable news-to-image work.
create table if not exists agent_post_templates (
  id text primary key, workspace_id text not null, brand_id text not null,
  payload jsonb not null, created_at timestamptz not null default now()
);
create index if not exists agent_post_templates_scope on agent_post_templates(workspace_id,brand_id,created_at desc);
create table if not exists agent_post_runs (
  id text primary key, workspace_id text not null, brand_id text not null,
  version integer not null check(version > 0),
  status text not null check(status in ('queued','researching','writing','generating','composing','drafting','ready','blocked','failed','uncertain')),
  payload jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists agent_post_runs_scope on agent_post_runs(workspace_id,brand_id,created_at desc);
create index if not exists agent_post_runs_pending on agent_post_runs(updated_at) where status in ('queued','researching','writing','generating','composing','drafting');
