-- Serialize provider writes per publish target and persist the ambiguous window
-- before an Instagram container request leaves OriginPost.
alter table provider_publish_operations
  add column if not exists claim_owner text,
  add column if not exists claim_expires_at timestamptz;

alter table provider_publish_operations
  drop constraint if exists provider_publish_operations_status_check;

alter table provider_publish_operations
  add constraint provider_publish_operations_status_check
  check (status in ('creating', 'processing', 'ready', 'finalizing', 'published', 'uncertain', 'failed'));

create index if not exists provider_publish_operations_claim_idx
  on provider_publish_operations (claim_expires_at, workspace_id, target_id)
  where claim_owner is not null;
