# Private Conversations

Private Conversations is the private-message side of the Engagement workspace. It is separate from public Instagram and Facebook comments.

## Current release status

- The encrypted inbox, review flow, worker, recovery, retention, and responsive web view are implemented.
- Provider sending is **disabled by default**.
- `mock` mode is only for local development and tests. OriginPost rejects it when `NODE_ENV=production`.
- The official connector supports Facebook Page Messenger and Instagram professional accounts connected through a linked Facebook Page.
- Instagram Login is intentionally not treated as the same provider contract and remains unavailable for private messages.
- Official mode still depends on the operator's Meta App Review/Advanced Access, Live app configuration, business/account eligibility, and watched testing on owned accounts. Shipping the connector does not grant those external approvals.

## Local demo setup

Generate two different keys:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Set:

```dotenv
PRIVATE_MESSAGE_CONNECTOR_MODE=mock
PRIVATE_MESSAGE_ENCRYPTION_KEY=<first key>
PRIVATE_MESSAGE_HASH_KEY=<second key>
```

Never reuse either key for `CREDENTIAL_ENCRYPTION_KEY`. Never commit real keys.

After rebuilding and restarting the API, worker, and web app, a human workspace owner can use:

- `GET /v1/private-conversations/readiness`
- `POST /v1/private-conversations/demo/accounts/:accountId/provision`

The demo endpoint accepts only an existing healthy Instagram or Facebook account. The server adds the two private-message capabilities, creates the initial sync state, and queues the first mock sync. Clients cannot grant those capabilities through the normal channel create/update DTO.

## Workflow

1. Sync or webhook observations create an encrypted conversation timeline.
2. A creator writes a reply draft.
3. The draft is submitted for approval.
4. A human manager or owner approves it after a fresh provider-window check.
5. One worker claims the reply with a fenced lease and sends it once.
6. OriginPost records `succeeded`, `failed`, `expired`, or `uncertain` without blindly retrying an unclear provider result.
7. An uncertain send requires a live check. “Confirm sent” appears only when OriginPost has hidden provider evidence; otherwise only “Confirm not sent” is available.

Only one queued, processing, or uncertain provider write is allowed per conversation.

## Official Meta setup

Official messaging is independent from live post publishing. `ALLOW_LIVE_PUBLISH` may remain `false`. Set all of the following in the API and worker environments:

```dotenv
AUTH_MODE=sessions
API_PUBLIC_URL=https://api.example.com
WEB_PUBLIC_URL=https://app.example.com
PRIVATE_MESSAGE_CONNECTOR_MODE=official
CREDENTIAL_ENCRYPTION_KEY=<32-byte base64 key>
PRIVATE_MESSAGE_ENCRYPTION_KEY=<different 32-byte base64 key>
PRIVATE_MESSAGE_HASH_KEY=<different 32-byte base64 or longer key>
META_APP_ID=<approved app id>
META_APP_SECRET=<app secret>
META_GRAPH_API_VERSION=vNN.0
META_WEBHOOK_VERIFY_TOKEN=<at least 24 random characters>
META_PRIVATE_MESSAGING_APP_REVIEW_SHA256=<lowercase sha256 of approval evidence>
DATABASE_URL=<postgres connection>
REDIS_URL=<redis connection>
```

Register these exact public HTTPS routes in the same Meta app:

```text
OAuth callback:       https://api.example.com/v1/channels/oauth/meta-messaging/callback
Facebook webhook:    https://api.example.com/v1/channels/webhooks/facebook
Instagram webhook:   https://api.example.com/v1/channels/webhooks/instagram
```

The re-consent flow has a fixed, server-owned permission set. Facebook Page Messenger requires `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, and `pages_messaging`. Page-linked Instagram additionally requires `instagram_basic`, `instagram_manage_messages`, and `business_management`. The authorizing person must expose the matching Page, and the Page must include `MESSAGING` or `MODERATE` in its current task snapshot.

Store the approval record outside the source repository, make it immutable, calculate its SHA-256, and set only that lowercase digest as `META_PRIVATE_MESSAGING_APP_REVIEW_SHA256`. OriginPost validates the digest format and binds it into each per-account messaging grant; the deployment owner remains responsible for ensuring the referenced evidence covers the exact app, permissions, use case, and environment.

Restart the API and worker, open **Channels → Enable private messages**, sign in to Meta, and explicitly choose the returned inboxes. OriginPost accepts only Page and linked-Instagram identities that match an existing, non-disconnected OAuth-managed account. It live-probes the pinned Graph contract, rotates the account credential transactionally, subscribes only the approved webhook fields, initializes durable sync state, and queues the first reconciliation. The browser receives only an opaque ten-minute selection ID and sanitized account identity—never a provider token, Page token, permission response, app secret, or raw discovery payload.

Facebook subscribes `messages`, `message_echoes`, `message_deliveries`, `message_reads`, and `messaging_policy_enforcement`. Linked Instagram subscribes `messages`, `message_reactions`, `messaging_seen`, `messaging_postbacks`, `messaging_referrals`, and `messaging_policy_enforcement`. Webhook requests are HMAC-verified against their unchanged raw bytes, normalized to routing metadata without message bodies or attachment URLs, stored as encrypted durable receipts, and acknowledged quickly. A worker then reconciles the authoritative conversation/message edges. Provider unsend/delete events immediately remove the stored body and attachments while keeping a non-sensitive tombstone.

The connector follows the official Meta sample edge family: `/{pageId}/conversations?platform=messenger|instagram`, `/{conversationId}?fields=id,messages`, `/{messageId}?fields=id,to,from,message`, and `POST /{pageId}/messages` with `messaging_type=RESPONSE`. Access tokens are sent in the Authorization header and requests include app-secret proof. Graph errors are classified separately from transport-uncertain outcomes so the worker never blindly retries a possibly successful reply.

## Privacy and storage

- Provider conversation, participant, message, and attachment identifiers are encrypted at rest.
- Message bodies and reply drafts are encrypted with AES-256-GCM.
- Lookup and integrity values use a keyed HMAC, not a plain content hash.
- Public API responses remove provider identifiers, HMAC values, raw payload hashes, idempotency keys, lease details, and attachment URLs.
- Approval can inspect policy eligibility but cannot read the provider recipient identifier needed to send.
- Only the worker receives exact send identifiers after an atomic claim.
- Retention cleanup runs at startup and every six hours. It removes expired message bodies, reply bodies, participant profiles, and old webhook receipts while keeping non-sensitive tombstone records.

## Main API routes

- `GET /v1/private-conversations`
- `GET /v1/private-conversations/:conversationId`
- `PATCH /v1/private-conversations/:conversationId`
- `POST /v1/private-conversations/:conversationId/read`
- `POST /v1/private-conversations/:conversationId/refresh`
- `POST /v1/private-conversations/messages/:messageId/reply-intents`
- `PATCH /v1/private-conversations/reply-intents/:intentId`
- `POST /v1/private-conversations/reply-intents/:intentId/submit`
- `POST /v1/private-conversations/reply-intents/:intentId/approve`
- `POST /v1/private-conversations/reply-intents/:intentId/cancel`
- `POST /v1/private-conversations/reply-intents/:intentId/reconcile`

All routes are workspace- and brand-scoped. Read, draft, approval, send, and reconciliation permissions are enforced on the server.

## Production gate

Keep `PRIVATE_MESSAGE_CONNECTOR_MODE=disabled` in production until the matching Meta app is Live, required permissions have approved Advanced Access, business verification and Page roles are complete, the exact callback and webhook subscriptions have been reviewed, the approval evidence digest has been recorded, and watched receive/read/reply/unsend tests pass on owned Facebook and linked-Instagram accounts using the pinned Graph version. Re-run those tests before changing `META_GRAPH_API_VERSION` or materially changing the app grant.

OriginPost enforces the normal 24-hour customer-service reply window from reconciled provider evidence. The Human Agent seven-day extension is not implemented, and the application does not send unsolicited or automated DMs. Instagram text is bounded to 1,000 UTF-8 bytes. A manager or owner must approve each exact reply body after a fresh eligibility check.

Disabling provider actions must not disable access to already stored data or retention cleanup. Preserve PostgreSQL backups and all three independent encryption/HMAC keys according to the deployment's disaster-recovery policy.
