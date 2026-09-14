create table if not exists image_generations (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  version integer not null check (version > 0),
  content_item_id text,
  status text not null check (status in ('generating','ready','failed','uncertain')),
  provider text not null check (provider = 'openai'),
  model text not null check (char_length(model) between 1 and 160),
  prompt text not null check (char_length(prompt) between 1 and 12000),
  prompt_sha256 text not null check (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  visual_intent text not null check (visual_intent in ('editorial_graphic','illustration','product_visual','abstract')),
  size text not null check (size in ('1024x1024','1024x1536','1536x1024')),
  quality text not null check (quality in ('low','medium','high')),
  output_format text not null check (output_format = 'png'),
  moderation text not null check (moderation = 'auto'),
  alt_text text not null check (char_length(alt_text) between 1 and 500),
  source_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(source_evidence_ids) = 'array'),
  disclosure_required boolean not null check (disclosure_required),
  request_fingerprint_sha256 text not null check (request_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key_sha256 text not null check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  lease_owner text,
  lease_expires_at timestamptz,
  output_media_id text,
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[a-f0-9]{64}$'),
  provider_request_id text,
  revised_prompt text,
  revised_prompt_sha256 text check (revised_prompt_sha256 is null or revised_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  usage jsonb,
  error_code text,
  error_summary text,
  created_by text not null,
  created_at timestamptz not null,
  finished_at timestamptz,
  payload jsonb not null,
  constraint image_generations_brand_fk foreign key (workspace_id, brand_id)
    references brands(workspace_id, id) on delete cascade,
  constraint image_generations_content_fk foreign key (content_item_id, workspace_id, brand_id)
    references content_items(id, workspace_id, brand_id) on delete restrict,
  constraint image_generations_output_media_fk foreign key (output_media_id, workspace_id, brand_id)
    references media_assets(id, workspace_id, brand_id) on delete restrict,
  constraint image_generations_result_shape check (
    (status = 'generating' and lease_owner is not null and lease_expires_at is not null and output_media_id is null and output_sha256 is null and error_code is null and error_summary is null and finished_at is null)
    or (status = 'ready' and lease_owner is null and lease_expires_at is null and output_media_id is not null and output_sha256 is not null and error_code is null and error_summary is null and finished_at is not null)
    or (status in ('failed','uncertain') and lease_owner is null and lease_expires_at is null and output_media_id is null and output_sha256 is null and error_code is not null and error_summary is not null and finished_at is not null)
  ),
  constraint image_generations_idempotency_unique unique (workspace_id, idempotency_key_sha256),
  unique (workspace_id, brand_id, id)
);

create index if not exists image_generations_workspace_brand_created_idx
  on image_generations(workspace_id, brand_id, created_at desc, id desc);
create index if not exists image_generations_recovery_idx
  on image_generations(status, lease_expires_at)
  where status = 'generating';
