alter table content_items
  add column if not exists version integer not null default 1;

update content_items
set payload = jsonb_set(payload, '{version}', to_jsonb(version), true)
where not (payload ? 'version');

alter table content_items drop constraint if exists content_items_version_positive;

alter table content_items
  add constraint content_items_version_positive check (version >= 1);

create index if not exists content_items_workspace_version_idx
  on content_items (workspace_id, id, version);
