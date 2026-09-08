# Publishing channels

OriginPost keeps social account setup separate from content and publishing records. The first alpha supports Instagram professional accounts, Facebook Pages, and YouTube channels.

## What works

- account records are isolated by workspace;
- only owners can add, update, check, or disconnect an account;
- raw access-token fields are rejected;
- only `env:`, `vault:`, or `secret:` credential references can be saved;
- an `env:` reference passes only when the named environment secret is actually available to the API;
- the credential reference is never returned to the browser or written into audit detail;
- Connection Doctor checks the installed connector, credential reference, publishing capabilities, callback URL, access expiry, and live/test adapter mode;
- each failed check includes a plain-language next action;
- status is saved as `setup required`, `healthy`, `expiring`, `refresh failed`, or `disconnected`;
- automatic scheduling requires a checked account for the same platform and blocks work scheduled after its recorded expiry;
- the worker checks connection state and expiry again immediately before publishing;
- account metadata and its audit event are saved in one PostgreSQL transaction;
- Instagram OAuth uses a random, one-time, ten-minute connection state and stores only its SHA-256 hash;
- Instagram provider tokens are encrypted with AES-256-GCM and bound to their workspace and credential record;
- reconnecting the same Instagram account replaces the old encrypted credential instead of creating a duplicate account;
- **Renew access** rotates a built-in Instagram OAuth credential, replaces its expiry, and deletes the old encrypted record in the account transaction;
- a rejected renewal keeps the old credential, records `refresh_failed`, and asks the owner to reconnect;
- the official worker recovers due direct-Instagram and YouTube renewals from PostgreSQL every minute; the durable outbox retries transient network, rate-limit, and provider failures without storing tokens in its payload;
- direct Instagram renewal starts no earlier than 24 hours after the last successful issue/refresh and is scheduled from the recorded provider expiry, normally seven days before expiry; Facebook-Login Instagram accounts must reconnect instead;
- YouTube is renewed fifteen minutes before recorded access expiry, preserves the refresh token when Google omits a replacement, and publishing uses only the encrypted access token that won the transactional rotation;
- every automatic or owner-requested rotation is fenced by the exact previous credential reference and expiry under a database row lock, so disconnect, reconnect, or a competing refresh cannot be overwritten;
- a terminal automatic failure and its owner notification are committed with the account state; provider bodies and tokens are never copied into the outbox, notification, audit detail, or error summary;
- a denied, expired, or replayed callback fails closed and cannot be reused;
- Facebook Login for Business discovers eligible Pages on the server and shows only sanitized Page names and IDs for explicit selection;
- each selected Facebook Page becomes its own brand-scoped account and receives a separate encrypted Page credential;
- Facebook Page publishing starts with text-only and one-photo posts; unsupported media shapes fail before scheduling;
- the worker stores a durable Facebook intent before the provider write, never blind-retries an unclear response, and records proof only from a read-back Page ID and API permalink;
- Facebook proofs are shown normally, while Facebook analytics are clearly marked unsupported in this release;
- YouTube uses the server-side authorization-code flow with offline access; access and refresh tokens stay encrypted and server-side;
- YouTube scheduling requires the exact approved title and description plus explicit privacy, Made for Kids, synthetic-media, and subscriber-notification choices;
- a YouTube disconnect blocks local publishing first, then revokes the Google grant and deletes the encrypted credential; failed provider revocation stays visible and retryable without re-enabling publishing.
- an Instagram or Facebook disconnect blocks local publishing and deletes the encrypted local credential immediately, but returns `remoteGrantStatus=provider_deauthorization_required`; OriginPost does not claim the shared Meta user grant was revoked, because that grant may still authorize other connected Pages or Instagram accounts.
- each new OAuth connection creates a workspace-scoped provider grant; Channels groups every Page, Instagram account, or YouTube channel derived from that authorization beneath its parent grant;
- removing one publishing account closes only its current grant link. A shared Meta grant remains active for other linked accounts and becomes historical only after its last account is removed;
- automatic direct-Instagram and YouTube credential rotations update the parent grant lifecycle in the same fenced transaction;
- the official worker recovers due provider-grant validation from PostgreSQL every minute. It checks every account currently linked to the exact grant, validates Meta app/scopes/expiry/target identity or the exact Google YouTube channel, and commits the result only if the grant version still matches;
- temporary validation outages retry without notifying or blocking publishing, then record a bounded `refresh_failed` state for another check. Ambiguous expiry, permission, target, identity, or credential mismatches move the grant to `review_required` without destructively changing shared access. Only an explicit Google `invalid_grant` confirmation moves the parent to `reauthorization_required`, destroys linked credentials, blocks its children, and sends one owner notification;
- signed Meta deauthorization blocks every currently linked account across every matching workspace without accepting a workspace ID from the request;
- signed Meta data-deletion requests are durable and idempotent, return a hash-backed public status URL, and recover through the PostgreSQL outbox until provider-derived analytics, engagement, private-message content, credentials, account identity, and caches are removed. Workspace-authored drafts and media remain.

## Connect Instagram with OAuth

Set the public URLs and Meta application credentials in `.env`:

```text
API_PUBLIC_URL=https://api.example.com
WEB_PUBLIC_URL=https://app.example.com
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret
META_GRAPH_API_VERSION=vNN.0
META_WEBHOOK_VERIFY_TOKEN=use-a-separate-long-random-value
CREDENTIAL_ENCRYPTION_KEY=32-random-bytes-as-base64
PROVIDER_LOOKUP_HMAC_KEYS=v1:a-different-32-byte-key-as-base64
PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION=v1
MEDIA_DELIVERY_SECRET=a-different-32-byte-or-longer-secret
INSTAGRAM_CONNECTOR_MODE=official
ALLOW_LIVE_PUBLISH=true
AUTH_COOKIE_SECURE=true
```

Generate the encryption key with:

```bash
openssl rand -base64 32
```

Generate the provider lookup key separately. Never reuse the credential-encryption key. Keep retired key versions in `PROVIDER_LOOKUP_HMAC_KEYS` until every grant created with them has been reauthorized or deleted; callbacks compute lookup candidates for every retained version.

Register this exact callback URL in the Meta application:

```text
https://api.example.com/v1/channels/oauth/instagram/callback
```

Restart the API, open **Channels**, and choose **Connect Instagram**. OriginPost redirects through Instagram, verifies the one-time callback state, encrypts the returned provider token, and returns to the Channels screen. The browser receives no provider token.

The scopes follow Meta's current [Instagram API with Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login): `instagram_business_basic` and `instagram_business_content_publish`. A professional Instagram account and the matching Meta application configuration are required. Production use may also require Meta review and approved access for the application.

### Instagram Stories

The first Story release auto-publishes one baked image or video for a server-verified Instagram **Business** account. OriginPost requires a ready, server-inspected, owned-or-cleared 9:16 asset. Video Stories must be 3–60 seconds. A legacy credential with no verified account type and a Creator-account credential both fail closed before the provider write.

Story auto-publish sends only Meta's documented `media_type=STORIES` with an `image_url` or `video_url`. The draft caption is internal review copy; it is not sent as a Story caption. Link, music, poll, location, mention, and other interactive stickers are not represented as provider settings. Choose **Manual handoff** when those overlays are required; OriginPost retains its reminder, acknowledgement, and proof workflow without claiming the sticker was applied automatically.

Creative Studio's 1080×1920 output can create an Instagram Story draft directly. Publication still requires the normal immutable draft approval, account/media preflight, durable container operation, and proof. A Story disappearing from Instagram after its normal lifetime does not delete OriginPost's immutable publication proof.

### Connect Instagram through Facebook Login

Collaborator publishing uses a distinct Facebook Login path. Instagram Login credentials remain ineligible for collaborators and are never silently upgraded. Register this additional exact callback URL:

```text
https://api.example.com/v1/channels/oauth/instagram-facebook/callback
```

The server requests the fixed Page/Instagram scope set, exchanges the code only at the pinned `graph.facebook.com/{META_GRAPH_API_VERSION}` endpoint family, verifies the grant belongs to `META_APP_ID`, lists Pages, and derives each linked Instagram professional account. The browser receives only an opaque ten-minute selection ID and sanitized Instagram/Page identity fields. It never receives the user token, Page token, app secret, permission response, or raw discovery response.

After explicit selection, OriginPost atomically consumes the ten-minute selection and encrypts a separate credential for each Instagram account. Its server-derived metadata records `connectionMode=facebook_login`, the canonical lowercase publisher username, sorted granted scopes, endpoint family, pinned provider version, and bindings for the app contract, connected-account version, and Page/Instagram identity. Changing the Meta app, Graph version, callback, Page binding, Instagram identity, or local account version fails closed and requires reconnecting.

Collaborator capabilities remain absent until a watched provider contract probe succeeds for the exact pinned Graph version. Record the bounded probe window with `INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION`, `INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT`, and `INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT`; all three are required, the version must equal `META_GRAPH_API_VERSION`, and the window may not exceed 30 days. Expired or missing probe metadata disables collaborator publishing without disabling ordinary Instagram publishing.

The fixed scope set is `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_contents`, `instagram_manage_insights`, `pages_read_engagement`, and `pages_show_list`. The Meta app must have the matching approved access for the deployment and the authorizing person must be able to expose the linked Page and professional Instagram account. Missing scopes or missing/canonical-invalid usernames fail closed.

## Connect Facebook Pages

Facebook Pages use a separate Facebook Login for Business flow. Set the same `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_API_VERSION`, public URLs, credential-encryption key, and media-delivery secret shown above, then add:

```text
FACEBOOK_CONNECTOR_MODE=official
ALLOW_LIVE_PUBLISH=true
AUTH_MODE=sessions
```

Register this exact callback URL in the Meta application:

```text
https://api.example.com/v1/channels/oauth/facebook/callback
```

OriginPost requests the Page discovery and publishing permissions plus Page comment read/write access, including `pages_manage_engagement`. The Meta user must have the matching Page tasks, including `MODERATE` for automatic First Comments. Public or multi-customer deployments need the matching App Review/Advanced Access, Business Verification, and—when managing assets owned by other businesses—the correct Tech Provider setup.

Open **Channels → Connect Facebook Pages**. Tokens, app secrets, and the complete discovery response stay on the NestJS server. The browser receives only an opaque short-lived selection ID plus Page names and IDs. Choose one or more Pages; each selected Page is stored as a separate account. Abandoned discovery credentials are removed after their short retention window.

Private messages are a distinct consent and deployment gate; connecting a publishing account never silently enables DM access. After the Page or Page-linked Instagram account exists, follow **Channels → Enable private messages** and the rollout checklist in [private-conversations.md](private-conversations.md). This separate authorization uses the fixed messaging scopes, requires recorded Meta App Review evidence, and can be enabled while live post publishing remains off.

### Meta deauthorization and data deletion

Register these exact public callbacks in the Meta App Dashboard:

```text
https://api.example.com/v1/channels/callbacks/meta/deauthorization
https://api.example.com/v1/channels/callbacks/meta/data-deletion
```

Then configure independent secrets and enable the routes only after a watched App Dashboard callback test succeeds:

```dotenv
PROVIDER_LOOKUP_HMAC_KEYS=v1:<32-random-bytes-as-base64>
PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION=v1
PROVIDER_DELETION_STATUS_KEY=<different-32-random-bytes-as-base64>
META_DEAUTH_CALLBACK_CONTRACT_PROBE_SHA256=<sha256-of-watched-test-evidence>
META_PROVIDER_CALLBACKS_ENABLED=true
```

The callback parser accepts only one bounded `application/x-www-form-urlencoded` `signed_request`, verifies Meta's HMAC-SHA256 signature over its canonical payload, and extracts the numeric app-scoped user ID. The raw subject and signed request are never stored. The server derives versioned, context-separated HMAC lookup values and resolves all matching workspace grants internally; a callback cannot choose its workspace.

Data deletion immediately destroys linked publishing credentials and blocks access. The worker then crypto-shreds reversible private-message provider identifiers and bodies before completing the rest of the provider-derived deletion scope. If the required private-data keys are unavailable, the request retries and eventually moves to `needs review` instead of falsely reporting completion. The public status page exposes only `pending`, `completed`, or `needs review`, sends `Cache-Control: no-store`, and contains no workspace, account, subject, token, or credential identifier.

For Page comments, register the public callback below, set a long random `META_FACEBOOK_WEBHOOK_VERIFY_TOKEN` (or use the common Meta verification token), and subscribe the Page to the `feed` webhook field:

```text
https://api.example.com/v1/channels/webhooks/facebook
```

OriginPost verifies `X-Hub-Signature-256` against the unchanged raw request body, stores a bounded deduplicated receipt, responds quickly, and reconciles the matching proof in the worker. Comment reads need `pages_read_engagement` and, where applicable, `pages_read_user_content`; Page subscription and reply operations need their documented Page-management permissions and tasks.

### First Comments

Instagram and Facebook Page First Comments are governed separately from the main publication. A comment can be drafted before publishing, but it is not eligible for provider delivery until a manager or owner approves it and OriginPost binds it to the exact successful Publish Proof, target, draft hash, account, and platform. The worker then claims one leased execution, creates the comment once, reads back the exact body and account identity, and appends a separate evidence proof.

Instagram requires the connection-mode-specific comment-management permission. Facebook requires `pages_manage_engagement`, `pages_read_engagement`, and the Page `MODERATE` task. Missing permissions or unsupported targets fail before a provider write. A response-loss or identity mismatch becomes **Action required** and is never automatically resent. A manager or owner may request provider inspection without writing, attest an operator observation, or—only after explicitly confirming the comment was not sent—authorize one new write intent. See [first-comments.md](first-comments.md).

Public reply writes stay unavailable by default because Meta's endpoint-specific documentation conflicts with the generic Object Comments edge. Only after a watched contract probe succeeds for the exact pinned Graph API version may an operator set both fields below. Changing `META_GRAPH_API_VERSION` disables replies again until a new probe is recorded.

```text
FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_API_VERSION=vNN.0
FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT=2026-08-29T12:00:00.000Z
FACEBOOK_COMMENT_RECONCILE_MAX_PAGES=10
```

The reconciliation page budget is bounded from 1 to 25. Keep the default unless a watched deployment shows that busy Page threads need a larger read budget.

The first release deliberately supports only:

- a Page text post with no media;
- a Page image post with exactly one owned or rights-cleared image.

Meta's feed and photo write endpoints do not document a caller idempotency key. OriginPost therefore saves the approved intent before the write and marks the operation `finalizing` before sending it. If the connection ends without a clear provider result, it moves to **Action required** instead of sending a second post. If Meta returns an ID, the worker reads that exact object, confirms the Page identity, and stores the API `permalink_url`; it never invents a Facebook URL.

Keep Page live publishing off until the Meta app is Live, the required permissions have approved access, exact redirect/Strict Mode settings are correct, a privacy policy and data-deletion/deauthorization routes are configured, and a watched publish on an owned test Page has passed. Current official references show Graph v26 while some guides still use v25 examples, so pin `META_GRAPH_API_VERSION` and re-run the connector contract suite before changing it.

Remote correction is a separate, human-approved workflow. Requests are stored first and must be approved against a fresh provider read. Production teams should use two-person approval; a self-hosted workspace with exactly one active owner/manager may use the recorded sole-owner override and second confirmation. A manual provider handoff is never presented as provider-confirmed deletion.

Facebook Page deletion stays manual unless a watched probe is bound to the exact environment, Meta app, local connected-account ID, external Page ID, credential and account versions, current Page-task snapshot, Graph version, and `page_post_delete` task. Any Page rebind, credential rotation, account update, or task change disables the probe. The probe must expire within 30 days:

```dotenv
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_API_VERSION=vNN.0
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_VERIFIED_AT=2026-08-29T06:00:00.000Z
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXPIRES_AT=2026-09-12T06:00:00.000Z
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_ID=account_example
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXTERNAL_PAGE_ID=page_example
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_CREDENTIAL_VERSION=2026-08-29T06:00:00.000Z
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_VERSION=2026-08-29T06:00:00.000Z
FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_PAGE_TASKS_SHA256=<sha256-of-versioned-canonical-current-page-tasks>
```

OriginPost requires both `pages_manage_posts` and `pages_read_engagement` for this path. Instagram remote deletion remains unavailable for Instagram Login credentials; it requires a separately supported Facebook Login connection with both `instagram_basic` and `instagram_manage_contents`. YouTube correction requires `youtube.force-ssl`. Restart recovery reconciles finalizing or uncertain operations and never repeats the provider mutation blindly.

## Connect YouTube

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, the same HTTPS public URLs, and a 32-byte `CREDENTIAL_ENCRYPTION_KEY`. Register this exact redirect URI in the Google OAuth client:

```text
https://api.example.com/v1/channels/oauth/youtube/callback
```

Keep these rollout gates until the official Google and YouTube checks are complete:

```text
YOUTUBE_CONNECTOR_MODE=official
ALLOW_LIVE_PUBLISH=true
YOUTUBE_API_COMPLIANCE_AUDITED=false
YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING=false
```

Official connectors also require `AUTH_MODE=sessions`. OriginPost refuses to enable live publishing while the management API is in trusted-local `single-user` mode. Keep the database, Redis, object storage, and management API on private or loopback interfaces; expose only reviewed HTTPS routes through a reverse proxy.

OriginPost requests offline YouTube access, stores the refresh grant encrypted, and uploads through the normal `videos.insert` resumable protocol. YouTube has no separate Shorts API flag; the composer describes the video as eligible for Shorts classification and YouTube decides after processing. The worker stores the upload session encrypted before sending bytes, resumes the same session after interruption, and records proof only after provider processing succeeds.

Google OAuth verification and the YouTube API compliance audit are different requirements. API projects that have not passed YouTube's applicable audit are restricted to private uploads. OriginPost blocks public and unlisted uploads unless both deployment gates above are true.

## Add an advanced test account

Open **Channels → Add test account**. Save the provider account ID, a friendly name, the protected credential reference, the provider access expiry, and the capabilities granted by the provider. This path is for local testing and deployments that provide their own compatible secret adapter.

Examples of allowed references:

```text
env:INSTAGRAM_MAIN_CREDENTIAL
vault:originpost/production/youtube
secret:workspace/main-instagram
```

Do not paste an OAuth token, app secret, refresh token, password, or cookie. Secret values belong in the deployment environment or a dedicated vault. The Community alpha resolves `env:` references and the built-in OAuth flow creates encrypted `secret:` credentials. Manually entered `vault:` and `secret:` references stay blocked until their matching server-side adapter or credential exists.

For local development, `API_PUBLIC_URL=http://localhost:4000` is accepted with a warning. Set a public HTTPS URL before connecting a real provider.

## Current safety limit

The default worker still uses mock connectors. Every official platform must be switched on separately with its full settings. Instagram saves its post, Reel, carousel, or Story container before the final publish call. Facebook saves its intent before the Page write and refuses to repeat an uncertain write. YouTube saves an encrypted resumable-session URI before any video bytes and persists its confirmed byte offset. An uncertain irreversible result moves to **Action required** instead of starting another provider upload. The content update, proof, audit event, and provider-operation result are saved in one PostgreSQL transaction.

The adapter has fake-provider tests for images, mixed carousels, Reels, processing, publishing, permalink lookup, token redaction, crash-state decisions, durable credential-refresh and grant-validation recovery, refresh/disconnect/reconnect races, shared-grant callback fan-out, HMAC-key rotation, and recoverable deletion scopes. It has not been verified against the user's real Meta application. Meta application review, validation against owned accounts, secret-rotation exercises, a watched callback probe, and a watched first production publish are still required. Facebook Page tokens are validated/reconnected rather than described as periodically refreshable.

The YouTube flow follows Google's [server-side OAuth guidance](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps), [resumable upload protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), and [video processing status](https://developers.google.com/youtube/v3/guides/implementation/videos). Real-provider verification, Google OAuth review, YouTube compliance audit, public Terms/Privacy pages, quota operations, and a watched first production upload remain deployment gates.
