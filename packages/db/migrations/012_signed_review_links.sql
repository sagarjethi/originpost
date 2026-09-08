create table if not exists review_links (
  id text primary key,
  workspace_id text not null,
  content_item_id text not null,
  draft_id text not null,
  draft_sha256 text not null,
  allow_comment boolean not null default true,
  expires_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null,
  revoked_at timestamptz,
  payload jsonb not null
);

create index if not exists review_links_item_idx
  on review_links (workspace_id, content_item_id, created_at desc);

create index if not exists review_links_active_idx
  on review_links (id, expires_at)
  where revoked_at is null;
