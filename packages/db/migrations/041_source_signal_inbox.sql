create table if not exists source_signals (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text not null references brands(id) on delete restrict,
  monitor_id text not null references monitor_rules(id) on delete cascade,
  monitor_run_id text not null references monitor_runs(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  state text not null check (state in ('new','saving','saved','dismissed')),
  urgency text not null check (urgency in ('low','normal','high')),
  score integer not null check (score between 0 and 100),
  event_fingerprint text not null check (event_fingerprint ~ '^[0-9a-f]{64}$'),
  title text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  content_item_id text,
  pending_content_item_id text,
  save_claim_id text,
  save_lease_expires_at timestamptz,
  payload jsonb not null,
  constraint source_signals_content_fk foreign key (content_item_id, workspace_id, brand_id)
    references content_items(id, workspace_id, brand_id) on delete restrict,
  constraint source_signals_state_shape check (
    (state = 'saving' and content_item_id is null and pending_content_item_id is not null and save_claim_id is not null and save_lease_expires_at is not null)
    or (state = 'saved' and content_item_id is not null and pending_content_item_id is null and save_claim_id is null and save_lease_expires_at is null)
    or (state in ('new','dismissed') and content_item_id is null and pending_content_item_id is null and save_claim_id is null and save_lease_expires_at is null)
  )
);

create unique index if not exists source_signals_monitor_event_unique
  on source_signals (workspace_id, monitor_id, event_fingerprint);
create index if not exists source_signals_inbox_idx
  on source_signals (workspace_id, brand_id, state, score desc, last_seen_at desc);
create index if not exists source_signals_monitor_idx
  on source_signals (workspace_id, monitor_id, last_seen_at desc);
