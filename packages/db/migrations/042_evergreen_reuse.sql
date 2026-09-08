create table if not exists evergreen_entries (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text not null references brands(id) on delete restrict,
  source_content_item_id text not null,
  source_proof_id text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('active','paused','completed')),
  mode text not null check (mode in ('review_first','auto_schedule')),
  platform text not null check (platform in ('instagram','facebook','youtube')),
  account_id text not null,
  next_publish_at timestamptz not null,
  end_at timestamptz not null,
  occurrence_count integer not null default 0 check (occurrence_count >= 0),
  max_occurrences integer not null check (max_occurrences between 1 and 52),
  claim_id text,
  claim_owner text,
  claim_lease_expires_at timestamptz,
  pending_occurrence_no integer,
  pending_content_item_id text,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint evergreen_source_fk foreign key (source_content_item_id, workspace_id, brand_id) references content_items(id,workspace_id,brand_id) on delete restrict,
  constraint evergreen_account_fk foreign key (account_id, workspace_id, brand_id) references connected_accounts(id,workspace_id,brand_id) on delete restrict,
  constraint evergreen_claim_shape check ((claim_id is null and claim_owner is null and claim_lease_expires_at is null and pending_occurrence_no is null and pending_content_item_id is null) or (claim_id is not null and claim_owner is not null and claim_lease_expires_at is not null and pending_occurrence_no is not null and pending_content_item_id is not null))
);
create index if not exists evergreen_due_idx on evergreen_entries (status,next_publish_at) where status='active';
create index if not exists evergreen_workspace_idx on evergreen_entries (workspace_id,brand_id,status,next_publish_at);
create unique index if not exists evergreen_active_proof_unique on evergreen_entries (workspace_id,source_proof_id) where status in ('active','paused');

create table if not exists evergreen_occurrences (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text not null references brands(id) on delete restrict,
  entry_id text not null references evergreen_entries(id) on delete cascade,
  occurrence_no integer not null check (occurrence_no > 0),
  content_item_id text,
  target_id text,
  status text not null check (status in ('processing','review_ready','scheduled','published','action_required','failed')),
  scheduled_for timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint evergreen_occurrence_content_fk foreign key (content_item_id,workspace_id,brand_id) references content_items(id,workspace_id,brand_id) on delete restrict,
  unique (entry_id,occurrence_no)
);
create index if not exists evergreen_occurrence_entry_idx on evergreen_occurrences (workspace_id,entry_id,occurrence_no desc);
create unique index if not exists evergreen_occurrence_content_unique on evergreen_occurrences (workspace_id,content_item_id) where content_item_id is not null;
