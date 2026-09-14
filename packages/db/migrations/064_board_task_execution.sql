alter table board_hermes_plugins add column if not exists kanban_ref text;

update board_hermes_plugins
set kanban_ref = 'opk_' || substr(md5(workspace_id || chr(31) || brand_id || chr(31) || board_id || chr(31) || profile_ref), 1, 24)
where kanban_ref is null;

alter table board_hermes_plugins alter column kanban_ref set not null;
alter table board_hermes_plugins drop constraint if exists board_hermes_plugins_kanban_ref_check;
alter table board_hermes_plugins add constraint board_hermes_plugins_kanban_ref_check check (kanban_ref ~ '^opk_[a-f0-9]{24}$');
create unique index if not exists board_hermes_plugins_kanban_ref_unique on board_hermes_plugins(kanban_ref);

update agent_boards board
set payload = jsonb_set(board.payload, '{hermesBoardRef}', to_jsonb(plugin.kanban_ref), true)
from board_hermes_plugins plugin
where plugin.workspace_id=board.workspace_id and plugin.brand_id=board.brand_id and plugin.board_id=board.id
  and not board.payload ? 'hermesBoardRef';

alter table agent_board_tasks drop constraint if exists agent_board_tasks_assignee_check;
alter table agent_board_tasks add constraint agent_board_tasks_assignee_check check (assignee in ('team','board-agent'));

create table if not exists board_task_executions (
  id text primary key check (id ~ '^board_task_execution_[a-f0-9-]{36}$'),
  workspace_id text not null,
  brand_id text not null,
  board_id text not null,
  task_id text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('queued','running','succeeded','failed','uncertain')),
  configuration_epoch integer not null check (configuration_epoch > 0),
  capability_epoch integer not null check (capability_epoch > 0),
  task_version integer not null check (task_version > 0),
  idempotency_key_sha256 text not null check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  create_fingerprint text not null check (create_fingerprint ~ '^[a-f0-9]{64}$'),
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  claim_id text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  model text check (model is null or (length(model) between 1 and 200)),
  result_text text check (result_text is null or length(result_text) between 1 and 100000),
  response_sha256 text check (response_sha256 is null or response_sha256 ~ '^[a-f0-9]{64}$'),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  error_code text check (error_code is null or length(error_code) between 1 and 120),
  error_summary text check (error_summary is null or length(error_summary) between 1 and 2000),
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  payload jsonb not null,
  constraint board_task_executions_task_fk foreign key (workspace_id,brand_id,board_id,task_id)
    references agent_board_tasks(workspace_id,brand_id,board_id,id) on delete restrict,
  constraint board_task_executions_idempotency_unique unique (workspace_id,brand_id,board_id,task_id,idempotency_key_sha256),
  constraint board_task_executions_state_shape check (
    (status='queued' and claim_id is null and lease_expires_at is null and started_at is null and completed_at is null and model is null and result_text is null and response_sha256 is null and error_code is null and error_summary is null)
    or (status='running' and claim_id is not null and length(claim_id) between 16 and 120 and lease_expires_at is not null and started_at is not null and lease_expires_at>started_at and completed_at is null and model is null and result_text is null and response_sha256 is null and error_code is null and error_summary is null)
    or (status='succeeded' and claim_id is null and lease_expires_at is null and started_at is not null and completed_at is not null and completed_at>=started_at and model is not null and result_text is not null and response_sha256 is not null and error_code is null and error_summary is null)
    or (status in ('failed','uncertain') and claim_id is null and lease_expires_at is null and started_at is not null and completed_at is not null and completed_at>=started_at and error_code is not null and error_summary is not null)
  ),
  constraint board_task_executions_payload_shape check (coalesce(
    jsonb_typeof(payload)='object'
    and payload->>'id'=id
    and payload->>'workspaceId'=workspace_id
    and payload->>'brandId'=brand_id
    and payload->>'boardId'=board_id
    and payload->>'taskId'=task_id
    and (payload->>'version')::integer=version
    and payload->>'status'=status
    and (payload->>'configurationEpoch')::integer=configuration_epoch
    and (payload->>'capabilityEpoch')::integer=capability_epoch
    and (payload->>'taskVersion')::integer=task_version
    and payload->>'idempotencyKeySha256'=idempotency_key_sha256
    and payload->>'createFingerprint'=create_fingerprint
    and payload->>'requestSha256'=request_sha256,
    false
  ))
);

create index if not exists board_task_executions_task_history_idx
  on board_task_executions(workspace_id,brand_id,board_id,task_id,created_at desc,id desc);
create index if not exists board_task_executions_recovery_idx
  on board_task_executions(status,lease_expires_at)
  where status='running';
create index if not exists board_task_executions_queued_recovery_idx
  on board_task_executions(created_at)
  where status='queued';
