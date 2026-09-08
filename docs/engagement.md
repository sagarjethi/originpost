# Meta Community Inbox

OriginPost links Instagram and Facebook Page comments to the exact Proof of Post that created the media. The inbox is workspace- and brand-scoped, stores per-user read markers, and keeps public comments separate from internal review comments.

## Included in this release

- Professional Instagram accounts only (Business or Creator).
- Comment and reply reconciliation against published Instagram proofs.
- Signed Meta webhook verification and durable, deduplicated receipts.
- Fifteen-minute reconciliation so missed, delayed, or duplicated webhooks do not become the source of truth.
- Desktop split inbox and mobile thread view.
- Reply drafts that require manager or owner approval before they enter the provider queue.
- One-shot reply execution. A timeout or interrupted provider-result write becomes `uncertain`; OriginPost does not blindly retry it.
- A queued, processing, or uncertain reply blocks another reply until a manager resolves it. Managers can confirm an uncertain reply as sent or not sent after checking the live conversation.
- Explicit permission, expiry, rate-limit, provider-failure, and uncertain states.
- Ninety-day retention markers for normalized comment and reply data.

OriginPost does not auto-reply, auto-hide, or delete comments in this release.

The Engagement workspace also has a separate encrypted Facebook Page Messenger and Page-linked Instagram DM view. It uses independent permissions, explicit re-consent, retention, approval, and reply-window enforcement; see [private-conversations.md](private-conversations.md). Connecting comments or publishing access alone does not enable private messages.

## Meta setup

Instagram Login requests `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`, and `instagram_business_manage_comments`.

Set a pinned `META_GRAPH_API_VERSION`, `META_APP_ID`, `META_APP_SECRET`, and `META_WEBHOOK_VERIFY_TOKEN`. The public callback is:

```text
GET/POST /v1/channels/webhooks/instagram
```

Live comment webhooks require a public HTTPS callback. Meta also requires Live app mode, Business Verification, and Advanced Access for the comment webhook fields. During development, proof reconciliation can still populate the inbox for app-role accounts that have the required endpoint access.

The receiver validates `X-Hub-Signature-256` against the exact raw request bytes before parsing. It stores only a bounded normalized event and a hash, never the raw webhook body or an access token.

## Safety model

Creators can read comments and draft replies. Managers and owners can approve the exact draft hash and send it. Viewers can only read. Provider comment text is always untrusted plain text and cannot cross the human approval boundary as instructions to an agent.

All comment, thread, action, and webhook rows carry workspace and brand lineage. Provider calls happen only in the worker. Redis is not the durable record: the worker polls PostgreSQL for pending webhook receipts and queued actions every minute. A processing action left stale by a crash becomes `uncertain`, never an automatic provider retry.

## Main routes

```text
GET   /v1/engagement
GET   /v1/engagement/threads/:threadId
PATCH /v1/engagement/threads/:threadId
POST  /v1/engagement/threads/:threadId/read
POST  /v1/engagement/comments/:commentId/reply-drafts
POST  /v1/engagement/actions/:actionId/approve
POST  /v1/engagement/actions/:actionId/cancel
POST  /v1/engagement/actions/:actionId/reconcile
POST  /v1/engagement/proofs/:proofId/refresh
```

Mutating authenticated routes remain protected by the normal OriginPost session and CSRF rules. The public webhook route has separate signature verification.
