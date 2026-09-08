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
