create table if not exists mobile_share_capture_receipts (
  id text primary key,
  created_workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  version integer not null default 1 check (version > 0),
  status text not null check (status in ('pending','converted','failed','expired')),
  title text,
  shared_text text,
  original_url text,
  normalized_url text,
  dedupe_sha256 text not null check (dedupe_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  converted_content_item_id text,
  converted_workspace_id text,
  converted_brand_id text,
  converted_at timestamptz,
  failure_code text,
  constraint mobile_share_capture_conversion_shape check (
    (status = 'converted' and converted_content_item_id is not null and converted_workspace_id is not null and converted_brand_id is not null and converted_at is not null)
    or (status <> 'converted' and converted_content_item_id is null and converted_workspace_id is null and converted_brand_id is null and converted_at is null)
  ),
  constraint mobile_share_capture_payload_shape check (
    status not in ('converted','expired') or (title is null and shared_text is null and original_url is null and normalized_url is null)
  ),
  constraint mobile_share_capture_content_fk foreign key (converted_content_item_id, converted_workspace_id, converted_brand_id)
    references content_items(id, workspace_id, brand_id) on delete restrict
);

create index if not exists mobile_share_capture_owner_status_idx
  on mobile_share_capture_receipts (user_id, status, expires_at desc);

create index if not exists mobile_share_capture_expiry_idx
  on mobile_share_capture_receipts (expires_at asc)
  where status = 'pending';

