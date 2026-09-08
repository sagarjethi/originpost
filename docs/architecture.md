# Architecture

OriginPost is a modular TypeScript monorepo. Each module hides its implementation behind a small interface, and product rules stay independent from HTTP, queues, databases, and social platforms.

## Current modules

| Module | Owns | Does not own |
|---|---|---|
| `domain` | Workflow states, permissions, validation, and audit event shapes | HTTP, SQL, queues, or provider details |
| `db` | Durable PostgreSQL storage and migrations | Product decisions or media bytes |
| `connectors` | Platform capabilities, validation, publishing, checks, and final results | Approval or scheduling policy |
| `agents` | Provider-neutral content assistance and provider adapters | Approval or factual authority |
| `boards` API/domain feature | Top-level Brand-owned agent workspaces, purpose/capability epochs, immutable internal-plugin binding, durable reconciliation/deactivation, pending-write decisions, and hash-only run lineage | Global plugin discovery, raw Hermes profiles, or cross-Board memory |
| `api` | NestJS feature modules, HTTP input/output, trusted request context, and domain commands | Workflow rules or provider implementations |
| `auth` API feature | Password login, hashed sessions, CSRF, workspace membership, and member administration | External identity providers or deployment TLS |
| `worker` | Scheduled, retryable, and idempotent delivery work | Durable scheduling truth |
| `web` | The user workflow | Credentials or direct provider calls |
| `media` API feature | Private upload/download grants, byte verification, bounded server metadata inspection, and media lifecycle | Product drafts, browser-declared media facts, or public object access |
| `operations` API read model | Owner/manager-only workspace health across malware protection, webhook dead letters, media cleanup, publishing reconciliation, and durable delivery | Public liveness, raw infrastructure endpoints, or a new top-level product area |
| `batch-operations` API feature | Multi-file dry-run, row diagnostics, deterministic draft preparation, checkpoints, and human batch approval | Provider publishing or a second CSV importer |
| `share-capture` API feature | Short-lived phone Share Target receipts, streamed one-file quarantine/inspection, governed Library materialization, and idempotent optional conversion into the Content aggregate | Scraping, multi-file/offline capture, native iOS Share Extensions, or a second Idea aggregate |
| `media-organization` deep module | Brand-scoped nested folders, one-folder-per-asset metadata, normalized tags, favorites, search, and atomic optimistic bulk organization | Object-byte mutation, rights changes, media transforms, provider folders, or publishing |
| `source-signals` API feature | Ranked tracked-source findings, human triage, and recoverable promotion into the Content aggregate | Generic website scraping, private guest data, or editorial approval |
| `first-comments` API feature | Publish-proof-bound Instagram/Facebook Page comment intents, separate approval, recovery commands, and sanitized evidence views | Main-post publishing, direct provider calls from HTTP, or blind retries |
| `channels` API feature | Workspace account metadata, Instagram OAuth orchestration, health state, and connection diagnostics | Platform publishing or product workflow rules |
| `instagram-grid` API read model | Brand/account-scoped projection of OriginPost-known profile-visible Instagram targets and proof times | Provider history sync, Stories, or visual reordering |
| `telegram` | Telegram Bot API client and command routing contract | Domain rules or direct connector access |
| `telegram-bot` | Allow-listed long-polling adapter and OriginPost API client | A second content workflow |

The domain interface is the main test surface. PostgreSQL and in-memory repositories are storage adapters. Mock and official platform connectors are publishing adapters.

## First vertical slice

```text
Inbox input
  → Content Item
  → source evidence and facts
  → platform draft
  → approval
  → scheduled target + outbox command (one PostgreSQL transaction)
  → rebuildable publish job
  → mock platform result
  → Proof of Publish
  → audit history
```

## Deployment

Docker Compose provides PostgreSQL, Redis, MinIO, and an opt-in ClamAV service. The web, API, and worker can run through pnpm during development and become separate containers after the alpha workflow is stable.

## Storage contract

- PostgreSQL is the durable source of truth for workspace access, content, evidence metadata, revisions, approvals, schedules, attempts, proofs, audit, and outbox records.
- Redis holds rebuildable queues, short locks, rate limits, and cache data. A schedule must remain recoverable when Redis is empty.
- MinIO or another S3-compatible store holds private media and evidence bytes. PostgreSQL holds their ownership, hashes, rights, lineage, and retention state.
- Provider secrets stay server-side. Manually configured credentials use an opaque `env:`, `vault:`, or `secret:` reference. OAuth provider tokens use an AES-256-GCM encrypted credential record and a `secret:` reference. Secret values and references are removed from API responses and audit detail.

Repository commands are workspace-scoped. Content Item, audit, and publish-outbox writes are atomic. Approvals bind immutable draft revisions, and each connector run creates a durable numbered Publish Attempt. A worker claims outbox commands with expiring leases, enqueues a stable target job ID, and can rebuild missing commands from queued PostgreSQL targets. Trusted membership and Content Item optimistic locking are implemented; other concurrently edited aggregates should adopt version checks as needed.

## API module boundaries

The API uses NestJS with the Fastify adapter. Each feature owns its controller, DTOs, and application service:

- `ContentModule` — content commands, research requests, drafts, approvals, schedules, and audit reads;
- `AuthModule` — self-hosted login, session lifecycle, password changes, and workspace member administration;
- `MonitoringModule` — durable source-monitor rules and run history;
- `SystemModule` — minimal public liveness, connector manifests, agent-provider health, operator delivery recovery, and the protected Organization-scoped operations-health projection with transition-only alerts;
- `ChannelsModule` — workspace-scoped Instagram, Facebook Page, and YouTube account metadata, OAuth orchestration, safe configuration, disconnect state, and Connection Doctor;
- `BatchOperationsModule` — brand-scoped multi-file planning, dry-run diagnostics, durable row checkpoints, deterministic draft creation, and human approval into the normal schedule workflow;
- `ShareCaptureModule` — user-bound URL/text or one-file Share Target intake, hash-only short-lived receipt tokens, streamed quarantine and inspection through `MediaModule`, DB-leased Library materialization, workspace/brand/rights authorization, and deterministic optional conversion into the normal Content Inbox;
- `SourceSignalsModule` — workspace-scoped signal reads, transparent triage, optimistic locking, and recoverable human promotion into the normal Content Inbox;
- `FirstCommentModule` — exact-target comment drafting, separate human approval, publish-proof binding, provider capability checks, uncertainty reconciliation, and operator attestation without exposing provider identifiers;
- `InfrastructureModule` — repository, queue, connector, and agent adapters behind one injection token.

URI versioning keeps product routes under `/v1`. A global validation pipe rejects unknown input. A global exception filter maps domain failures consistently. The global authentication guard supports two explicit modes: trusted local owner for `single-user`, or an opaque HttpOnly session cookie for `sessions`. Session mode resolves the actor role from PostgreSQL membership, rejects cross-workspace access, and requires a per-session CSRF token on changes. Caller-supplied identity and role headers are ignored.

## Content concurrency

Every Content Item has a positive integer `version`. Creation starts at version 1, and every domain state change produces the next version. PostgreSQL updates use compare-and-swap: version N can be stored only when the current row is version N−1. The Content Item, normalized child rows, audit event, and optional outbox commands remain in one transaction, so a conflict rolls back the whole command.

Content mutation routes accept the current version through `If-Match`. A stale value returns HTTP 409 with `content_version_conflict` and the message to refresh and retry. The web client sends its visible version, reloads on this conflict, and never silently overwrites the newer command. Repository compare-and-swap remains the final guard for workers and for two requests that race after both pass the HTTP precondition.

The publishing worker resumes an existing `started` attempt with the same idempotency key after a retry or concurrent-update conflict. It does not create a second attempt merely because the job restarted.

## Source monitor flow

```text
Durable Monitor Rule in PostgreSQL
  → worker startup rebuilds the BullMQ scheduler
  → scheduled or operator-requested run
  → PostgreSQL active-run lock
  → provider-neutral sourcing adapter
  → canonical URL fingerprint check
  → group links by event
  → atomically create one sourced Content Item per new event with its fingerprints
  → inbox for human review
```

Only one run may be active for a monitor. PostgreSQL enforces this with a partial unique index, so concurrent workers cannot create duplicate suggestions. A competing run is recorded as `skipped` with `monitor_already_running`; it does not hide the overlap. Source fingerprints are unique per monitor and ignore common tracking noise. The content item and its fingerprints share one database transaction, preventing crash-created duplicates. Redis schedules are rebuilt from every enabled PostgreSQL rule when the worker starts.

Luma-only tracked-source monitors use a hard-coded, bounded read of Luma's official Mumbai city page. The adapter validates the structured public payload and direct event URLs, retains only scheduled event facts, public or approximate venue text, and displayed host names, and discards guest, attendee, registration-person, and guest-only exact-location fields before returning a result. It fails closed on contract drift and cannot be pointed at another host.

The Automations workspace derives `paused`, `waiting`, `healthy`, `running`, `failed`, `stale`, or `coalesced` health from the durable rule and recent runs. Operators can request a one-off check without changing the repeat schedule. Both scheduled and manual work use the same queue, lock, sourcing adapter, fingerprint rule, and run history. See [monitoring.md](monitoring.md).

## Planned deep modules

- Workspace access — local single-user mode plus password-backed users, sessions, workspace membership, member roles, last-owner protection, and generic OpenID Connect SSO implemented.
- Content workflow — versioned content commands with optimistic conflict protection and immutable draft revisions implemented.
- Evidence — sources, claims, rights, captures, and lineage.
- Review — revision-bound decisions, audience-scoped comments, approval rules, and signed external review rooms implemented.
- Publishing — targets, attempts, callbacks, idempotency, and proof (mock connector path implemented).
- Media — private object upload, workspace ownership, rights, SHA-256 verification, fail-closed ClamAV streaming with durable scan evidence, signed access, trusted metadata inspection, reference-safe lifecycle, and brand-scoped folder/tag/favorite organization implemented.
- Creative production — immutable composition revisions, deterministic template rendering, database-clock leases, multilingual bundled fonts, exact output inspection, and Media Library attachment implemented; unrestricted layer editing, synthetic generation, and video composition remain separate future modules.
- Audit and outbox — append-only history and reliable delivery in the same transaction as state changes (first publish-target version implemented).

## Channel connection diagnostics

```text
Connected Account metadata
  → connector installed check
  → protected credential-reference check
  → provider-capability check
  → public callback safety check
  → expiry check
  → live-vs-test adapter check
  → exact failed step and recovery action
```

Connected-account reads are workspace-scoped. Saving account metadata, its encrypted credential, and its audit event is one PostgreSQL transaction. Raw OAuth tokens and client secrets are rejected by account DTO validation and are never returned to the web app. Auto-scheduling requires a checked account for the same platform and cannot schedule beyond its recorded expiry; the worker repeats the state and expiry check before calling the connector. The current publishing connector is intentionally a safe test adapter, so Connection Doctor shows a warning even when the saved metadata is healthy.

## OAuth credential boundary

```text
Authenticated owner starts connection
  → random state returned to the browser
  → only SHA-256 state hash stored for ten minutes
  → provider callback atomically consumes state
  → provider token exchange stays server-side
  → AES-256-GCM credential bound to workspace + purpose + record ID
  → connected account stores only secret:<credential-id>
```

The callback uses a configured web return URL rather than caller-provided redirect input. A state is single-use even when the provider denies access. In session mode, the callback also confirms that the actor who started the flow still has permission to manage the workspace. Reconnecting the same provider account replaces its encrypted credential within the account-save transaction. New OAuth connections also create a workspace-scoped `ProviderGrant` parent and temporal account links: one Meta authorization may own several Page/Instagram accounts, while credentials remain encrypted on the derived accounts. Provider subjects and Google refresh-grant identities are persisted only as versioned, context-separated HMACs.

Owner-requested and automatic refreshes rotate credentials through the same row-locked previous-reference/expiry fence and update the current parent grant. The automatic worker recovers due direct-Instagram and YouTube generations through PostgreSQL outbox commands; transient failures retry, terminal failures atomically create an action-needed notification, and stale results cannot resurrect a disconnected account or overwrite a reconnect. A separate version-fenced `provider.grant-validation` command validates the complete parent grant and every current child identity. Provider HTTP work stays outside the transaction; the result is committed only against the expected grant version. Confirmed permanent failure atomically blocks all current children and destroys their credentials, while a bounded provider outage schedules another check without a false revocation claim. Publishing reads the persisted winning access token instead of performing an untracked shadow refresh. Facebook Page and linked-Instagram discovery are held in short-lived encrypted server records; the browser receives only allow-listed identity fields, and each explicitly selected target receives a separate encrypted credential.

Meta deauthorization and data-deletion callbacks are a separate privileged lifecycle boundary. They verify the exact raw form body and HMAC signature, derive lookup candidates for every retained HMAC-key version, and perform global matching by Meta app plus app-scoped subject without trusting caller-supplied tenant context. Intake blocks every current linked account and destroys its publishing credential in one transaction. Data-deletion scopes use recoverable outbox work; private messages are crypto-shredded before analytics, engagement, collaborator state, caches, and provider account identity are removed. The public status code is HMAC-derived and only its SHA-256 value is stored. Callback receipts, audits, notifications, and outbox payloads never contain raw subjects or tokens.

Official Instagram, Facebook Page, and YouTube publishing remain behind separate fail-closed settings. Facebook persists a publish intent before the non-idempotent provider write and pauses uncertain results instead of replaying them. YouTube uses an offline refresh grant, an encrypted resumable-session URI, byte-range recovery, provider processing checks, and a private-only compliance gate. The automated grant validator is implemented, but validation against owned live accounts, watched provider callbacks, secret-rotation drills, and real-provider publishing verification remain deployment work.

## Publish delivery recovery

```text
Schedule command
  → PostgreSQL transaction: target + audit + outbox event
  → worker claims event with an expiring lease
  → BullMQ job keyed by target ID
  → outbox event marked processed
  → idempotent publish attempt + Proof of Publish
```

Redis is execution state, not scheduling truth. If Redis is unavailable, scheduling still succeeds and the outbox remains pending. When the worker returns, it reclaims expired work and reconstructs missing publish commands from queued targets. Terminal failures remain visible through the operations API and Automations screen, where an operator can retry them.

Official provider execution has a second durable boundary. Migrations 018–019 and 029 add one workspace-scoped `ProviderPublishOperation` per Instagram, Facebook Page, or YouTube target with the attempt ID and explicit `processing`, `ready`, `finalizing`, `published`, `uncertain`, or `failed` state. Instagram stores container state. Facebook stores the immutable intent and returned Page post ID; a `finalizing` operation without that ID cannot be posted again automatically. YouTube stores an AES-GCM-protected resumable-session URI, confirmed byte offset, and video ID. The worker persists `finalizing` before an irreversible provider call; a restart probes the saved provider operation instead of creating another upload.

## Security defaults

- Live publishing is off.
- Single-user mode is local-trust only; team deployments use session mode.
- Session cookies are opaque and HttpOnly; only their SHA-256 hashes are stored.
- Unsafe session requests require a per-session CSRF token.
- Credentials remain server-side.
- Connector calls are idempotent.
- Every mutating command records an audit event.
- Boards are top-level product objects; their built-in Hermes module and hidden approval adapter are visible only inside a selected Board and are reserved from the third-party plugin catalog.
- Roles are checked in the domain layer.
- Sensitive automation requires human approval.
- Public screenshots are evidence records, not automatically licensed media.
- Scheduled monitor discoveries always enter the inbox; they do not auto-approve or auto-publish.
