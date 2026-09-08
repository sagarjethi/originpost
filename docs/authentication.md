# Self-hosted authentication

OriginPost supports two clear modes.

Team session mode can authenticate with local passwords, OpenID Connect, or both. Both paths create the same local OriginPost session and pass through the same Workspace membership checks.

## Local single-user mode

`AUTH_MODE=single-user` is the default. The API trusts every request as the configured local owner. Use it only on a trusted machine or private network. It is convenient for first setup but is not a login system.

## Team session mode

Set these values before starting the API for the first time:

```dotenv
AUTH_MODE=sessions
BOOTSTRAP_ADMIN_EMAIL=owner@example.com
BOOTSTRAP_ADMIN_NAME=OriginPost Owner
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-strong-password
AUTH_SESSION_DAYS=14
AUTH_COOKIE_SECURE=false
```

Run `pnpm db:migrate`, then start OriginPost. The API creates the bootstrap owner only when that email does not exist. It never overwrites an existing account or password.

Use `AUTH_COOKIE_SECURE=true` behind HTTPS. Keep it `false` only for local HTTP development. The web app shows a sign-in screen, then uses the browser cookie automatically. Owners can invite people and change roles under **Organizations**.

## Workspace invitations

Invitations are available only in `AUTH_MODE=sessions` and only to Workspace owners. An owner enters an email address, selects the exact role, and chooses an expiry of 1–30 days. OriginPost returns a copyable link with `deliveryState: link_ready`; this release does not send email or claim delivery. The owner must send the link through a trusted channel.

The raw invitation token appears only in the create or resend response. It is placed after `#token=` in the link, so browsers do not send it in the HTTP request target. The invite page immediately removes the fragment from visible history and submits the token only in `POST` bodies. OriginPost stores only the token's SHA-256 hash and excludes raw tokens and hashes from list responses and audit details.

An invitation is bound server-side to one Workspace, one normalized email address, and one role. A signed-in existing user can accept only when the account email matches exactly. A person without an account can set a display name and password through the invitation page; the server takes the email, Workspace, and role from the invitation rather than from the browser. Acceptance adds the membership and marks the token used in the same database transaction. Tokens are one-time, expiring, and revocable.

Creating a second active invitation for the same Workspace/email is refused. **Resend** rotates the token and invalidates the old link; it does not send a message. **Revoke** invalidates the current link. Invitation create, resend, revoke, and accept operations are recorded in the audit log without token material.

Invitation mutation, preview, registration, and acceptance endpoints have bounded per-process throttles in addition to normal session and CSRF controls. Owner mutations require the session CSRF header. Public preview and registration responses are non-cacheable and carry restrictive referrer and content-type headers. Internet-facing or multi-instance deployments still need HTTPS and a shared rate limiter at the trusted reverse proxy.

## Roles

- Owner: all workspace access, connected accounts, members, and automation.
- Manager: content, approval, scheduling, publishing, and automation; no member or connected-account administration.
- Creator: read, create, and edit content and media.
- Viewer: read-only access.

OriginPost refuses to remove the final active owner. Disabled legacy accounts are neither shown nor counted as owners.

## Security behavior

- Passwords use Node's `scrypt` with a unique random salt.
- The browser receives an opaque `HttpOnly`, `SameSite=Lax` cookie. PostgreSQL stores only its SHA-256 hash.
- Every changing request in session mode must carry the per-session CSRF token returned by login or `/v1/auth/me`.
- Logout revokes the database session immediately.
- Password change revokes the user's other sessions.
- Sign-in failures are throttled per process and email/client pair. Put an additional rate limit at the reverse proxy for multi-instance or internet-facing deployments.
- Session lookup and membership are checked on every protected request. A user cannot select a workspace they do not belong to.

For an internet-facing deployment, also configure HTTPS, secure cookies, a trusted reverse proxy, deployment secret storage, database backups, log retention, and monitoring. Review the deployment independently before allowing live publishing.

For provider-based login, see [OpenID Connect single sign-on](openid-connect.md). OIDC is invitation-only by default and never changes an existing member's Workspace role during login.
