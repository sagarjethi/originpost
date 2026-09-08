-- Durable, exact-lineage remote correction workflow. Provider mutation receipts and
-- removal proofs contain hashes only; provider tokens and raw responses never enter these tables.

create table if not exists remote_correction_operations (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  publish_proof_id text not null,
  account_id text not null,
  platform text not null check (platform in ('instagram', 'facebook', 'youtube')),
  external_post_id text not null,
  immutable_intent_sha256 text not null check (immutable_intent_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('pending_approval','approved','pre_write','finalizing','provider_confirmed','reconciled','manual_action_required','operator_confirmed','uncertain','rejected','cancelled')),
  requested_by text not null,
  approved_by text,
  active_claim_id text,
  claim_lease_expires_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint remote_correction_brand_fk foreign key (workspace_id, brand_id) references brands(workspace_id, id) on delete restrict,
  constraint remote_correction_content_fk foreign key (content_item_id, workspace_id, brand_id) references content_items(id, workspace_id, brand_id) on delete restrict,
  constraint remote_correction_proof_fk foreign key (publish_proof_id, workspace_id, content_item_id) references publish_proofs(id, workspace_id, content_item_id) on delete restrict,
  constraint remote_correction_account_fk foreign key (account_id, workspace_id, brand_id) references connected_accounts(id, workspace_id, brand_id) on delete restrict,
  constraint remote_correction_requester_fk foreign key (workspace_id, requested_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint remote_correction_approver_fk foreign key (workspace_id, approved_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint remote_correction_claim_check check ((active_claim_id is null) = (claim_lease_expires_at is null)),
  unique (workspace_id, immutable_intent_sha256),
  unique (id, workspace_id)
);

create index if not exists remote_correction_recovery_idx on remote_correction_operations (status, updated_at, id)
  where status in ('approved','pre_write','finalizing','uncertain');
create index if not exists remote_correction_content_idx on remote_correction_operations (workspace_id, content_item_id, created_at desc);

create table if not exists remote_correction_attempts (
  id text primary key,
  workspace_id text not null,
  operation_id text not null,
  kind text not null check (kind in ('execute','reconcile')),
  status text not null check (status in ('started','completed','failed')),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text check (response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$'),
  error_code text,
  error_summary text check (error_summary is null or char_length(error_summary) <= 500),
  started_at timestamptz not null,
  completed_at timestamptz,
  constraint remote_correction_attempt_operation_fk foreign key (operation_id, workspace_id) references remote_correction_operations(id, workspace_id) on delete restrict
);

create index if not exists remote_correction_attempt_operation_idx on remote_correction_attempts (workspace_id, operation_id, started_at, id);

create table if not exists removal_proofs (
  id text primary key,
  workspace_id text not null,
  operation_id text not null,
  content_item_id text not null,
  publish_proof_id text not null,
  account_id text not null,
  external_post_id text not null,
  evidence_grade text not null check (evidence_grade in ('provider_confirmed','provider_reconciled','operator_attested')),
  previous_proof_sha256 text not null check (previous_proof_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_sha256 text not null check (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null,
  constraint removal_proof_operation_fk foreign key (operation_id, workspace_id) references remote_correction_operations(id, workspace_id) on delete restrict,
  constraint removal_proof_publish_fk foreign key (publish_proof_id, workspace_id, content_item_id) references publish_proofs(id, workspace_id, content_item_id) on delete restrict,
  unique (operation_id),
  unique (workspace_id, canonical_sha256)
);

create index if not exists removal_proof_chain_idx on removal_proofs (workspace_id, account_id, external_post_id, created_at, id);

create or replace function originpost_block_removal_proof_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'removal proofs are append-only';
end $$;

drop trigger if exists removal_proofs_append_only on removal_proofs;
create trigger removal_proofs_append_only before update or delete on removal_proofs
for each row execute function originpost_block_removal_proof_mutation();
