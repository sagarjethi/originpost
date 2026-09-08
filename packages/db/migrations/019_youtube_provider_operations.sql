alter table provider_publish_operations
  drop constraint if exists provider_publish_operations_platform_check;

alter table provider_publish_operations
  add constraint provider_publish_operations_platform_check
  check (platform in ('instagram', 'youtube'));
