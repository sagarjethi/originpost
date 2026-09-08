alter table post_analytics_snapshots
  drop constraint if exists post_analytics_snapshots_platform_check;

alter table post_analytics_snapshots
  add constraint post_analytics_snapshots_platform_check
  check (platform in ('instagram', 'facebook', 'youtube'));
