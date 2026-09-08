alter table media_assets add column if not exists version integer not null default 1;
alter table media_assets add column if not exists upload_expires_at timestamptz;
alter table media_assets add column if not exists status_before_trash text;
alter table media_assets add column if not exists trashed_at timestamptz;
alter table media_assets add column if not exists trash_expires_at timestamptz;
alter table media_assets add column if not exists trashed_by text;
alter table media_assets add column if not exists cleanup_reason text;
alter table media_assets add column if not exists cleanup_after timestamptz;
alter table media_assets add column if not exists cleanup_attempts integer not null default 0;
alter table media_assets add column if not exists deleted_at timestamptz;

update media_assets
set upload_expires_at = created_at + interval '60 minutes'
where upload_expires_at is null;

alter table media_assets alter column upload_expires_at set not null;
alter table media_assets drop constraint if exists media_assets_status_check;
alter table media_assets add constraint media_assets_status_check
  check (status in ('pending', 'ready', 'rejected', 'trashed', 'expired', 'deleted', 'cleanup_failed'));
alter table media_assets add constraint media_assets_cleanup_reason_check
  check (cleanup_reason is null or cleanup_reason in ('upload-expired', 'trash-retention-ended'));
alter table media_assets add constraint media_assets_status_before_trash_check
  check (status_before_trash is null or status_before_trash in ('pending', 'ready', 'rejected', 'expired'));
alter table media_assets add constraint media_assets_lifecycle_shape_check check (
  (status = 'trashed' and trash_expires_at is not null and trashed_at is not null and trashed_by is not null and status_before_trash is not null)
  or status <> 'trashed'
);

create index if not exists media_assets_cleanup_due_idx
  on media_assets (coalesce(cleanup_after, trash_expires_at, upload_expires_at), id)
  where status in ('pending', 'trashed', 'cleanup_failed');

create index if not exists media_assets_workspace_brand_status_idx
  on media_assets (workspace_id, brand_id, status, created_at desc);
