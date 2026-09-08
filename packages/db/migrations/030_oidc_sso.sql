create table if not exists auth_oidc_login_states (
  id text primary key,
  state_hash text not null unique,
  nonce_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  consumed_at timestamptz,
  constraint auth_oidc_login_states_state_hash check (state_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_oidc_login_states_nonce_hash check (nonce_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_oidc_login_states_expiry check (expires_at > created_at),
  constraint auth_oidc_login_states_consumed_time check (consumed_at is null or consumed_at >= created_at)
);

create index if not exists auth_oidc_login_states_expiry_idx
  on auth_oidc_login_states (expires_at)
  where consumed_at is null;

create table if not exists auth_oidc_identities (
  issuer text not null,
  subject text not null,
  user_id text not null references auth_users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null,
  last_login_at timestamptz not null,
  primary key (issuer, subject),
  constraint auth_oidc_identities_email_normalized check (email = lower(email)),
  constraint auth_oidc_identities_issuer_nonempty check (length(issuer) > 0),
  constraint auth_oidc_identities_subject_nonempty check (length(subject) > 0)
);

create unique index if not exists auth_oidc_identity_user_issuer_idx
  on auth_oidc_identities (user_id, issuer);

create index if not exists auth_oidc_identity_user_idx
  on auth_oidc_identities (user_id);
