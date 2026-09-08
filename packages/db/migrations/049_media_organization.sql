create table if not exists media_folders (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  brand_id text not null,
  parent_id text,
  name text not null check (char_length(name) between 1 and 80),
  normalized_name text not null check (char_length(normalized_name) between 1 and 80),
  version integer not null check (version >= 1),
  created_by text not null,
  created_at timestamptz not null,
  updated_by text not null,
  updated_at timestamptz not null,
  constraint media_folders_workspace_brand_fk foreign key (workspace_id, brand_id)
    references brands(workspace_id, id) on delete cascade,
  constraint media_folders_id_workspace_brand_unique unique (id, workspace_id, brand_id),
  constraint media_folders_parent_fk foreign key (parent_id, workspace_id, brand_id)
    references media_folders(id, workspace_id, brand_id) on delete restrict deferrable initially deferred,
  constraint media_folders_not_self_parent check (parent_id is null or parent_id <> id)
);

create unique index if not exists media_folders_sibling_name_unique
  on media_folders (workspace_id, brand_id, coalesce(parent_id, ''), normalized_name);

create index if not exists media_folders_tree_idx
  on media_folders (workspace_id, brand_id, parent_id, name, id);

create table if not exists media_asset_organization (
  asset_id text primary key,
  workspace_id text not null,
  brand_id text not null,
  folder_id text,
  tags text[] not null default '{}',
  favorite boolean not null default false,
  version integer not null check (version >= 1),
  updated_by text not null,
  updated_at timestamptz not null,
  constraint media_asset_organization_asset_fk foreign key (asset_id, workspace_id, brand_id)
    references media_assets(id, workspace_id, brand_id) on delete cascade,
  constraint media_asset_organization_folder_fk foreign key (folder_id, workspace_id, brand_id)
    references media_folders(id, workspace_id, brand_id) on delete restrict deferrable initially deferred,
  constraint media_asset_organization_tag_limit check (cardinality(tags) <= 20),
  constraint media_asset_organization_tags_nonempty check (array_position(tags, '') is null),
  constraint media_asset_organization_scope_unique unique (asset_id, workspace_id, brand_id)
);

create index if not exists media_asset_organization_folder_idx
  on media_asset_organization (workspace_id, brand_id, folder_id, favorite desc, updated_at desc);

create index if not exists media_asset_organization_tags_idx
  on media_asset_organization using gin (tags);

create index if not exists media_asset_organization_favorite_idx
  on media_asset_organization (workspace_id, brand_id, updated_at desc)
  where favorite;
