-- Proof-linked Instagram engagement inbox.
-- Provider webhook bodies are intentionally not persisted. Receipts contain only
-- the normalized, bounded event required by the background worker.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brands_workspace_id_id_unique') then
    alter table brands add constraint brands_workspace_id_id_unique unique (workspace_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'content_items_id_workspace_brand_unique') then
    alter table content_items add constraint content_items_id_workspace_brand_unique unique (id, workspace_id, brand_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'connected_accounts_id_workspace_brand_unique') then
    alter table connected_accounts add constraint connected_accounts_id_workspace_brand_unique unique (id, workspace_id, brand_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'publish_proofs_id_workspace_content_unique') then
    alter table publish_proofs add constraint publish_proofs_id_workspace_content_unique unique (id, workspace_id, content_item_id);
  end if;
end $$;

create table if not exists engagement_threads (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  proof_id text not null,
  account_id text not null,
  platform text not null check (platform = 'instagram'),
  external_media_id text not null,
  state text not null check (state in ('open', 'resolved')),
  assigned_to text,
  last_activity_at timestamptz not null,
  last_synced_at timestamptz,
  resolved_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engagement_threads_brand_fk
    foreign key (workspace_id, brand_id) references brands(workspace_id, id) on delete cascade,
  constraint engagement_threads_content_fk
    foreign key (content_item_id, workspace_id, brand_id)
    references content_items(id, workspace_id, brand_id) on delete cascade,
  constraint engagement_threads_proof_fk
    foreign key (proof_id, workspace_id, content_item_id)
    references publish_proofs(id, workspace_id, content_item_id) on delete cascade,
  constraint engagement_threads_account_fk
    foreign key (account_id, workspace_id, brand_id)
    references connected_accounts(id, workspace_id, brand_id) on delete cascade,
  constraint engagement_threads_assignee_fk
    foreign key (workspace_id, assigned_to)
    references workspace_members(workspace_id, user_id) on delete restrict,
  constraint engagement_threads_resolved_state_check check (
    (state = 'resolved' and resolved_at is not null)
    or (state = 'open' and resolved_at is null)
  ),
  unique (workspace_id, proof_id),
  unique (id, workspace_id, brand_id),
  unique (id, workspace_id, brand_id, account_id, external_media_id)
);

create index if not exists engagement_threads_inbox_idx
  on engagement_threads (workspace_id, brand_id, state, last_activity_at desc, id desc);

create index if not exists engagement_threads_assigned_idx
  on engagement_threads (workspace_id, brand_id, assigned_to, last_activity_at desc, id desc);

create table if not exists engagement_comments (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  thread_id text not null,
  account_id text not null,
  external_media_id text not null,
  external_comment_id text not null,
  parent_external_comment_id text,
  author_scoped_id text,
  author_username text,
  body text not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  direction text not null check (direction in ('incoming', 'outgoing')),
  visibility text not null check (visibility in ('visible', 'hidden', 'deleted')),
  provider_created_at timestamptz,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  source text not null check (source in ('webhook', 'reconcile', 'action')),
  raw_payload_sha256 text check (raw_payload_sha256 is null or raw_payload_sha256 ~ '^[0-9a-f]{64}$'),
  retain_until timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engagement_comments_thread_fk
    foreign key (thread_id, workspace_id, brand_id, account_id, external_media_id)
    references engagement_threads(id, workspace_id, brand_id, account_id, external_media_id) on delete cascade,
  constraint engagement_comments_seen_order_check check (last_seen_at >= first_seen_at),
  unique (account_id, external_comment_id),
  unique (id, workspace_id, brand_id, thread_id)
);

create index if not exists engagement_comments_thread_timeline_idx
  on engagement_comments (
    workspace_id,
    brand_id,
    thread_id,
    provider_created_at,
    first_seen_at,
    id
  );

create index if not exists engagement_comments_incoming_activity_idx
  on engagement_comments (workspace_id, brand_id, last_seen_at desc, id desc)
  where direction = 'incoming' and visibility = 'visible';

create index if not exists engagement_comments_retention_idx
  on engagement_comments (retain_until);

create table if not exists engagement_thread_reads (
  workspace_id text not null,
  brand_id text not null,
  thread_id text not null,
  user_id text not null,
  last_read_comment_id text,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, thread_id, user_id),
  constraint engagement_thread_reads_thread_fk
    foreign key (thread_id, workspace_id, brand_id)
    references engagement_threads(id, workspace_id, brand_id) on delete cascade,
  constraint engagement_thread_reads_member_fk
    foreign key (workspace_id, user_id)
    references workspace_members(workspace_id, user_id) on delete cascade,
  constraint engagement_thread_reads_comment_fk
    foreign key (last_read_comment_id, workspace_id, brand_id, thread_id)
    references engagement_comments(id, workspace_id, brand_id, thread_id)
    on delete set null (last_read_comment_id)
);

create index if not exists engagement_thread_reads_user_idx
  on engagement_thread_reads (workspace_id, brand_id, user_id, last_read_at desc);

create table if not exists engagement_actions (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  thread_id text not null,
  comment_id text not null,
  type text not null check (type = 'reply'),
  body text not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in (
    'draft', 'pending_approval', 'queued', 'processing',
    'succeeded', 'failed', 'uncertain', 'cancelled'
  )),
  idempotency_key text not null,
  requested_by text not null,
  approved_by text,
  provider_reply_id text,
  provider_response_sha256 text check (
    provider_response_sha256 is null or provider_response_sha256 ~ '^[0-9a-f]{64}$'
  ),
  error_code text,
  error_summary text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  retain_until timestamptz not null default (now() + interval '90 days'),
  version integer not null default 1 check (version > 0),
  constraint engagement_actions_comment_fk
    foreign key (comment_id, workspace_id, brand_id, thread_id)
    references engagement_comments(id, workspace_id, brand_id, thread_id) on delete cascade,
  constraint engagement_actions_requester_fk
    foreign key (workspace_id, requested_by)
    references workspace_members(workspace_id, user_id) on delete restrict,
  constraint engagement_actions_approver_fk
    foreign key (workspace_id, approved_by)
    references workspace_members(workspace_id, user_id) on delete restrict,
  constraint engagement_actions_completion_check check (
    (status in ('succeeded', 'failed', 'cancelled') and completed_at is not null)
    or (status not in ('succeeded', 'failed', 'cancelled') and completed_at is null)
  ),
  constraint engagement_actions_error_length_check check (
    error_summary is null or char_length(error_summary) <= 500
  ),
  unique (workspace_id, idempotency_key)
);

create unique index if not exists engagement_actions_provider_reply_unique_idx
  on engagement_actions (provider_reply_id)
  where provider_reply_id is not null;

create index if not exists engagement_actions_recovery_idx
  on engagement_actions (status, updated_at, id)
  where status in ('queued', 'processing', 'uncertain');

create index if not exists engagement_actions_thread_idx
  on engagement_actions (workspace_id, brand_id, thread_id, created_at asc, id asc);

create index if not exists engagement_actions_retention_idx
  on engagement_actions (retain_until);

create table if not exists provider_webhook_receipts (
  id text primary key,
  provider text not null check (provider = 'instagram'),
  workspace_id text not null,
  brand_id text not null,
  account_id text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_event jsonb not null,
  status text not null check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  error_summary text,
  received_at timestamptz not null,
  updated_at timestamptz not null,
  processed_at timestamptz,
  retain_until timestamptz not null default (now() + interval '90 days'),
  constraint provider_webhook_receipts_account_fk
    foreign key (account_id, workspace_id, brand_id)
    references connected_accounts(id, workspace_id, brand_id) on delete cascade,
  constraint provider_webhook_receipts_event_object_check
    check (jsonb_typeof(normalized_event) = 'object'),
  constraint provider_webhook_receipts_lease_check check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  constraint provider_webhook_receipts_processing_lease_check check (
    status <> 'processing' or (lease_owner is not null and lease_expires_at is not null)
  ),
  constraint provider_webhook_receipts_processed_check check (
    (status = 'processed' and processed_at is not null)
    or (status <> 'processed' and processed_at is null)
  ),
  constraint provider_webhook_receipts_error_length_check check (
    error_summary is null or char_length(error_summary) <= 500
  ),
  unique (provider, payload_sha256)
);

create index if not exists provider_webhook_receipts_recovery_idx
  on provider_webhook_receipts (available_at, lease_expires_at, received_at, id)
  where status = 'pending' or status = 'processing';

create index if not exists provider_webhook_receipts_scope_idx
  on provider_webhook_receipts (workspace_id, brand_id, account_id, received_at desc);

create index if not exists provider_webhook_receipts_retention_idx
  on provider_webhook_receipts (retain_until);
