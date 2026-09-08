-- Content Item commits normalize Publish Targets by deleting and reinserting the
-- same IDs in one transaction. Keep exact target lineage, but evaluate it only
-- after that transaction has restored the target rows.
alter table first_comment_intents drop constraint if exists first_comment_target_fk;
alter table first_comment_intents add constraint first_comment_target_fk
  foreign key (target_id, workspace_id, content_item_id)
  references publish_targets(id, workspace_id, content_item_id)
  on delete no action
  deferrable initially deferred;
