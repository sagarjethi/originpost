alter table connected_accounts
  drop constraint if exists connected_accounts_platform_check;

alter table connected_accounts
  add constraint connected_accounts_platform_check
  check (platform in ('instagram', 'facebook', 'youtube'));

alter table oauth_connection_states
  drop constraint if exists oauth_connection_states_platform_check;

alter table oauth_connection_states
  add constraint oauth_connection_states_platform_check
  check (platform in ('instagram', 'facebook', 'youtube'));

alter table provider_publish_operations
  drop constraint if exists provider_publish_operations_platform_check;

alter table provider_publish_operations
  add constraint provider_publish_operations_platform_check
  check (platform in ('instagram', 'facebook', 'youtube'));

alter table encrypted_credentials
  drop constraint if exists encrypted_credentials_purpose_check;

alter table encrypted_credentials
  add constraint encrypted_credentials_purpose_check
  check (purpose in ('oauth-state', 'provider-token', 'provider-discovery'));
