create table if not exists review_comments (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text not null references content_items(id) on delete cascade,
  draft_id text not null,
  draft_sha256 text not null,
  author_id text not null,
  audience text not null check (audience in ('internal', 'reviewer', 'public')),
  body text not null,
  created_at timestamptz not null,
  payload jsonb not null
);

create index if not exists review_comments_workspace_item_created_idx
  on review_comments (workspace_id, content_item_id, created_at asc);

create index if not exists review_comments_workspace_draft_created_idx
  on review_comments (workspace_id, draft_id, created_at asc);
