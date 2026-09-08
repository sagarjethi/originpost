-- Exact, human-approved Instagram collaborator settings and durable status polling.
-- Raw provider responses and credentials are intentionally excluded.

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'content_draft_revisions_id_workspace_content_unique') then
    alter table content_draft_revisions add constraint content_draft_revisions_id_workspace_content_unique unique (id, workspace_id, content_item_id);
  end if;
end $$;

create table if not exists instagram_collaborator_candidates (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  draft_id text not null,
  draft_sha256 text not null check (draft_sha256 ~ '^[0-9a-f]{64}$'),
  account_id text not null,
  approved_settings_sha256 text not null check (approved_settings_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('pending_approval','approved')),
  approval_id text,
  requested_by text not null,
  approved_by text,
  requested_at timestamptz not null,
  approved_at timestamptz,
  payload jsonb not null,
  constraint instagram_collab_candidate_content_fk foreign key (content_item_id, workspace_id, brand_id) references content_items(id, workspace_id, brand_id) on delete restrict,
  constraint instagram_collab_candidate_draft_fk foreign key (draft_id, workspace_id, content_item_id) references content_draft_revisions(id, workspace_id, content_item_id) on delete restrict,
  constraint instagram_collab_candidate_account_fk foreign key (account_id, workspace_id, brand_id) references connected_accounts(id, workspace_id, brand_id) on delete restrict,
  -- Actor IDs remain immutable audit evidence. Single-user deployments may use
  -- a configured trusted owner without a session membership row, so these are
  -- deliberately not foreign keys.
  constraint instagram_collab_candidate_approval_shape check ((status = 'pending_approval' and approval_id is null and approved_by is null and approved_at is null) or (status = 'approved' and approval_id is not null and approved_by is not null and approved_at is not null)),
  unique (id, workspace_id, content_item_id),
  unique (workspace_id, approval_id)
);

create index if not exists instagram_collab_candidates_content_idx on instagram_collaborator_candidates (workspace_id, content_item_id, requested_at desc);

create table if not exists instagram_collaborator_polls (
  proof_id text primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  account_id text not null,
  external_media_id text not null,
  requested_usernames_sha256 text not null check (requested_usernames_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('pending','processing','complete','unavailable','expired')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts between 1 and 100),
  next_attempt_at timestamptz not null,
  expires_at timestamptz not null,
  availability text,
  error_summary text check (error_summary is null or char_length(error_summary) <= 500),
  captured_at timestamptz,
  latest_read_complete boolean,
  raw_response_sha256 text check (raw_response_sha256 is null or raw_response_sha256 ~ '^[0-9a-f]{64}$'),
  active_claim_id text,
  claim_lease_expires_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint instagram_collab_poll_proof_fk foreign key (proof_id, workspace_id, content_item_id) references publish_proofs(id, workspace_id, content_item_id) on delete restrict,
  constraint instagram_collab_poll_content_fk foreign key (content_item_id, workspace_id, brand_id) references content_items(id, workspace_id, brand_id) on delete restrict,
  constraint instagram_collab_poll_account_fk foreign key (account_id, workspace_id, brand_id) references connected_accounts(id, workspace_id, brand_id) on delete restrict,
  constraint instagram_collab_poll_claim_shape check ((active_claim_id is null) = (claim_lease_expires_at is null)),
  unique (proof_id, workspace_id, content_item_id),
  constraint instagram_collab_poll_full_lineage_unique unique
    (proof_id, workspace_id, brand_id, content_item_id, account_id, external_media_id, requested_usernames_sha256)
);

create index if not exists instagram_collab_polls_due_idx on instagram_collaborator_polls (next_attempt_at, proof_id)
  where status in ('pending','processing','unavailable');

create table if not exists instagram_collaborator_status_snapshots (
  id bigserial primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  proof_id text not null,
  account_id text not null,
  external_media_id text not null,
  requested_usernames_sha256 text not null check (requested_usernames_sha256 ~ '^[0-9a-f]{64}$'),
  username text not null,
  status text not null check (status in ('pending','accepted','not_returned','unavailable')),
  captured_at timestamptz not null,
  provider_response_sha256 text not null check (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  constraint instagram_collab_snapshot_poll_fk foreign key (proof_id, workspace_id, content_item_id) references instagram_collaborator_polls(proof_id, workspace_id, content_item_id) on delete restrict,
  constraint instagram_collab_snapshot_full_lineage_fk foreign key
    (proof_id, workspace_id, brand_id, content_item_id, account_id, external_media_id, requested_usernames_sha256)
    references instagram_collaborator_polls
    (proof_id, workspace_id, brand_id, content_item_id, account_id, external_media_id, requested_usernames_sha256)
    on delete restrict,
  constraint instagram_collab_snapshot_payload_lineage check (
    payload->>'workspaceId' = workspace_id and payload->>'brandId' = brand_id
    and payload->>'contentItemId' = content_item_id and payload->>'proofId' = proof_id
    and payload->>'accountId' = account_id and payload->>'externalMediaId' = external_media_id
    and payload->>'requestedUsernamesSha256' = requested_usernames_sha256
    and payload->>'username' = username and payload->>'status' = status
  ),
  unique (workspace_id, proof_id, username)
);

create index if not exists instagram_collab_snapshots_lineage_idx on instagram_collaborator_status_snapshots (workspace_id, content_item_id, proof_id, username);

create or replace function originpost_block_instagram_collaborator_candidate_identity_mutation() returns trigger language plpgsql as $$
begin
  if new.workspace_id <> old.workspace_id or new.brand_id <> old.brand_id or new.content_item_id <> old.content_item_id
     or new.draft_id <> old.draft_id or new.draft_sha256 <> old.draft_sha256 or new.account_id <> old.account_id
     or new.approved_settings_sha256 <> old.approved_settings_sha256 or new.requested_by <> old.requested_by
     or new.requested_at <> old.requested_at or new.payload->'settings' is distinct from old.payload->'settings' then
    raise exception 'instagram collaborator candidate identity is immutable';
  end if;
  return new;
end $$;

drop trigger if exists instagram_collab_candidate_identity_immutable on instagram_collaborator_candidates;
create trigger instagram_collab_candidate_identity_immutable before update on instagram_collaborator_candidates
for each row execute function originpost_block_instagram_collaborator_candidate_identity_mutation();
