do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'media_assets_id_workspace_brand_unique') then
    alter table media_assets add constraint media_assets_id_workspace_brand_unique unique (id, workspace_id, brand_id);
  end if;
end $$;

create table if not exists creative_projects (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  version integer not null check (version > 0),
  name text not null check (char_length(name) between 1 and 120),
  current_revision_id text not null,
  status text not null check (status in ('draft', 'rendering', 'ready', 'failed')),
  latest_render_id text,
  output_media_id text,
  last_error text check (last_error is null or char_length(last_error) between 1 and 2000),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint creative_projects_brand_fk foreign key (workspace_id, brand_id)
    references brands(workspace_id, id) on delete cascade,
  constraint creative_projects_status_shape check (
    (status = 'draft' and output_media_id is null and last_error is null)
    or (status = 'rendering' and latest_render_id is not null and output_media_id is null and last_error is null)
    or (status = 'ready' and latest_render_id is not null and output_media_id is not null and last_error is null)
    or (status = 'failed' and latest_render_id is not null and output_media_id is null and last_error is not null)
  ),
  unique (workspace_id, brand_id, id)
);

create table if not exists creative_revisions (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  project_id text not null,
  revision_number integer not null check (revision_number > 0),
  source_media_id text not null,
  source_media_sha256 text not null check (source_media_sha256 ~ '^[a-f0-9]{64}$'),
  content_item_id text,
  spec jsonb not null,
  spec_sha256 text not null check (spec_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text not null,
  created_at timestamptz not null,
  constraint creative_revisions_project_fk foreign key (workspace_id, brand_id, project_id)
    references creative_projects(workspace_id, brand_id, id) on delete cascade deferrable initially deferred,
  constraint creative_revisions_source_media_fk foreign key (source_media_id, workspace_id, brand_id)
    references media_assets(id, workspace_id, brand_id) on delete restrict,
  constraint creative_revisions_content_item_fk foreign key (content_item_id, workspace_id, brand_id)
    references content_items(id, workspace_id, brand_id) on delete restrict,
  constraint creative_revisions_spec_keys_check check (
    jsonb_typeof(spec) = 'object'
    and spec ?& array['format','sourceMediaId','sourceMediaSha256','headline','layout','font','textAlign','focalPoint','zoom','palette']
    and (spec - array['format','sourceMediaId','sourceMediaSha256','contentItemId','kicker','headline','subtitle','footer','layout','font','textAlign','focalPoint','zoom','palette']) = '{}'::jsonb
  ),
  constraint creative_revisions_spec_values_check check (
    spec->>'format' in ('square','portrait','story')
    and spec->>'sourceMediaId' = source_media_id
    and spec->>'sourceMediaSha256' = source_media_sha256
    and coalesce(spec->>'contentItemId', '') = coalesce(content_item_id, '')
    and jsonb_typeof(spec->'headline') = 'string' and char_length(spec->>'headline') between 1 and 180
    and (not spec ? 'kicker' or (jsonb_typeof(spec->'kicker') = 'string' and char_length(spec->>'kicker') <= 80))
    and (not spec ? 'subtitle' or (jsonb_typeof(spec->'subtitle') = 'string' and char_length(spec->>'subtitle') <= 280))
    and (not spec ? 'footer' or (jsonb_typeof(spec->'footer') = 'string' and char_length(spec->>'footer') <= 120))
    and spec->>'layout' in ('editorial','headline','quote')
    and spec->>'font' in ('manrope','newsreader')
    and spec->>'textAlign' in ('left','center')
    and jsonb_typeof(spec->'focalPoint') = 'object'
    and ((spec->'focalPoint') - array['x','y']) = '{}'::jsonb
    and spec->'focalPoint' ?& array['x','y']
    and jsonb_typeof(spec->'focalPoint'->'x') = 'number'
    and jsonb_typeof(spec->'focalPoint'->'y') = 'number'
    and (spec->'focalPoint'->>'x')::numeric between 0 and 100
    and (spec->'focalPoint'->>'y')::numeric between 0 and 100
    and jsonb_typeof(spec->'zoom') = 'number'
    and (spec->>'zoom')::numeric between 1 and 2
    and jsonb_typeof(spec->'palette') = 'array'
    and jsonb_array_length(spec->'palette') = 5
    and spec->'palette'->>0 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>1 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>2 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>3 ~ '^#[A-Fa-f0-9]{6}$'
    and spec->'palette'->>4 ~ '^#[A-Fa-f0-9]{6}$'
  ),
  unique (project_id, revision_number),
  unique (workspace_id, brand_id, project_id, id),
  unique (id, spec_sha256)
);

alter table creative_projects
  add constraint creative_projects_current_revision_fk
  foreign key (workspace_id, brand_id, id, current_revision_id)
  references creative_revisions(workspace_id, brand_id, project_id, id)
  on delete no action deferrable initially deferred;

create table if not exists creative_renders (
  id text primary key,
  workspace_id text not null,
  brand_id text not null,
  project_id text not null,
  revision_id text not null,
  spec jsonb not null,
  spec_sha256 text not null check (spec_sha256 ~ '^[a-f0-9]{64}$'),
  renderer_version text not null check (char_length(renderer_version) between 1 and 120),
  render_manifest_sha256 text not null check (render_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('rendering', 'ready', 'failed')),
  output_media_id text,
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[a-f0-9]{64}$'),
  error text check (error is null or char_length(error) between 1 and 2000),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null check (attempt_count > 0),
  created_by text not null,
  created_at timestamptz not null,
  finished_at timestamptz,
  constraint creative_renders_project_fk foreign key (workspace_id, brand_id, project_id)
    references creative_projects(workspace_id, brand_id, id) on delete cascade deferrable initially deferred,
  constraint creative_renders_revision_fk foreign key (workspace_id, brand_id, project_id, revision_id)
    references creative_revisions(workspace_id, brand_id, project_id, id) on delete restrict,
  constraint creative_renders_revision_hash_fk foreign key (revision_id, spec_sha256)
    references creative_revisions(id, spec_sha256) on delete restrict,
  constraint creative_renders_output_media_fk foreign key (output_media_id, workspace_id, brand_id)
    references media_assets(id, workspace_id, brand_id) on delete restrict,
  constraint creative_renders_result_shape check (
    (status = 'rendering' and output_media_id is null and output_sha256 is null and error is null and finished_at is null and lease_owner is not null and lease_expires_at is not null)
    or (status = 'ready' and output_media_id is not null and output_sha256 is not null and error is null and finished_at is not null and lease_owner is null and lease_expires_at is null)
    or (status = 'failed' and output_media_id is null and output_sha256 is null and error is not null and finished_at is not null and lease_owner is null and lease_expires_at is null)
  ),
  unique (revision_id, spec_sha256),
  unique (workspace_id, brand_id, project_id, id)
);

alter table creative_projects
  add constraint creative_projects_latest_render_fk
  foreign key (workspace_id, brand_id, id, latest_render_id)
  references creative_renders(workspace_id, brand_id, project_id, id)
  on delete no action deferrable initially deferred;

alter table creative_projects
  add constraint creative_projects_output_media_fk
  foreign key (output_media_id, workspace_id, brand_id)
  references media_assets(id, workspace_id, brand_id)
  on delete restrict;

create index if not exists creative_projects_workspace_brand_updated_idx
  on creative_projects(workspace_id, brand_id, updated_at desc, id desc);
create index if not exists creative_revisions_project_idx
  on creative_revisions(workspace_id, project_id, revision_number desc);
create index if not exists creative_renders_project_idx
  on creative_renders(workspace_id, project_id, created_at desc, id desc);
