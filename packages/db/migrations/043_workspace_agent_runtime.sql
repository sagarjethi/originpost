create table if not exists agent_runtime_profiles (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  version integer not null check (version > 0),
  name text not null,
  preset text not null check (preset in ('openai','openrouter','ollama','custom')),
  base_url text not null,
  text_model text not null,
  credential_configured boolean not null,
  status text not null check (status in ('unverified','healthy','error','disabled')),
  credential_key_version text,
  credential_algorithm text,
  credential_iv text,
  credential_auth_tag text,
  credential_ciphertext text,
  payload jsonb not null,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint agent_runtime_credential_shape check (
    (credential_configured and credential_key_version is not null and credential_algorithm='aes-256-gcm' and credential_iv is not null and credential_auth_tag is not null and credential_ciphertext is not null)
    or
    (not credential_configured and credential_key_version is null and credential_algorithm is null and credential_iv is null and credential_auth_tag is null and credential_ciphertext is null)
  ),
  unique (workspace_id,id)
);
create index if not exists agent_runtime_profiles_workspace_idx on agent_runtime_profiles(workspace_id,status,name);

create table if not exists agent_runtime_assignments (
  workspace_id text not null,
  brand_id text not null,
  profile_id text not null,
  assigned_by text not null,
  assigned_at timestamptz not null,
  primary key (workspace_id,brand_id),
  constraint agent_runtime_assignment_brand_fk foreign key (workspace_id,brand_id) references brands(workspace_id,id) on delete cascade,
  constraint agent_runtime_assignment_profile_fk foreign key (workspace_id,profile_id) references agent_runtime_profiles(workspace_id,id) on delete cascade
);
create index if not exists agent_runtime_assignments_profile_idx on agent_runtime_assignments(workspace_id,profile_id);

create table if not exists agent_run_ledger (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  profile_id text not null,
  content_item_id text,
  feature text not null check (feature='draft_assist'),
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
  constraint agent_run_brand_fk foreign key (workspace_id,brand_id) references brands(workspace_id,id) on delete restrict,
  constraint agent_run_profile_fk foreign key (workspace_id,profile_id) references agent_runtime_profiles(workspace_id,id) on delete restrict,
  constraint agent_run_content_fk foreign key (content_item_id,workspace_id,brand_id) references content_items(id,workspace_id,brand_id) on delete restrict
);
create index if not exists agent_run_ledger_workspace_idx on agent_run_ledger(workspace_id,profile_id,created_at desc);
