create table if not exists content_draft_revisions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text not null references content_items(id) on delete cascade,
  revision integer not null check (revision > 0),
  platform text not null,
  format text not null,
  content_sha256 text not null,
  created_by text not null,
  created_at timestamptz not null,
  payload jsonb not null,
  unique (workspace_id, content_item_id, revision)
);

alter table approvals add column if not exists draft_id text;
alter table approvals add column if not exists draft_sha256 text;

create index if not exists content_draft_revisions_workspace_item_idx
  on content_draft_revisions (workspace_id, content_item_id, revision desc);
create index if not exists approvals_workspace_draft_idx
  on approvals (workspace_id, draft_id);
