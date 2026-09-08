alter table workspaces add column if not exists updated_at timestamptz not null default now();

create table if not exists brands (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  primary_language text not null,
  timezone text not null,
  status text not null check (status in ('active', 'archived')),
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, slug)
);

insert into brands (id, workspace_id, name, slug, primary_language, timezone, status, created_by, created_at, updated_at)
select
  case when id = 'default' then 'brand_default' else 'brand_' || substr(md5(id), 1, 24) end,
  id,
  case when id = 'default' then 'Main brand' else name end,
  'main',
  'English',
  'UTC',
  'active',
  'local-owner',
  created_at,
  updated_at
from workspaces
on conflict (workspace_id, slug) do nothing;

alter table content_items add column if not exists brand_id text;

update content_items item
set brand_id = brand.id
from brands brand
where brand.workspace_id = item.workspace_id
  and brand.status = 'active'
  and item.brand_id is null
  and brand.id = (
    select first_brand.id from brands first_brand
    where first_brand.workspace_id = item.workspace_id and first_brand.status = 'active'
    order by first_brand.created_at asc, first_brand.id asc
    limit 1
  );

alter table content_items alter column brand_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'content_items_brand_fk') then
    alter table content_items add constraint content_items_brand_fk
      foreign key (brand_id) references brands(id) on delete restrict;
  end if;
end $$;

create index if not exists brands_workspace_status_name_idx
  on brands (workspace_id, status, name);

create index if not exists content_items_workspace_brand_updated_idx
  on content_items (workspace_id, brand_id, updated_at desc);
