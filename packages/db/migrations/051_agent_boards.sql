create table if not exists agent_boards (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  version integer not null check (version > 0),
  name text not null,
  slug text not null,
  purpose text not null,
  status text not null check (status in ('provisioning','setup_required','ready','attention','archived')),
  plugin_id text not null check (plugin_id = 'org.originpost.hermes-boards'),
  payload jsonb not null,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint agent_boards_brand_fk foreign key (workspace_id,brand_id) references brands(workspace_id,id) on delete restrict,
  constraint agent_boards_scope_unique unique (workspace_id,brand_id,id)
);
create unique index if not exists agent_boards_active_slug_unique on agent_boards(workspace_id,brand_id,slug) where status <> 'archived';
create index if not exists agent_boards_brand_updated_idx on agent_boards(workspace_id,brand_id,updated_at desc);

create table if not exists board_hermes_plugins (
  board_id text primary key,
  workspace_id text not null,
  brand_id text not null,
  plugin_id text not null check (plugin_id = 'org.originpost.hermes-boards'),
  profile_ref text not null check (profile_ref ~ '^opb_[a-f0-9]{24}$'),
  state text not null check (state in ('provisioning','setup_required','ready','attention','archived')),
  desired_configuration_epoch integer not null check (desired_configuration_epoch > 0),
  observed_configuration_epoch integer not null check (observed_configuration_epoch >= 0 and observed_configuration_epoch <= desired_configuration_epoch),
  capability_epoch integer not null check (capability_epoch > 0),
  memory_isolation text not null check (memory_isolation = 'hermes-profile'),
  memory_write_approval boolean not null check (memory_write_approval),
  skill_write_approval boolean not null check (skill_write_approval),
  last_checked_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null,
  constraint board_hermes_plugins_board_fk foreign key (workspace_id,brand_id,board_id) references agent_boards(workspace_id,brand_id,id) on delete restrict,
  unique (workspace_id,profile_ref)
);
create index if not exists board_hermes_plugins_pending_idx on board_hermes_plugins(updated_at) where state in ('provisioning','attention');

create table if not exists board_hermes_skill_grants (
  board_id text not null,
  workspace_id text not null,
  brand_id text not null,
  skill_name text not null,
  desired_enabled boolean not null,
  observed_enabled boolean not null,
  trust text not null check (trust = 'operator-approved'),
  updated_at timestamptz not null,
  primary key (board_id,skill_name),
  constraint board_hermes_skill_grants_board_fk foreign key (workspace_id,brand_id,board_id) references agent_boards(workspace_id,brand_id,id) on delete restrict
);

create table if not exists board_agent_run_ledger (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  board_id text not null,
  configuration_epoch integer not null check (configuration_epoch > 0),
  model text not null,
  status text not null check (status in ('succeeded','failed')),
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  response_sha256 text check (response_sha256 is null or response_sha256 ~ '^[a-f0-9]{64}$'),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  error_code text,
  created_by text not null,
  created_at timestamptz not null,
  payload jsonb not null,
  constraint board_agent_run_board_fk foreign key (workspace_id,brand_id,board_id) references agent_boards(workspace_id,brand_id,id) on delete restrict
);
create index if not exists board_agent_run_recent_idx on board_agent_run_ledger(workspace_id,board_id,created_at desc);
