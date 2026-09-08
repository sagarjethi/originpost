-- Private-message inbox persistence. Provider identifiers and message content
-- are stored only as keyed hashes and AES-GCM envelopes by the repository.

create table if not exists private_conversations (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  account_id text not null,
  platform text not null check (platform in ('instagram', 'facebook')),
  connection_mode text not null check (connection_mode in ('facebook_page_messenger', 'instagram_linked_page', 'instagram_login')),
  provider_conversation_key_hash text not null check (provider_conversation_key_hash ~ '^[0-9a-f]{64}$'),
  provider_conversation_key_envelope jsonb not null,
  state text not null check (state in ('open', 'resolved')),
  assigned_to text,
  reply_eligibility jsonb not null,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_activity_at timestamptz not null,
  last_synced_at timestamptz,
  resolved_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint private_conversations_account_fk
    foreign key (account_id, workspace_id, brand_id, platform)
    references connected_accounts(id, workspace_id, brand_id, platform) on delete cascade,
  constraint private_conversations_assignee_fk
    foreign key (workspace_id, assigned_to)
    references workspace_members(workspace_id, user_id) on delete restrict,
  constraint private_conversations_mode_platform_check check (
    (connection_mode = 'facebook_page_messenger' and platform = 'facebook') or
    (connection_mode in ('instagram_linked_page', 'instagram_login') and platform = 'instagram')
  ),
  constraint private_conversations_resolved_check check (
    (state = 'resolved' and resolved_at is not null) or
    (state = 'open' and resolved_at is null)
  ),
  unique (account_id, provider_conversation_key_hash),
  unique (id, workspace_id, brand_id),
  unique (id, workspace_id, brand_id, account_id),
  unique (id, workspace_id, brand_id, account_id, platform, connection_mode)
);

create index if not exists private_conversations_inbox_idx
  on private_conversations (workspace_id, brand_id, state, last_activity_at desc, id desc);
create index if not exists private_conversations_account_sync_idx
  on private_conversations (account_id, last_synced_at, id);

create table if not exists private_conversation_participants (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  conversation_id text not null,
  account_id text not null,
  platform text not null check (platform in ('instagram', 'facebook')),
  connection_mode text not null check (connection_mode in ('facebook_page_messenger', 'instagram_linked_page', 'instagram_login')),
  provider_participant_key_hash text not null check (provider_participant_key_hash ~ '^[0-9a-f]{64}$'),
  provider_participant_key_envelope jsonb not null,
  role text not null check (role in ('business', 'customer', 'unknown')),
  profile_envelope jsonb,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  retain_until timestamptz not null default (now() + interval '90 days'),
  redacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint private_participants_conversation_fk
    foreign key (conversation_id, workspace_id, brand_id, account_id, platform, connection_mode)
    references private_conversations(id, workspace_id, brand_id, account_id, platform, connection_mode) on delete cascade,
  constraint private_participants_seen_check check (last_seen_at >= first_seen_at),
  unique (account_id, provider_participant_key_hash),
  unique (id, workspace_id, brand_id, conversation_id, account_id)
);

create index if not exists private_participants_retention_idx
  on private_conversation_participants (retain_until) where redacted_at is null;

create table if not exists private_messages (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  conversation_id text not null,
  account_id text not null,
  platform text not null check (platform in ('instagram', 'facebook')),
  connection_mode text not null check (connection_mode in ('facebook_page_messenger', 'instagram_linked_page', 'instagram_login')),
  provider_message_key_hash text not null check (provider_message_key_hash ~ '^[0-9a-f]{64}$'),
  provider_message_key_envelope jsonb not null,
  sender_participant_id text,
  direction text not null check (direction in ('incoming', 'outgoing')),
  kind text not null check (kind in ('text', 'image', 'video', 'audio', 'file', 'share', 'sticker', 'unsupported')),
  body_envelope jsonb,
  body_integrity_key text check (body_integrity_key is null or body_integrity_key ~ '^[0-9a-f]{64}$'),
  attachments_envelope jsonb not null,
  reply_to_message_id text,
  is_echo boolean not null,
  availability text not null check (availability in ('available', 'deleted', 'expired')),
  delivery_state text not null check (delivery_state in ('unknown', 'sent', 'delivered', 'read', 'failed')),
  delivered_at timestamptz,
  read_at timestamptz,
  deleted_at timestamptz,
  provider_created_at timestamptz,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  source text not null check (source in ('webhook', 'reconcile', 'action')),
  observation_kind text not null check (observation_kind in ('message', 'echo', 'deleted', 'delivery', 'read', 'reaction')),
  raw_payload_sha256 text check (raw_payload_sha256 is null or raw_payload_sha256 ~ '^[0-9a-f]{64}$'),
  retain_until timestamptz not null default (now() + interval '90 days'),
  tombstoned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint private_messages_conversation_fk
    foreign key (conversation_id, workspace_id, brand_id, account_id, platform, connection_mode)
    references private_conversations(id, workspace_id, brand_id, account_id, platform, connection_mode) on delete cascade,
  constraint private_messages_sender_fk
    foreign key (sender_participant_id, workspace_id, brand_id, conversation_id, account_id)
    references private_conversation_participants(id, workspace_id, brand_id, conversation_id, account_id) on delete restrict,
  constraint private_messages_reply_fk
    foreign key (reply_to_message_id) references private_messages(id) on delete restrict deferrable initially deferred,
  constraint private_messages_seen_check check (last_seen_at >= first_seen_at),
  constraint private_messages_delete_check check (
    (availability = 'deleted' and deleted_at is not null and body_envelope is null and body_integrity_key is null) or
    (availability <> 'deleted')
  ),
  unique (account_id, provider_message_key_hash),
  unique (id, workspace_id, brand_id, conversation_id),
  unique (id, workspace_id, brand_id, conversation_id, account_id)
);

create index if not exists private_messages_timeline_idx
  on private_messages (workspace_id, brand_id, conversation_id, coalesce(provider_created_at, first_seen_at), id);
create index if not exists private_messages_unread_idx
  on private_messages (workspace_id, brand_id, conversation_id, last_seen_at, id)
  where direction = 'incoming' and availability = 'available';
create index if not exists private_messages_retention_idx
  on private_messages (retain_until) where tombstoned_at is null;

create table if not exists private_conversation_reads (
  workspace_id text not null,
  brand_id text not null,
  conversation_id text not null,
  user_id text not null,
  last_read_message_id text,
  last_read_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (workspace_id, conversation_id, user_id),
  constraint private_reads_conversation_fk
    foreign key (conversation_id, workspace_id, brand_id)
    references private_conversations(id, workspace_id, brand_id) on delete cascade,
  constraint private_reads_member_fk
    foreign key (workspace_id, user_id)
    references workspace_members(workspace_id, user_id) on delete cascade,
  constraint private_reads_message_fk
    foreign key (last_read_message_id, workspace_id, brand_id, conversation_id)
    references private_messages(id, workspace_id, brand_id, conversation_id) on delete set null (last_read_message_id)
);

create table if not exists private_reply_intents (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  conversation_id text not null,
  account_id text not null,
  in_reply_to_message_id text not null,
  body_envelope jsonb,
  body_integrity_key text check (body_integrity_key is null or body_integrity_key ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('draft', 'pending_approval', 'queued', 'processing', 'succeeded', 'failed', 'uncertain', 'cancelled', 'expired')),
  idempotency_key text not null,
  requested_by text not null,
  approved_by text,
  eligibility_at_approval jsonb,
  provider_message_key_hash text check (provider_message_key_hash is null or provider_message_key_hash ~ '^[0-9a-f]{64}$'),
  provider_message_key_envelope jsonb,
  provider_accepted_at timestamptz,
  provider_response_sha256 text check (provider_response_sha256 is null or provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  error_summary text check (error_summary is null or char_length(error_summary) <= 500),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_owner text,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  retain_until timestamptz not null default (now() + interval '90 days'),
  tombstoned_at timestamptz,
  version integer not null check (version > 0),
  constraint private_reply_conversation_fk
    foreign key (conversation_id, workspace_id, brand_id, account_id)
    references private_conversations(id, workspace_id, brand_id, account_id) on delete cascade,
  constraint private_reply_anchor_fk
    foreign key (in_reply_to_message_id, workspace_id, brand_id, conversation_id, account_id)
    references private_messages(id, workspace_id, brand_id, conversation_id, account_id) on delete restrict,
  constraint private_reply_requester_fk
    foreign key (workspace_id, requested_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint private_reply_approver_fk
    foreign key (workspace_id, approved_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint private_reply_lease_check check (
    (status = 'processing' and lease_owner is not null and lease_expires_at is not null) or
    (status <> 'processing' and lease_owner is null and lease_expires_at is null)
  ),
  constraint private_reply_completion_check check (
    (status in ('succeeded', 'failed', 'cancelled', 'expired') and completed_at is not null) or
    (status not in ('succeeded', 'failed', 'cancelled', 'expired') and completed_at is null)
  ),
  constraint private_reply_body_retention_check check (
    (tombstoned_at is null and body_envelope is not null and body_integrity_key is not null) or
    (tombstoned_at is not null and status in ('succeeded', 'failed', 'cancelled', 'expired') and body_envelope is null and body_integrity_key is null)
  ),
  unique (workspace_id, idempotency_key)
);

create index if not exists private_reply_recovery_idx
  on private_reply_intents (status, lease_expires_at, updated_at, id)
  where status in ('queued', 'processing', 'uncertain');
create index if not exists private_reply_retention_idx
  on private_reply_intents (retain_until)
  where status in ('succeeded', 'failed', 'cancelled', 'expired');

create unique index if not exists private_reply_one_provider_write_idx
  on private_reply_intents (workspace_id, conversation_id)
  where status in ('queued', 'processing', 'uncertain');

create table if not exists private_reply_intent_events (
  id text primary key,
  intent_id text not null references private_reply_intents(id) on delete restrict,
  workspace_id text not null,
  brand_id text not null,
  actor_id text not null,
  from_status text,
  to_status text not null,
  version integer not null check (version > 0),
  lease_fence bigint not null default 0,
  detail jsonb not null,
  created_at timestamptz not null,
  unique (intent_id, version)
);

create table if not exists private_conversation_sync_states (
  account_id text primary key,
  workspace_id text not null,
  brand_id text not null,
  platform text not null check (platform in ('instagram', 'facebook')),
  connection_mode text not null check (connection_mode in ('facebook_page_messenger', 'instagram_linked_page', 'instagram_login')),
  cursor_envelope jsonb,
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  next_sync_at timestamptz not null,
  failure_count integer not null default 0 check (failure_count >= 0),
  error_code text,
  error_summary text check (error_summary is null or char_length(error_summary) <= 500),
  lease_owner text,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint private_sync_account_fk
    foreign key (account_id, workspace_id, brand_id, platform)
    references connected_accounts(id, workspace_id, brand_id, platform) on delete cascade,
  constraint private_sync_mode_platform_check check (
    (connection_mode = 'facebook_page_messenger' and platform = 'facebook') or
    (connection_mode in ('instagram_linked_page', 'instagram_login') and platform = 'instagram')
  )
);

create index if not exists private_sync_due_idx
  on private_conversation_sync_states (next_sync_at, lease_expires_at, account_id);

create table if not exists private_message_webhook_receipts (
  id text primary key,
  provider text not null check (provider in ('instagram', 'facebook')),
  connection_mode text not null check (connection_mode in ('facebook_page_messenger', 'instagram_linked_page', 'instagram_login')),
  workspace_id text not null,
  brand_id text not null,
  account_id text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_event_envelope jsonb not null,
  status text not null check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null,
  lease_owner text,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null,
  processed_at timestamptz,
  retain_until timestamptz not null default (now() + interval '30 days'),
  updated_at timestamptz not null default now(),
  constraint private_receipt_account_fk
    foreign key (account_id, workspace_id, brand_id, provider)
    references connected_accounts(id, workspace_id, brand_id, platform) on delete cascade,
  constraint private_receipt_lease_check check (
    (status = 'processing' and lease_owner is not null and lease_expires_at is not null) or
    (status <> 'processing' and lease_owner is null and lease_expires_at is null)
  ),
  unique (provider, connection_mode, account_id, payload_sha256)
);

create index if not exists private_receipt_claim_idx
  on private_message_webhook_receipts (available_at, lease_expires_at, created_at, id)
  where status = 'pending' or status = 'processing';
create index if not exists private_receipt_retention_idx
  on private_message_webhook_receipts (retain_until)
  where status in ('processed', 'failed');

create table if not exists private_retention_tombstones (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  resource_type text not null check (resource_type in ('message', 'participant', 'reply_intent', 'webhook_receipt')),
  resource_id_hash text not null check (resource_id_hash ~ '^[0-9a-f]{64}$'),
  provider_key_hash text check (provider_key_hash is null or provider_key_hash ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason in ('provider_deleted', 'retention_expired', 'user_deleted')),
  deleted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, resource_type, resource_id_hash, reason)
);

create index if not exists private_tombstones_scope_idx
  on private_retention_tombstones (workspace_id, brand_id, deleted_at desc);

create or replace function reject_private_reply_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'private_reply_intent_events is append-only';
end;
$$;

drop trigger if exists private_reply_intent_events_append_only on private_reply_intent_events;
create trigger private_reply_intent_events_append_only
before update or delete on private_reply_intent_events
for each row execute function reject_private_reply_event_mutation();

create or replace function guard_private_message_immutability()
returns trigger language plpgsql as $$
begin
  if row(new.workspace_id, new.brand_id, new.conversation_id, new.account_id, new.platform,
         new.connection_mode, new.provider_message_key_hash, new.provider_message_key_envelope,
         new.sender_participant_id, new.direction, new.kind, new.reply_to_message_id, new.is_echo,
         new.provider_created_at, new.first_seen_at, new.source)
     is distinct from
     row(old.workspace_id, old.brand_id, old.conversation_id, old.account_id, old.platform,
         old.connection_mode, old.provider_message_key_hash, old.provider_message_key_envelope,
         old.sender_participant_id, old.direction, old.kind, old.reply_to_message_id, old.is_echo,
         old.provider_created_at, old.first_seen_at, old.source) then
    raise exception 'private message identity and original content metadata are immutable';
  end if;
  if new.body_envelope is distinct from old.body_envelope and new.body_envelope is not null then
    raise exception 'private message body may only be tombstoned';
  end if;
  if new.body_integrity_key is distinct from old.body_integrity_key and new.body_integrity_key is not null then
    raise exception 'private message body hash may only be tombstoned';
  end if;
  if new.attachments_envelope is distinct from old.attachments_envelope
     and new.availability not in ('deleted', 'expired') then
    raise exception 'private message attachments may only be tombstoned';
  end if;
  return new;
end;
$$;

drop trigger if exists private_messages_immutable on private_messages;
create trigger private_messages_immutable
before update on private_messages
for each row execute function guard_private_message_immutability();

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
    'private_message_new_activity',
    'private_message_reply_failed',
    'private_message_permission_missing',
    'system'
  ));
