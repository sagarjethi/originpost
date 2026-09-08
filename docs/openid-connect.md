# OpenID Connect single sign-on

OriginPost can use a self-hosted or managed OpenID Connect provider for browser sign-in. OIDC is optional and works only in `AUTH_MODE=sessions`. Password login remains available as a recovery path for the bootstrap owner.

## Provider setup

Register this exact authorization-code callback with the provider:

```text
https://originpost.example.com/v1/auth/oidc/callback
```

Enable Authorization Code flow, PKCE with `S256`, and the `openid email profile` scopes. The provider must expose standard discovery metadata and a JWKS endpoint. OriginPost accepts signed asymmetric ID tokens, verifies issuer, audience, lifetime, nonce, and the response issuer when supplied, and requires a verified email. Production issuer, callback, and web return URLs must use HTTPS. Outside production, only loopback provider URLs may use plain HTTP.

Configure the API:

```dotenv
AUTH_MODE=sessions
AUTH_COOKIE_SECURE=true
OIDC_ENABLED=true
OIDC_DISPLAY_NAME=Company SSO
OIDC_ISSUER_URL=https://identity.example.com
OIDC_CLIENT_ID=originpost
OIDC_CLIENT_SECRET=replace-with-provider-secret
OIDC_REDIRECT_URI=https://originpost.example.com/v1/auth/oidc/callback
OIDC_WEB_RETURN_URL=https://originpost.example.com/
```

`OIDC_CLIENT_SECRET` may be empty only when the provider supports public clients at its token endpoint.

## Access policy

Access is invitation-only by default. A first OIDC login with the same verified email as an existing active OriginPost user links the provider identity to that user and keeps every existing Workspace role unchanged.

Optional comma-separated restrictions:

```dotenv
OIDC_ALLOWED_EMAIL_DOMAINS=example.com,subsidiary.example.com
OIDC_ALLOWED_GROUPS=originpost-users,originpost-admins
OIDC_GROUPS_CLAIM=groups
```

When `OIDC_AUTO_PROVISION=true`, a new verified identity receives one membership in `OIDC_DEFAULT_WORKSPACE_ID`. The first matching group sets its role in this order: owner, manager, creator. Otherwise `OIDC_DEFAULT_ROLE` is used.

```dotenv
OIDC_AUTO_PROVISION=true
OIDC_DEFAULT_WORKSPACE_ID=default
OIDC_DEFAULT_ROLE=viewer
OIDC_OWNER_GROUPS=originpost-admins
OIDC_MANAGER_GROUPS=originpost-managers
OIDC_CREATOR_GROUPS=originpost-editors
```

Group mapping applies only when a new member is provisioned. Later logins never silently replace a role assigned inside OriginPost.

## Session and logout behavior

After OIDC succeeds, OriginPost creates the same opaque, HttpOnly, CSRF-protected local session used by password login. Tokens from the identity provider are not stored in the browser or database. Signing out revokes the local OriginPost session immediately. It does not sign the person out of every application at the identity provider.

The login state is one-time, expires after ten minutes, and is bound to HttpOnly state, nonce, and PKCE verifier cookies. A failed or replayed callback does not create a session.

## Production checklist

- Use HTTPS for OriginPost and the issuer.
- Register only the exact callback above; do not add wildcard callbacks.
- Keep the client secret in the deployment secret manager, not Git.
- Keep `OIDC_AUTO_PROVISION=false` unless the default Workspace and group rules have been reviewed.
- Keep an active bootstrap owner account for recovery.
- Test login, denied users, logout, key rotation, and provider outage before rollout.
- Put rate limiting and security monitoring at the reverse proxy.
