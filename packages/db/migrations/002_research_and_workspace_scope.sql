alter table source_evidence add column if not exists workspace_id text;
update source_evidence source
set workspace_id = item.workspace_id
from content_items item
where source.content_item_id = item.id and source.workspace_id is null;
alter table source_evidence alter column workspace_id set not null;

alter table approvals add column if not exists workspace_id text;
update approvals approval
set workspace_id = item.workspace_id
from content_items item
where approval.content_item_id = item.id and approval.workspace_id is null;
alter table approvals alter column workspace_id set not null;

alter table publish_targets add column if not exists workspace_id text;
update publish_targets target
set workspace_id = item.workspace_id
from content_items item
where target.content_item_id = item.id and target.workspace_id is null;
alter table publish_targets alter column workspace_id set not null;

alter table publish_proofs add column if not exists workspace_id text;
update publish_proofs proof
set workspace_id = item.workspace_id
from content_items item
where proof.content_item_id = item.id and proof.workspace_id is null;
alter table publish_proofs alter column workspace_id set not null;

create table if not exists research_runs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text not null references content_items(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  query text not null,
  provider text,
  created_at timestamptz not null,
  completed_at timestamptz,
  payload jsonb not null
);

create table if not exists content_claims (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  content_item_id text not null references content_items(id) on delete cascade,
  status text not null check (status in ('unverified', 'supported', 'disputed', 'rejected')),
  claim_text text not null,
  payload jsonb not null
);

create index if not exists source_evidence_workspace_item_idx
  on source_evidence (workspace_id, content_item_id);
create index if not exists approvals_workspace_item_idx
  on approvals (workspace_id, content_item_id);
create index if not exists publish_targets_workspace_status_schedule_idx
  on publish_targets (workspace_id, status, scheduled_for);
create index if not exists publish_proofs_workspace_item_idx
  on publish_proofs (workspace_id, content_item_id);
create index if not exists research_runs_workspace_item_created_idx
  on research_runs (workspace_id, content_item_id, created_at desc);
create index if not exists content_claims_workspace_item_status_idx
  on content_claims (workspace_id, content_item_id, status);
create index if not exists audit_events_workspace_content_created_idx
  on audit_events (workspace_id, content_item_id, created_at asc);
