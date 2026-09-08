-- Owner-created, one-time workspace invitations with manual link delivery.

create table if not exists workspace_invitations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'manager', 'creator', 'viewer')),
  status text not null check (status in ('pending', 'accepted', 'revoked', 'expired')),
  delivery_state text not null check (delivery_state = 'link_ready'),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  invited_by text not null,
  accepted_at timestamptz,
  accepted_by text,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint workspace_invitations_email_normalized check (email = lower(email) and char_length(email) between 3 and 254),
  constraint workspace_invitations_expiry_check check (expires_at > created_at),
  constraint workspace_invitations_inviter_fk foreign key (workspace_id, invited_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint workspace_invitations_acceptor_fk foreign key (workspace_id, accepted_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint workspace_invitations_revoker_fk foreign key (workspace_id, revoked_by) references workspace_members(workspace_id, user_id) on delete restrict,
  constraint workspace_invitations_state_check check (
    (status in ('pending', 'expired') and accepted_at is null and accepted_by is null and revoked_at is null and revoked_by is null)
    or (status = 'accepted' and accepted_at is not null and accepted_by is not null and revoked_at is null and revoked_by is null)
    or (status = 'revoked' and accepted_at is null and accepted_by is null and revoked_at is not null and revoked_by is not null)
  ),
  unique (workspace_id, id)
);

create unique index if not exists workspace_invitations_one_pending_email_idx
  on workspace_invitations (workspace_id, email)
  where status = 'pending';

create index if not exists workspace_invitations_workspace_created_idx
  on workspace_invitations (workspace_id, created_at desc, id);

create index if not exists workspace_invitations_pending_expiry_idx
  on workspace_invitations (expires_at, workspace_id)
  where status = 'pending';
