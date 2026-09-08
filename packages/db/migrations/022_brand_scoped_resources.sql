alter table monitor_rules add column if not exists brand_id text;
alter table media_assets add column if not exists brand_id text;
alter table connected_accounts add column if not exists brand_id text;
alter table oauth_connection_states add column if not exists brand_id text;

update monitor_rules resource set brand_id = (
  select id from brands where workspace_id = resource.workspace_id order by created_at asc, id asc limit 1
)
where resource.brand_id is null;

update media_assets resource set brand_id = (
  select id from brands where workspace_id = resource.workspace_id order by created_at asc, id asc limit 1
)
where resource.brand_id is null;

update connected_accounts resource set brand_id = (
  select id from brands where workspace_id = resource.workspace_id order by created_at asc, id asc limit 1
)
where resource.brand_id is null;

update oauth_connection_states resource set brand_id = (
  select id from brands where workspace_id = resource.workspace_id order by created_at asc, id asc limit 1
)
where resource.brand_id is null;

alter table monitor_rules alter column brand_id set not null;
alter table media_assets alter column brand_id set not null;
alter table connected_accounts alter column brand_id set not null;
alter table oauth_connection_states alter column brand_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'monitor_rules_brand_fk') then
    alter table monitor_rules add constraint monitor_rules_brand_fk foreign key (brand_id) references brands(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'media_assets_brand_fk') then
    alter table media_assets add constraint media_assets_brand_fk foreign key (brand_id) references brands(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'connected_accounts_brand_fk') then
    alter table connected_accounts add constraint connected_accounts_brand_fk foreign key (brand_id) references brands(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'oauth_connection_states_brand_fk') then
    alter table oauth_connection_states add constraint oauth_connection_states_brand_fk foreign key (brand_id) references brands(id) on delete restrict;
  end if;
end $$;

create index if not exists monitor_rules_workspace_brand_updated_idx on monitor_rules (workspace_id, brand_id, updated_at desc);
create index if not exists media_assets_workspace_brand_created_idx on media_assets (workspace_id, brand_id, created_at desc);
create index if not exists connected_accounts_workspace_brand_updated_idx on connected_accounts (workspace_id, brand_id, updated_at desc);
