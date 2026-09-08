create table if not exists automation_api_keys (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  secret_hash text not null unique,
  scopes text[] not null,
  brand_ids text[] not null default '{}',
  account_ids text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint automation_api_keys_scopes_check check (cardinality(scopes) > 0)
);

create index if not exists automation_api_keys_workspace_idx on automation_api_keys (workspace_id, created_at desc);
create index if not exists automation_api_keys_active_idx on automation_api_keys (secret_hash) where revoked_at is null;

create table if not exists automation_webhook_subscriptions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  url text not null,
  topics text[] not null,
  brand_ids text[] not null default '{}',
  secret jsonb not null,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  disabled_at timestamptz,
  constraint automation_webhook_topics_check check (cardinality(topics) > 0)
);

create index if not exists automation_webhook_subscriptions_workspace_idx on automation_webhook_subscriptions (workspace_id, active, created_at desc);

create table if not exists automation_events (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text,
  topic text not null,
  content_item_id text references content_items(id) on delete set null,
  aggregate_version integer,
  occurred_at timestamptz not null,
  actor_type text not null,
  payload jsonb not null
);

create index if not exists automation_events_workspace_idx on automation_events (workspace_id, occurred_at desc, id);

create table if not exists automation_webhook_deliveries (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  subscription_id text not null references automation_webhook_subscriptions(id) on delete cascade,
  event_id text not null references automation_events(id) on delete cascade,
  status text not null check (status in ('pending', 'processing', 'delivered', 'failed', 'dead_letter')),
  attempts integer not null default 0,
  available_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  response_status integer,
  response_sha256 text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (subscription_id, event_id)
);

create index if not exists automation_webhook_deliveries_due_idx
  on automation_webhook_deliveries (available_at, id)
  where status in ('pending', 'processing', 'failed');
create index if not exists automation_webhook_deliveries_workspace_idx on automation_webhook_deliveries (workspace_id, created_at desc);

create or replace function originpost_capture_automation_event() returns trigger language plpgsql as $$
declare
  mapped_topic text;
  item_brand_id text;
  automation_event_id text;
begin
  mapped_topic := case
    when new.action = 'content.created' then 'content.created'
    when new.action = 'draft.added' then 'draft.revised'
    when new.action = 'content.transitioned' and new.detail->>'to' = 'review' then 'approval.needed'
    when new.action = 'approval.recorded' then 'approval.decided'
    when new.action = 'publish.scheduled' then 'target.scheduled'
    when new.action = 'publish.rescheduled' then 'target.rescheduled'
    when new.action = 'publish.cancelled' then 'target.cancelled'
    when new.action = 'publish.target_status' and new.detail->>'status' = 'failed' then 'publish.failed'
    when new.action = 'publish.target_status' and new.detail->>'status' = 'action_required' then 'publish.action_required'
    when new.action = 'publish.attempt_succeeded' then 'publish.succeeded'
    when new.action in ('publish.proof_recorded', 'publish.manual_confirmed', 'publish.provider_reconciled') then 'proof.created'
    else null
  end;
  if mapped_topic is null then return new; end if;

  if new.content_item_id is not null then select brand_id into item_brand_id from content_items where id = new.content_item_id and workspace_id = new.workspace_id; end if;
  automation_event_id := 'automation_' || new.id;
  insert into automation_events (id, workspace_id, brand_id, topic, content_item_id, aggregate_version, occurred_at, actor_type, payload)
  values (automation_event_id, new.workspace_id, item_brand_id, mapped_topic, new.content_item_id, nullif(new.detail->>'contentVersion','')::integer, new.created_at, new.actor_type,
    jsonb_build_object('action', new.action, 'detail', new.detail, 'contentItemId', new.content_item_id))
  on conflict (id) do nothing;

  insert into automation_webhook_deliveries (id, workspace_id, subscription_id, event_id, status, attempts, available_at, created_at, updated_at)
  select 'delivery_' || md5(subscription.id || ':' || automation_event_id), new.workspace_id, subscription.id, automation_event_id, 'pending', 0, new.created_at, new.created_at, new.created_at
  from automation_webhook_subscriptions subscription
  where subscription.workspace_id = new.workspace_id and subscription.active = true
    and mapped_topic = any(subscription.topics)
    and (cardinality(subscription.brand_ids) = 0 or item_brand_id = any(subscription.brand_ids))
  on conflict (subscription_id, event_id) do nothing;
  return new;
end;
$$;

drop trigger if exists audit_events_capture_automation on audit_events;
create trigger audit_events_capture_automation after insert on audit_events for each row execute function originpost_capture_automation_event();
