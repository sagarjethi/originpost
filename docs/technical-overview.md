# OriginPost

**From source to published proof.**

OriginPost is an open-source, self-hosted social content operating system. It brings research, source evidence, writing, creative production, approval, scheduling, publishing, and proof into one workflow.

## First alpha scope

- Inbox and AI Suggestions entry points
- One Content Item for sources, facts, drafts, media, approvals, schedules, results, and analytics
- Optimistic Content Item versions with `If-Match` conflict protection and refresh guidance
- Quick, Standard, and Deep research modes
- Queued source research with saved source links, claims, dates, provider, and tool history
- Simple roles: Owner, Manager, Creator, Viewer
- Multiple workspaces and brands with a persistent active context and brand-isolated content, media, monitors, and publishing accounts
- Optional self-hosted multi-user login with HttpOnly sessions, CSRF protection, password hashing, OpenID Connect SSO, one-time Workspace invitations, workspace membership, and last-owner protection
- Human approval by default
- A complete Content Studio for immutable draft revisions, rights-cleared media, exact-revision decisions, platform preview, and Instagram, Facebook Page, and YouTube scheduling
- A deterministic Creative Studio with an internal, opt-in OpenAI GPT Image visual-foundation generator; immutable generation lineage and disclosure propagation; three structured templates; exact square/portrait PNG and Story JPEG outputs; multilingual bundled fonts; durable render recovery; and safe attachment into the existing draft/approval workflow
- Immutable draft revisions with approvals locked to the exact draft hash
- Revision-bound review comments with internal, reviewer, and public audience scopes
- Signed, expiring, revocable reviewer links for one exact draft revision
- Instagram feed posts, Reels, basic image/video Stories, Facebook Pages, and YouTube Shorts as first-class publishing targets
- Mock connectors for safe local testing
- Permanent Proof of Publish records
- Proof-linked Instagram, Facebook Page, and YouTube post analytics with explicit missing, stale, unsupported, and permission states; compatible-snapshot trends only
- Explicit publication evidence provenance: mock runs stay labeled as simulations; simulations and unverified legacy proofs never expose fake live links or enter client reports
- Proof-backed Client Report Studio with reusable multi-brand definitions, immutable snapshots, honest cross-provider metric rules, revocable read-only links, and CSV export
- Proof-linked Instagram Engagement Inbox with signed webhooks, durable reconciliation, per-user read state, and human-approved replies
- Governed Instagram and Facebook Page First Comments with exact publish-proof lineage, separate human approval, read-back evidence, and reconcile-only uncertainty recovery
- Durable, numbered publish-attempt history for retries and failures
- A real workspace calendar with explicit IANA time zones, UTC display, safe rescheduling, cancellation history, and filtered active-Brand CSV export
- Account-scoped posting queue profiles with DST-safe next-slot previews, atomic conflict-free reservation, idempotent replay, cancellation release, and ordinary publish-proof lineage
- An honest Instagram three-column profile projection for OriginPost-known scheduled/published images, carousels, and feed-visible Reels, with signed private previews and no provider-history claim
- Transactional publish outbox with worker recovery and operator retry controls
- PostgreSQL persistence with an in-memory development fallback
- Redis/BullMQ background jobs
- Scheduled source monitors with startup recovery, event grouping, tracking-safe URL deduplication, atomic inbox delivery, cross-check status, and run history
- Source Signal Desk with transparent ranking, human promotion into the Content Inbox, RSS/Atom tracking, and a bounded public-host-only Luma Mumbai adapter that runs independently of the mock general researcher
- Evergreen Refresh Queue that turns a proven publish proof into a fresh human-reviewed draft with bounded dates and repeat counts
- Delivery health and recovery status in the Automations workspace
- Owner/manager operations health for ClamAV signatures, webhook dead letters, media cleanup, uncertain publishing, and durable delivery queues
- A durable workspace notification center for approval requests, manual handoffs, publish failures, monitor findings/failures, and connection warnings
- Stable workspace URLs for Home, Boards, Content, Calendar, Help, and every specialist module, with refresh and browser Back/Forward restoration plus compatibility for earlier `?module=` links
- Workspace-scoped provider grants that group shared Meta/Google access over derived publishing accounts, with HMAC-only subject lookup, version-fenced automatic authorization validation, signed Meta deauthorization/data-deletion callbacks, and recoverable local erasure
- Optional allow-listed Telegram command adapter
- Workspace-controlled OpenAI-compatible text runtimes with encrypted BYOK credentials, health testing, brand assignment, multilingual Content Studio drafting, usage ledger, and no silent provider fallback
- Top-level, Brand-owned Boards with a first-party internal Hermes plugin pinned to 0.21.2 at source commit `939e45c91d751fadd94dcd1b873ac3cb44846213`; each Board has its own opaque Profile, memory, skill policy, and Kanban binding, plus manager release, one-attempt task execution, durable receipts, separate human review, and an explicit provenance-preserving handoff into an unapproved Content Inbox item
- Instagram Reel cover review with a custom Library image, measured video frame, or Instagram default; exact settings approval and cover proof
- Approval-bound Instagram native AI disclosure with exact provider placement, read-back verification, and requested-versus-observed publish proof
- Private S3-compatible media storage with short-lived upload/download URLs, workspace ownership, rights, byte-size/SHA-256 verification, fail-closed ClamAV streaming, and bounded server-measured image/video metadata
- Governed Media Library lifecycle with upload leases, reference-safe recoverable Trash, storage summaries, durable cleanup retries, deletion audit history, nested brand folders, tags, favorites, search, and atomic bulk organization
- Scoped Automation Gateway for API keys, idempotent commands, staged CSV/JSON imports, signed lifecycle webhooks, durable retries, and delivery history
- Batch Operations for governed multi-file upload, non-mutating dry-run, durable row-level results, deterministic draft recovery, and explicit human batch approval
- Mobile Share Capture for signed-in URL/text intake from the phone Share menu, short-lived hash-only receipts, safe replay, and conversion into the existing Content Inbox
- Connector-owned Instagram/Facebook/YouTube media preflight with cleared-rights enforcement and exact media hashes in publication proof
- Short-lived, hash-bound provider media delivery links that stream approved private objects without exposing bucket keys
- Opt-in official Instagram adapter for images, mixed carousels, Reels, and basic Business-account Stories, with durable container state, restart recovery, protected media delivery, and manual proof recovery for uncertain results
- Manual Instagram handoff with due-state acknowledgement and publish proof capture
- Brand-scoped Instagram, Facebook Page, and YouTube account records with safe secret references, expiry states, and step-by-step Connection Doctor results
- Instagram OAuth connection with one-time state, an encrypted deployment credential store, durable direct-token renewal, race-safe reconnect/rotation, and no token exposure to the browser, outbox, notifications, or audit history
- Facebook Login for Business connection with server-side Page discovery, explicit multi-Page selection, encrypted Page credentials, text/single-image publishing, durable uncertain-write recovery, and verified permalink proof
- YouTube OAuth with durable offline renewal, atomic encrypted credential rotation, persisted-token publishing, explicit channel identity, required audience/synthetic-media choices, private-only compliance gate, resumable range uploads, processing checks, and encrypted upload-session recovery

## Start locally

Requirements: Node.js 22+, pnpm 10+, and Docker.

```bash
cp .env.example .env
docker compose up -d postgres redis minio
pnpm install
pnpm db:migrate
pnpm dev
```

The root `.env` file is loaded by the development command and shared with the web, API, and worker processes. Keep secrets in `.env`; it is ignored by Git.

The browser always calls the relative `/v1` or `/public/v1` path on the web origin. Next.js proxies those requests to the server-only `ORIGINPOST_API_UPSTREAM`, which defaults to `http://127.0.0.1:4000` for local development. Do not add a public browser API URL. Docker Compose builds the web image with the private `http://api:4000` upstream.

Source research starts in safe mock mode. To use a separate Hermes Agent server, set `AGENT_MODE=hermes` plus `HERMES_API_URL`, `HERMES_API_KEY`, and `HERMES_MODEL`. See [docs/hermes.md](hermes.md).

Boards are a separate top-level work area. Hermes is an opt-in internal capability inside each Board, not a top-level product area and not part of the discovery-only third-party catalog. A manager or owner may release a ready Board-agent task for one durable execution attempt; a successful result returns to human review, while an uncertain result blocks the task for inspection. Hermes cannot approve its own work or publish it. See [docs/boards.md](boards.md) and the end-to-end [Hermes and local Codex guide](hermes-local-codex.md).

The Telegram adapter is optional and stays off until a bot token and trusted chat allow-list are configured. See [docs/telegram.md](telegram.md).

Images, video, audio, and PDF files use private object storage. The Library calculates a SHA-256 before upload; the API verifies the stored bytes, streams them through the optional ClamAV gate, and records the scan evidence before marking an asset ready. Live publishing refuses to start unless that gate is enabled. See [docs/media.md](media.md).

Nested brand folders, drag and bulk move, tags, favorites, search, and optimistic organization rules are documented in [docs/media-organization.md](media-organization.md).

Manual native-app publishing and signed external draft review are documented in [docs/review-and-handoff.md](review-and-handoff.md). Set a private `REVIEW_LINK_SECRET` of at least 32 characters before sharing reviewer links.

Instagram, Facebook Page, and YouTube setup, advanced test-account setup, and Connection Doctor are documented in [docs/channels.md](channels.md). Provider tokens are encrypted server-side and are never returned to the browser or audit history.

First Comment drafting, approval, provider permissions, execution fencing, evidence, and uncertainty recovery are documented in [docs/first-comments.md](first-comments.md).

Source-monitor recovery, health states, manual checks, and run history are documented in [docs/monitoring.md](monitoring.md).

Protected workspace health, durable incident transitions, and operator-only alerts are documented in [docs/operations-health.md](operations-health.md).

Ranked source triage, the Luma Mumbai preset, public-host privacy rules, and safe Content Inbox promotion are documented in [docs/source-signal-desk.md](source-signal-desk.md).

Proof-backed candidate selection, fresh-draft preparation, human approval, pause/resume, and recovery rules are documented in [docs/evergreen-refresh.md](evergreen-refresh.md).

Calendar time-zone rules and safe rescheduling are documented in [docs/calendar.md](calendar.md). Brand-wide exact duplicate and same-account timing warnings are documented in [docs/schedule-conflicts.md](schedule-conflicts.md). Notification behavior and deduplication are documented in [docs/notifications.md](notifications.md).

Account-specific weekly clocks, atomic next-slot reservation, DST rules, and cancellation release are documented in [docs/posting-queues.md](posting-queues.md).

The account-scoped Instagram profile projection, coverage limits, and signed preview rules are documented in [docs/instagram-grid.md](instagram-grid.md).

The default is trusted local `single-user` mode. For a team, enable session login and invite members from **Organizations**. Invitations use manually shared, one-time fragment links; this release does not send email. Generic OpenID Connect can use the same sessions and membership rules. See [docs/authentication.md](authentication.md) and [docs/openid-connect.md](openid-connect.md).

Workspace, brand, switching, and resource-isolation rules are documented in [docs/organizations.md](organizations.md).

Official post metrics, refresh jobs, data provenance, and honest missing-data rules are documented in [docs/analytics.md](analytics.md).

Instagram comment sync, webhook setup, human approval, and reply safety are documented in [docs/engagement.md](engagement.md).

Encrypted Instagram and Facebook private-message review, local demo setup, retention, and production gates are documented in [docs/private-conversations.md](private-conversations.md).

External systems, n8n, imports, scoped API keys, and signed lifecycle events are documented in [docs/automation-gateway.md](automation-gateway.md).

Multi-file campaign dry-runs, row recovery, and safe human batch approval are documented in [docs/batch-operations.md](batch-operations.md).

Phone Share Target intake, receipt privacy, deduplication, and browser limits are documented in [docs/mobile-share-capture.md](mobile-share-capture.md).

OpenAI, OpenRouter, Ollama, LM Studio, vLLM, and custom text-runtime setup, encrypted-key handling, private-endpoint gates, brand assignment, and usage records are documented in [docs/agent-runtimes.md](agent-runtimes.md).

Custom image, selected-frame, and Instagram-default Reel covers are documented in [docs/instagram-reel-covers.md](instagram-reel-covers.md).

Instagram native AI-label approval, provider verification, proof semantics, and production gates are documented in [docs/instagram-ai-disclosure.md](instagram-ai-disclosure.md).

Deterministic visual composition, immutable creative revisions, renderer recovery, and source-rights rules are documented in [docs/creative-studio.md](creative-studio.md).

ChatGPT image creation is an internal Creative Studio capability, not a top-level product area. It is disabled by default. To enable one-shot generation, set `IMAGE_GENERATION_MODE=openai` and provide the server-only `OPENAI_IMAGE_API_KEY`; do not expose this key to the browser.

Open:

- Web: <http://localhost:3000>
- API: <http://localhost:4000>
- API health: <http://localhost:4000/health>
- MinIO console: <http://localhost:60901>

To build and run the complete stack in containers:

```bash
cp .env.example .env
# Replace every placeholder secret in .env with a unique random value first.
docker compose --profile app up -d --build
```

For release-like media intake, set `MEDIA_MALWARE_SCAN_MODE=clamav` and start both profiles:

```bash
docker compose --profile app --profile malware-scan up -d --build
```

Compose refuses to start the application profile until the review-link, media-delivery, and object-storage secrets are set. The browser reaches NestJS only through the Next.js `/v1` and `/public/v1` rewrites; the API, PostgreSQL, Redis, and MinIO host ports bind to loopback by default. Put a reviewed HTTPS reverse proxy in front of the web service only. `ORIGINPOST_API_UPSTREAM` is server-only and is embedded into Next.js rewrites during the web build, so set it before `next build` in non-Compose deployments.

## Safety

The alpha starts with all platform connectors in `mock` mode and `ALLOW_LIVE_PUBLISH=false`, so a normal local setup cannot publish to a real account. Enable Instagram, Facebook Pages, and YouTube separately with `INSTAGRAM_CONNECTOR_MODE`, `FACEBOOK_CONNECTOR_MODE`, and `YOUTUBE_CONNECTOR_MODE`. Official mode requires live publishing opt-in, HTTPS public media delivery, encrypted OAuth credentials, `MEDIA_MALWARE_SCAN_MODE=clamav`, and the provider settings described in [docs/channels.md](channels.md). YouTube remains private-only unless both the compliance-audit and non-private gates are explicitly recorded. Fake-provider and crash-recovery tests do not replace a watched first publish with the operator's approved provider applications.

Private messaging has a separate fail-closed gate. `PRIVATE_MESSAGE_CONNECTOR_MODE` defaults to `disabled`; `mock` is allowed only for local development and tests and is rejected when `NODE_ENV=production`. The official connector supports Facebook Page Messenger and Instagram accounts linked through Facebook Login, but remains unavailable until session auth, durable infrastructure, a pinned Graph version, separate encryption/HMAC keys, a public HTTPS webhook, explicit account re-consent, and an App Review evidence reference are all present. It does not depend on `ALLOW_LIVE_PUBLISH`. See [docs/private-conversations.md](private-conversations.md) for the rollout checklist and current limitations.

`AUTH_MODE=single-user` trusts anyone who can reach the API, so keep it on a trusted machine or private network. `AUTH_MODE=sessions` adds self-hosted accounts and workspace roles. Public internet deployment still requires HTTPS, secure cookies, a trusted reverse proxy, backups, secret management, and an independent security review.

The Compose deployment includes a checksummed PostgreSQL + object-storage backup and disposable restore drill. See [docs/disaster-recovery.md](disaster-recovery.md); an untested dump is not accepted as recovery evidence.

Before a public commit or release, run the complete source, dependency, secret, build, and migration checklist in [docs/public-release.md](public-release.md). Runtime dependency licenses are recorded in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), and private vulnerability reporting is described in [SECURITY.md](../SECURITY.md).

## Repository layout

```text
apps/web          Next.js user interface
apps/api          NestJS HTTP API on Fastify
apps/worker       BullMQ background worker
apps/telegram-bot Optional allow-listed Telegram command adapter
packages/domain   Workflow, permissions, and audit rules
packages/db       PostgreSQL repository and migrations
packages/connectors  Platform connector contracts and mock adapters
packages/agents   Hermes and future agent-provider adapters
packages/telegram Telegram Bot API client and command router
plugins           Validated third-party extension examples (discovery only)
docs              Product and architecture decisions
```

The **Agent plugins** screen reads the safe local catalog described in [docs/plugins.md](plugins.md). Discovery validates metadata and requested permissions but does not execute third-party code.

The first-party `org.originpost.hermes-boards` module is compiled into OriginPost and appears only inside each Board. It is not installed from, listed in, or executed by the third-party catalog.

## License

OriginPost Community is licensed under AGPL-3.0-only. Future commercial modules must be separately written and separately licensed; they are not part of this Community repository.
