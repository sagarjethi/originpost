alter table board_task_executions
  add constraint board_task_executions_scope_id_unique unique (workspace_id,brand_id,board_id,task_id,id);

create table board_task_content_handoffs (
  id text primary key check (id ~ '^board_task_content_handoff_[a-f0-9-]{36}$'),
  workspace_id text not null,
  brand_id text not null,
  board_id text not null,
  task_id text not null,
  execution_id text not null,
  content_item_id text not null,
  task_version integer not null check (task_version > 0),
  execution_version integer not null check (execution_version > 0),
  response_sha256 text not null check (response_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key_sha256 text not null check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  create_fingerprint text not null check (create_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by text not null,
  created_at timestamptz not null,
  payload jsonb not null,
  constraint board_task_content_handoffs_task_fk foreign key (workspace_id,brand_id,board_id,task_id)
    references agent_board_tasks(workspace_id,brand_id,board_id,id) on delete restrict,
  constraint board_task_content_handoffs_execution_fk foreign key (workspace_id,brand_id,board_id,task_id,execution_id)
    references board_task_executions(workspace_id,brand_id,board_id,task_id,id) on delete restrict,
  constraint board_task_content_handoffs_content_fk foreign key (content_item_id,workspace_id,brand_id)
    references content_items(id,workspace_id,brand_id) on delete restrict,
  constraint board_task_content_handoffs_execution_unique unique (execution_id),
  constraint board_task_content_handoffs_content_unique unique (content_item_id),
  constraint board_task_content_handoffs_idempotency_unique unique (workspace_id,brand_id,board_id,task_id,idempotency_key_sha256),
  constraint board_task_content_handoffs_payload_shape check (coalesce(
    jsonb_typeof(payload)='object'
    and payload->>'id'=id
    and payload->>'workspaceId'=workspace_id
    and payload->>'brandId'=brand_id
    and payload->>'boardId'=board_id
    and payload->>'taskId'=task_id
    and payload->>'executionId'=execution_id
    and payload->>'contentItemId'=content_item_id
    and (payload->>'taskVersion')::integer=task_version
    and (payload->>'executionVersion')::integer=execution_version
    and payload->>'responseSha256'=response_sha256
    and payload->>'idempotencyKeySha256'=idempotency_key_sha256
    and payload->>'createFingerprint'=create_fingerprint
    and payload->>'createdBy'=created_by
    and (payload->>'createdAt')::timestamptz=created_at,
    false
  ))
);

create index board_task_content_handoffs_task_history_idx
  on board_task_content_handoffs(workspace_id,brand_id,board_id,task_id,created_at desc,id desc);
