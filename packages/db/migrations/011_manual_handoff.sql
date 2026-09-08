alter table publish_targets add column if not exists delivery_mode text not null default 'auto_publish';
alter table publish_targets add column if not exists notification_destination_id text;
alter table publish_targets add column if not exists action_required_at timestamptz;
alter table publish_targets add column if not exists acknowledged_at timestamptz;
alter table publish_targets add column if not exists acknowledged_by text;

alter table publish_targets drop constraint if exists publish_targets_delivery_mode_check;
alter table publish_targets add constraint publish_targets_delivery_mode_check
  check (delivery_mode in ('auto_publish', 'manual_handoff'));

create index if not exists publish_targets_workspace_manual_status_idx
  on publish_targets (workspace_id, status, scheduled_for)
  where delivery_mode = 'manual_handoff';
