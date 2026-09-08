create table if not exists workspace_notifications (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('publish_failed', 'action_required', 'monitor_new_findings', 'monitor_failed', 'connection_attention', 'approval_needed', 'system')),
  severity text not null check (severity in ('info', 'warning', 'error')),
  title text not null check (char_length(title) between 1 and 180),
  body text not null check (char_length(body) between 1 and 2000),
  content_item_id text,
  target_id text,
  monitor_id text,
  account_id text,
  action_url text,
  dedupe_key text not null,
  created_at timestamptz not null,
  read_at timestamptz,
  read_by text,
  unique (workspace_id, dedupe_key)
);

create index if not exists workspace_notifications_unread_idx
  on workspace_notifications (workspace_id, created_at desc)
  where read_at is null;

create index if not exists workspace_notifications_recent_idx
  on workspace_notifications (workspace_id, created_at desc);
