alter table workspace_notifications add column if not exists audience text not null default 'workspace';
alter table workspace_notifications drop constraint if exists workspace_notifications_audience_check;
alter table workspace_notifications add constraint workspace_notifications_audience_check
  check (audience in ('workspace', 'operators'));

create index if not exists workspace_notifications_operator_unread_idx
  on workspace_notifications (workspace_id, created_at desc)
  where audience = 'operators' and read_at is null;

create table if not exists workspace_operational_incidents (
  workspace_id text not null references workspaces(id) on delete cascade,
  check_id text not null check (check_id in ('malware_protection', 'webhook_delivery', 'media_cleanup', 'publishing_attention', 'delivery_queue')),
  status text not null check (status in ('warning', 'error')),
  fingerprint text not null check (char_length(fingerprint) = 64),
  opened_at timestamptz not null,
  last_seen_at timestamptz not null,
  resolved_at timestamptz,
  primary key (workspace_id, check_id)
);

create index if not exists workspace_operational_incidents_active_idx
  on workspace_operational_incidents (workspace_id, status, opened_at)
  where resolved_at is null;
