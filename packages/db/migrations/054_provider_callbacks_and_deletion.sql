-- Durable, idempotent Meta lifecycle callback receipts and governed local-data
-- deletion requests. Raw signed requests and provider subjects are never stored.

create table if not exists provider_lifecycle_receipts (
  id text primary key,
  provider text not null check (provider = 'meta'),
  event_type text not null check (event_type in ('deauthorization', 'data_deletion')),
  client_id text not null,
  lookup_key_version text not null,
  subject_lookup_hmac text not null check (subject_lookup_hmac ~ '^[0-9a-f]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('processed', 'failed')),
  matched_grants integer not null default 0 check (matched_grants >= 0),
  affected_accounts integer not null default 0 check (affected_accounts >= 0),
  error_code text,
  deletion_request_id text,
  received_at timestamptz not null,
  processed_at timestamptz not null,
  unique (provider, event_type, client_id, payload_sha256)
);

create index if not exists provider_lifecycle_receipts_subject_idx
  on provider_lifecycle_receipts (provider, client_id, lookup_key_version, subject_lookup_hmac, received_at desc);

create table if not exists provider_data_deletion_requests (
  id text primary key,
  provider text not null check (provider = 'meta'),
  client_id text not null,
  lookup_key_version text not null,
  subject_lookup_hmac text not null check (subject_lookup_hmac ~ '^[0-9a-f]{64}$'),
  grant_generation_sha256 text not null check (grant_generation_sha256 ~ '^[0-9a-f]{64}$'),
  confirmation_nonce text not null check (char_length(confirmation_nonce) between 20 and 120),
  confirmation_code_sha256 text not null unique check (confirmation_code_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('pending', 'processing', 'completed', 'needs_review')),
  scope_count integer not null default 0 check (scope_count >= 0),
  completed_scope_count integer not null default 0 check (completed_scope_count >= 0 and completed_scope_count <= scope_count),
  public_summary text not null check (char_length(public_summary) between 1 and 500),
  requested_at timestamptz not null,
  completed_at timestamptz,
  updated_at timestamptz not null,
  constraint provider_data_deletion_completion_check check ((status = 'completed') = (completed_at is not null)),
  unique (provider, client_id, lookup_key_version, subject_lookup_hmac, grant_generation_sha256)
);

create table if not exists provider_data_deletion_scopes (
  request_id text not null references provider_data_deletion_requests(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  grant_ids jsonb not null check (jsonb_typeof(grant_ids) = 'array' and jsonb_array_length(grant_ids) between 1 and 100),
  status text not null check (status in ('pending', 'processing', 'completed', 'needs_review')),
  deleted_account_count integer not null default 0 check (deleted_account_count >= 0),
  last_error_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  primary key (request_id, workspace_id),
  constraint provider_data_deletion_scope_completion_check check ((status = 'completed') = (completed_at is not null))
);

create index if not exists provider_data_deletion_scopes_pending_idx
  on provider_data_deletion_scopes (status, updated_at, request_id, workspace_id)
  where status in ('pending', 'processing');

alter table provider_lifecycle_receipts
  add constraint provider_lifecycle_receipts_deletion_request_fk
  foreign key (deletion_request_id) references provider_data_deletion_requests(id) on delete restrict;

alter table provider_lifecycle_receipts
  add constraint provider_lifecycle_receipts_deletion_shape_check
  check ((event_type = 'data_deletion') = (deletion_request_id is not null));
