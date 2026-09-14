create table if not exists agent_board_tasks (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  board_id text not null,
  version integer not null check (version > 0),
  title text not null,
  status text not null check (status in ('triage','todo','ready','running','blocked','review','done','archived')),
  priority text not null check (priority in ('low','normal','high','urgent')),
  assignee text not null check (assignee = 'team'),
  idempotency_key_sha256 text not null check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  create_fingerprint text not null check (create_fingerprint ~ '^[a-f0-9]{64}$'),
  payload jsonb not null,
  created_by text not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint agent_board_tasks_board_fk foreign key (workspace_id,brand_id,board_id) references agent_boards(workspace_id,brand_id,id) on delete restrict,
  constraint agent_board_tasks_scope_unique unique (workspace_id,brand_id,board_id,id),
  constraint agent_board_tasks_idempotency_unique unique (workspace_id,brand_id,board_id,idempotency_key_sha256)
);

create index if not exists agent_board_tasks_board_status_idx on agent_board_tasks(workspace_id,brand_id,board_id,status,updated_at desc);

create table if not exists agent_board_task_links (
  workspace_id text not null,
  brand_id text not null,
  board_id text not null,
  parent_task_id text not null,
  child_task_id text not null,
  created_at timestamptz not null,
  primary key (workspace_id,brand_id,board_id,parent_task_id,child_task_id),
  constraint agent_board_task_links_not_self check (parent_task_id <> child_task_id),
  constraint agent_board_task_links_parent_fk foreign key (workspace_id,brand_id,board_id,parent_task_id) references agent_board_tasks(workspace_id,brand_id,board_id,id) on delete restrict,
  constraint agent_board_task_links_child_fk foreign key (workspace_id,brand_id,board_id,child_task_id) references agent_board_tasks(workspace_id,brand_id,board_id,id) on delete restrict
);

create index if not exists agent_board_task_links_child_idx on agent_board_task_links(workspace_id,brand_id,board_id,child_task_id);

create table if not exists agent_board_task_comments (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  board_id text not null,
  task_id text not null,
  body text not null,
  idempotency_key_sha256 text not null check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  create_fingerprint text not null check (create_fingerprint ~ '^[a-f0-9]{64}$'),
  author_id text not null,
  author_name text not null,
  created_at timestamptz not null,
  payload jsonb not null,
  constraint agent_board_task_comments_task_fk foreign key (workspace_id,brand_id,board_id,task_id) references agent_board_tasks(workspace_id,brand_id,board_id,id) on delete restrict,
  constraint agent_board_task_comments_idempotency_unique unique (workspace_id,brand_id,board_id,task_id,idempotency_key_sha256)
);

create index if not exists agent_board_task_comments_thread_idx on agent_board_task_comments(workspace_id,brand_id,board_id,task_id,created_at,id);
