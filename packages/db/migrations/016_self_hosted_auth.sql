create table if not exists auth_users (
  id text primary key,
  email text not null,
  display_name text not null,
  password_hash text not null,
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint auth_users_email_normalized check (email = lower(email))
);

create unique index if not exists auth_users_email_unique_idx on auth_users (email);

insert into auth_users (id, email, display_name, password_hash, status, created_at, updated_at)
values ('local-owner', 'local-owner@localhost.invalid', 'Local Owner', 'disabled', 'disabled', now(), now())
on conflict (id) do nothing;

alter table workspace_members add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_members_user_fk'
  ) then
    alter table workspace_members
      add constraint workspace_members_user_fk foreign key (user_id) references auth_users(id) on delete restrict;
  end if;
end $$;

create table if not exists auth_sessions (
  id text primary key,
  user_id text not null references auth_users(id) on delete cascade,
  token_hash text not null unique,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists auth_sessions_user_active_idx
  on auth_sessions (user_id, expires_at desc)
  where revoked_at is null;

create index if not exists auth_sessions_token_active_idx
  on auth_sessions (token_hash, expires_at)
  where revoked_at is null;

create index if not exists workspace_members_user_workspace_idx
  on workspace_members (user_id, workspace_id);
