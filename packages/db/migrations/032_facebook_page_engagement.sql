-- Widen the proof-linked engagement inbox from Instagram-only to the two Meta
-- engagement platforms. Child rows carry the platform as a guarded lineage
-- field so recovery queries cannot accidentally cross provider boundaries.

alter table engagement_threads drop constraint if exists engagement_threads_platform_check;
alter table engagement_threads
  add constraint engagement_threads_platform_check
  check (platform in ('instagram', 'facebook'));

alter table engagement_comments add column if not exists platform text;
update engagement_comments comment
set platform = thread.platform
from engagement_threads thread
where thread.id = comment.thread_id
  and thread.workspace_id = comment.workspace_id
  and thread.brand_id = comment.brand_id
  and comment.platform is null;
alter table engagement_comments alter column platform set not null;
alter table engagement_comments drop constraint if exists engagement_comments_platform_check;
alter table engagement_comments
  add constraint engagement_comments_platform_check
  check (platform in ('instagram', 'facebook'));

alter table engagement_actions add column if not exists platform text;
update engagement_actions action
set platform = thread.platform
from engagement_threads thread
where thread.id = action.thread_id
  and thread.workspace_id = action.workspace_id
  and thread.brand_id = action.brand_id
  and action.platform is null;
alter table engagement_actions alter column platform set not null;
alter table engagement_actions drop constraint if exists engagement_actions_platform_check;
alter table engagement_actions
  add constraint engagement_actions_platform_check
  check (platform in ('instagram', 'facebook'));

alter table provider_webhook_receipts drop constraint if exists provider_webhook_receipts_provider_check;
alter table provider_webhook_receipts
  add constraint provider_webhook_receipts_provider_check
  check (provider in ('instagram', 'facebook'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'engagement_threads_platform_lineage_unique') then
    alter table engagement_threads
      add constraint engagement_threads_platform_lineage_unique
      unique (id, workspace_id, brand_id, account_id, external_media_id, platform);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'engagement_comments_platform_lineage_unique') then
    alter table engagement_comments
      add constraint engagement_comments_platform_lineage_unique
      unique (id, workspace_id, brand_id, thread_id, platform);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'connected_accounts_platform_lineage_unique') then
    alter table connected_accounts
      add constraint connected_accounts_platform_lineage_unique
      unique (id, workspace_id, brand_id, platform);
  end if;
end $$;

alter table engagement_comments drop constraint if exists engagement_comments_platform_thread_fk;
alter table engagement_comments
  add constraint engagement_comments_platform_thread_fk
  foreign key (thread_id, workspace_id, brand_id, account_id, external_media_id, platform)
  references engagement_threads(id, workspace_id, brand_id, account_id, external_media_id, platform)
  on delete cascade;

alter table engagement_actions drop constraint if exists engagement_actions_platform_comment_fk;
alter table engagement_actions
  add constraint engagement_actions_platform_comment_fk
  foreign key (comment_id, workspace_id, brand_id, thread_id, platform)
  references engagement_comments(id, workspace_id, brand_id, thread_id, platform)
  on delete cascade;

alter table provider_webhook_receipts drop constraint if exists provider_webhook_receipts_platform_account_fk;
alter table provider_webhook_receipts
  add constraint provider_webhook_receipts_platform_account_fk
  foreign key (account_id, workspace_id, brand_id, provider)
  references connected_accounts(id, workspace_id, brand_id, platform)
  on delete cascade;

create index if not exists engagement_threads_platform_inbox_idx
  on engagement_threads (workspace_id, brand_id, platform, state, last_activity_at desc, id desc);

create index if not exists engagement_actions_platform_recovery_idx
  on engagement_actions (platform, status, updated_at, id)
  where status in ('queued', 'processing', 'uncertain');

create index if not exists provider_webhook_receipts_provider_recovery_idx
  on provider_webhook_receipts (provider, available_at, lease_expires_at, received_at, id)
  where status = 'pending' or status = 'processing';
