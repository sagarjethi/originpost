alter table workspace_notifications
  drop constraint if exists workspace_notifications_kind_check;

alter table workspace_notifications
  add constraint workspace_notifications_kind_check
  check (kind in (
    'publish_failed',
    'action_required',
    'monitor_new_findings',
    'monitor_failed',
    'connection_attention',
    'approval_needed',
    'engagement_reply_failed',
    'engagement_permission_missing',
    'engagement_new_activity',
    'system'
  ));
