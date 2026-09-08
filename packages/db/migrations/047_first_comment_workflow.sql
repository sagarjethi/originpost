-- Governed first comments are independent post-publication writes. They bind to
-- one exact target/draft/account and, before execution, one immutable Publish Proof.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'publish_targets_id_workspace_content_unique') then
    alter table publish_targets add constraint publish_targets_id_workspace_content_unique
      unique (id, workspace_id, content_item_id);
  end if;
end $$;

create table if not exists first_comment_intents (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  target_id text not null,
  draft_id text not null,
  draft_sha256 text not null check (draft_sha256 ~ '^[0-9a-f]{64}$'),
  platform text not null check (platform in ('instagram','facebook')),
  account_id text not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  immutable_intent_sha256 text not null check (immutable_intent_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('draft','pending_approval','approved','queued','processing','succeeded','failed','uncertain','cancelled')),
  execution_mode text not null check (execution_mode in ('write','reconcile')),
  version integer not null check (version > 0),
  requested_by text not null,
  approved_by text,
  publish_proof_id text,
  external_post_id text,
  provider_comment_id text,
  provider_accepted_at timestamptz,
  provider_response_sha256 text check (provider_response_sha256 is null or provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  claim_owner text,
  claim_expires_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint first_comment_brand_fk foreign key (workspace_id,brand_id) references brands(workspace_id,id) on delete restrict,
  constraint first_comment_content_fk foreign key (content_item_id,workspace_id,brand_id) references content_items(id,workspace_id,brand_id) on delete restrict,
  constraint first_comment_target_fk foreign key (target_id,workspace_id,content_item_id) references publish_targets(id,workspace_id,content_item_id) on delete no action deferrable initially deferred,
  constraint first_comment_account_fk foreign key (account_id,workspace_id,brand_id) references connected_accounts(id,workspace_id,brand_id) on delete restrict,
  constraint first_comment_publish_proof_fk foreign key (publish_proof_id,workspace_id,content_item_id) references publish_proofs(id,workspace_id,content_item_id) on delete restrict,
  constraint first_comment_claim_check check ((claim_owner is null) = (claim_expires_at is null)),
  constraint first_comment_proof_lineage_check check ((publish_proof_id is null) = (external_post_id is null)),
  unique (id,workspace_id),
  unique (workspace_id,immutable_intent_sha256)
);

create unique index if not exists first_comment_one_active_target_idx on first_comment_intents(workspace_id,target_id)
  where status not in ('cancelled','failed');
create index if not exists first_comment_content_idx on first_comment_intents(workspace_id,content_item_id,created_at desc);
create index if not exists first_comment_recovery_idx on first_comment_intents(status,claim_expires_at,updated_at,id)
  where status in ('approved','queued','processing','uncertain');

create table if not exists first_comment_proofs (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  content_item_id text not null,
  intent_id text not null,
  publish_proof_id text not null,
  target_id text not null,
  account_id text not null,
  external_post_id text not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_grade text not null check (evidence_grade in ('provider_confirmed','provider_reconciled','operator_attested')),
  canonical_sha256 text not null check (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null,
  constraint first_comment_proof_intent_fk foreign key (intent_id,workspace_id) references first_comment_intents(id,workspace_id) on delete restrict,
  constraint first_comment_proof_publish_fk foreign key (publish_proof_id,workspace_id,content_item_id) references publish_proofs(id,workspace_id,content_item_id) on delete restrict,
  constraint first_comment_proof_brand_fk foreign key (workspace_id,brand_id) references brands(workspace_id,id) on delete restrict,
  constraint first_comment_proof_account_fk foreign key (account_id,workspace_id,brand_id) references connected_accounts(id,workspace_id,brand_id) on delete restrict,
  unique (intent_id),
  unique (workspace_id,canonical_sha256)
);

create or replace function originpost_block_first_comment_proof_mutation() returns trigger language plpgsql as $$
begin raise exception 'first comment proofs are append-only'; end $$;
drop trigger if exists first_comment_proofs_append_only on first_comment_proofs;
create trigger first_comment_proofs_append_only before update or delete on first_comment_proofs
for each row execute function originpost_block_first_comment_proof_mutation();
