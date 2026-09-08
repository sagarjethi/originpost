create table if not exists account_posting_queue_profiles (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  connected_account_id text not null,
  platform text not null check (platform in ('instagram','facebook','youtube')),
  enabled boolean not null,
  timezone text not null check (length(timezone) between 1 and 100),
  weekly_slots jsonb not null,
  version integer not null check (version > 0),
  payload jsonb not null,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint posting_queue_profile_account_fk foreign key (connected_account_id,workspace_id,brand_id) references connected_accounts(id,workspace_id,brand_id) on delete restrict,
  unique (workspace_id,brand_id,connected_account_id),
  unique (id,workspace_id,brand_id,connected_account_id)
);

create table if not exists posting_queue_reservations (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  profile_id text not null,
  profile_version integer not null check (profile_version > 0),
  connected_account_id text not null,
  content_item_id text not null,
  target_id text not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  scheduled_for timestamptz not null,
  local_date date not null,
  local_time time not null,
  timezone text not null,
  utc_offset text not null check (utc_offset ~ '^[+-][0-9]{2}:[0-9]{2}$'),
  created_by text not null,
  created_at timestamptz not null,
  released_at timestamptz,
  released_by text,
  payload jsonb not null,
  constraint posting_queue_reservation_profile_fk foreign key (profile_id,workspace_id,brand_id,connected_account_id) references account_posting_queue_profiles(id,workspace_id,brand_id,connected_account_id) on delete restrict,
  constraint posting_queue_reservation_content_fk foreign key (content_item_id,workspace_id,brand_id) references content_items(id,workspace_id,brand_id) on delete restrict,
  constraint posting_queue_reservation_target_fk foreign key (target_id,workspace_id,content_item_id) references publish_targets(id,workspace_id,content_item_id) on delete restrict deferrable initially deferred,
  constraint posting_queue_release_pair_check check ((released_at is null) = (released_by is null)),
  unique (workspace_id,idempotency_key),
  unique (id,workspace_id)
);

create unique index if not exists posting_queue_one_active_slot_idx
  on posting_queue_reservations(workspace_id,profile_id,scheduled_for)
  where released_at is null;
create unique index if not exists posting_queue_one_target_idx
  on posting_queue_reservations(workspace_id,target_id);
create index if not exists posting_queue_account_schedule_idx
  on posting_queue_reservations(workspace_id,connected_account_id,scheduled_for)
  where released_at is null;

