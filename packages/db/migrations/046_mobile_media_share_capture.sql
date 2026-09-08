alter table mobile_share_capture_receipts
  add column if not exists media jsonb,
  add column if not exists materialization_sha256 text,
  add column if not exists materialization_workspace_id text,
  add column if not exists materialization_brand_id text,
  add column if not exists materialization_claim_owner text,
  add column if not exists materialization_claim_expires_at timestamptz,
  add column if not exists converted_media_asset_id text,
  add column if not exists converted_draft_id text;

alter table mobile_share_capture_receipts drop constraint if exists mobile_share_capture_receipts_status_check;
alter table mobile_share_capture_receipts add constraint mobile_share_capture_receipts_status_check
  check (status in ('pending','receiving','inspecting','pending_review','materializing','converted','rejected','failed','expired'));

alter table mobile_share_capture_receipts drop constraint if exists mobile_share_capture_conversion_shape;
alter table mobile_share_capture_receipts add constraint mobile_share_capture_conversion_shape check (
  (status = 'converted'
    and converted_workspace_id is not null
    and converted_brand_id is not null
    and converted_at is not null
    and (converted_content_item_id is not null or converted_media_asset_id is not null))
  or
  (status <> 'converted'
    and converted_content_item_id is null
    and converted_media_asset_id is null
    and converted_draft_id is null
    and converted_workspace_id is null
    and converted_brand_id is null
    and converted_at is null)
);

alter table mobile_share_capture_receipts add constraint mobile_share_capture_media_shape check (
  media is null
  or (
    media ?& array['kind','fileName','declaredContentType','sizeBytes','sha256','quarantineObjectKey','inspectionStatus']
    and media->>'kind' in ('image','video')
    and (media->>'sizeBytes')::bigint > 0
    and media->>'sha256' ~ '^[a-f0-9]{64}$'
  )
);

alter table mobile_share_capture_receipts add constraint mobile_share_capture_materialization_shape check (
  (status = 'materializing'
    and materialization_sha256 is not null
    and materialization_workspace_id is not null
    and materialization_brand_id is not null
    and materialization_claim_owner is not null
    and materialization_claim_expires_at is not null)
  or status <> 'materializing'
);

alter table mobile_share_capture_receipts add constraint mobile_share_capture_materialization_hash_check
  check (materialization_sha256 is null or materialization_sha256 ~ '^[a-f0-9]{64}$');

alter table mobile_share_capture_receipts add constraint mobile_share_capture_media_asset_fk
  foreign key (converted_media_asset_id) references media_assets(id) on delete restrict;

create index if not exists mobile_share_capture_materialization_lease_idx
  on mobile_share_capture_receipts (materialization_claim_expires_at, id)
  where status = 'materializing';

create index if not exists mobile_share_capture_quarantine_cleanup_idx
  on mobile_share_capture_receipts (updated_at, id)
  where status in ('converted','expired','rejected','failed') and media is not null;
