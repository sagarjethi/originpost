alter table media_assets add column if not exists inspection_status text;
alter table media_assets add column if not exists detected_content_type text;
alter table media_assets add column if not exists width_pixels integer;
alter table media_assets add column if not exists height_pixels integer;
alter table media_assets add column if not exists duration_ms bigint;
alter table media_assets add column if not exists inspected_at timestamptz;
alter table media_assets add column if not exists inspector text;
alter table media_assets add column if not exists inspection_error_code text;
alter table media_assets add column if not exists inspection_error_summary text;

update media_assets
set inspection_status = case
      when kind in ('audio', 'document') then 'not_applicable'
      else 'unavailable'
    end,
    inspection_error_code = case
      when kind in ('image', 'video') then 'legacy_not_inspected'
      else null
    end,
    inspection_error_summary = case
      when kind in ('image', 'video') then 'This upload predates trusted server inspection.'
      else null
    end
where inspection_status is null;

alter table media_assets alter column inspection_status set not null;
alter table media_assets add constraint media_assets_inspection_status_check
  check (inspection_status in ('pending', 'ready', 'unavailable', 'failed', 'not_applicable'));
alter table media_assets add constraint media_assets_dimensions_check
  check (
    (width_pixels is null or width_pixels > 0)
    and (height_pixels is null or height_pixels > 0)
    and (duration_ms is null or duration_ms > 0)
  );
alter table media_assets add constraint media_assets_inspection_shape_check
  check (
    (inspection_status = 'ready' and kind = 'image' and width_pixels is not null and height_pixels is not null and duration_ms is null)
    or (inspection_status = 'ready' and kind = 'video' and width_pixels is not null and height_pixels is not null and duration_ms is not null)
    or (inspection_status = 'not_applicable' and kind in ('audio', 'document') and width_pixels is null and height_pixels is null and duration_ms is null)
    or inspection_status in ('pending', 'unavailable', 'failed')
  );

create index if not exists media_assets_workspace_inspection_idx
  on media_assets (workspace_id, inspection_status, created_at desc)
  where kind in ('image', 'video');
