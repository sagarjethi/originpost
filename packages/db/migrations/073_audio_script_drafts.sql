-- Script drafts have their own quota and replay ledger, separate from voice/media history.
create table audio_draft_runs (
 id text primary key, workspace_id text not null, brand_id text not null, profile_id text not null,
 idempotency_hash text not null, created_at timestamptz not null, status text not null,
 payload jsonb not null, unique(workspace_id,idempotency_hash),
 foreign key(workspace_id,profile_id) references audio_profiles(workspace_id,id),
 foreign key(workspace_id,brand_id) references brands(workspace_id,id),
 check(status in ('generating','ready','failed'))
);
create index audio_draft_runs_budget on audio_draft_runs(workspace_id,profile_id,created_at);
