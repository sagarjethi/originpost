# Boards and the internal Hermes plugin

Boards are a separate top-level OriginPost work area. Each Board belongs to one active Brand. Hermes is a first-party internal module, `org.originpost.hermes-boards`, that appears only after a person opens a Board; it is not another top-level area and is not part of the third-party plugin catalog.

Each Board has its own runtime context: an opaque dedicated Hermes Profile, an opaque Kanban binding, approval-gated memory, and an owner-governed skill policy. None of these contexts is shared with another Board. Assignment to the Board agent does not start work; a manager or owner must explicitly release a ready task.

## Isolation model

OriginPost maps one Board to one opaque, dedicated Hermes Profile and one distinct opaque Kanban binding. The Profile scopes configuration, memory files, skills, state, and credentials; the Kanban binding fences task execution to that Board's work queue. These controls are application/runtime isolation, not an operating-system or filesystem sandbox. A different session key alone would not provide even that state separation, so OriginPost never routes a Board through the default Hermes profile or relies on the multiplex-wide Responses transcript store.

The Profile handle, Kanban reference, per-Profile API key, long-term memory scope, transcript session ID, dashboard token, filesystem paths, raw memory, and raw skill instructions remain server-side. The browser receives only safe status, approved skill metadata, desired/applied state, task state, and review-safe execution history.

The Board purpose is user-authored runtime context, not a Hermes profile description or a routing label. OriginPost sends it only in the per-run instruction boundary. The durable profile description contains an HMAC-derived ownership marker plus a policy digest, so reconciliation cannot take over a coincidentally named or operator-created profile. Profile references are globally unique in PostgreSQL and immutable after Board creation.

References: [Hermes Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/), [v0.21.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31), and [v0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11).

## First-release policy

- Hermes is pinned to version `0.21.2` and source commit `939e45c91d751fadd94dcd1b873ac3cb44846213`; both are checked by the hidden execution extension.
- Profile creation is idempotent and uses an OriginPost-owned opaque handle. Every Board also receives a separate immutable `opk_…` Kanban reference that is included in the signed policy, execution headers, and hidden-plugin receipt identity.
- `memory.memory_enabled` and `memory.user_profile_enabled` are on.
- `memory.write_approval` and `skills.write_approval` are always on.
- The effective API-server toolsets are restricted to `memory` and `skills`. Hermes' `no_mcp` sentinel is also pinned in configuration, the built-in `compressor` context engine is required, and external memory providers and model fallback chains are disabled. External skill directories, project skill discovery, trusted project roots, inline skill shell expansion, and Profile plugins are explicitly disabled. Terminal, files, browser automation, messaging, cron, peer delegation, code execution, and MCP capabilities are not granted.
- The `skills` toolset is needed for Hermes to load an enabled Board skill. It exposes the official skill reader plus `skill_manage`; both skill and memory writes remain approval-gated, and OriginPost does not silently approve runtime write requests. Skill enablement itself is performed only by the owner-governed OriginPost reconciliation path.
- Only skills preinstalled and named in `HERMES_BOARD_APPROVED_SKILLS` can be enabled by a Board owner. Hermes' mandatory bundled `hermes-agent` skill is attested as an internal system baseline, never shown as a Board toggle, and never included in Board desired/applied state. OriginPost does not install community skills in this release.
- Every profile is pinned to the operator-selected `HERMES_BOARD_PRIMARY_MODEL`. This internal plugin accepts only the `openai-codex` provider and pins `model.openai_runtime` to `auto`, which must resolve to Hermes' normal `codex_responses` agent loop. The `codex_app_server` shortcut is rejected because it delegates outside the attested four-tool surface and does not provide this Board memory contract. A Codex credential must be configured inside each dedicated Hermes profile.
- `model.max_tokens` is pinned to 4,000 because Hermes 0.21 does not honor a Responses-body `max_output_tokens` override. OriginPost omits that misleading request field.
- Existing memory text is not listed or edited through OriginPost. Pending memory proposals and pending skill-file changes can be reviewed only through the hidden, authenticated `originpost-board-approvals` Hermes dashboard backend extension. The extension has no tab, accepts only opaque Board profiles, uses Hermes' context-local profile override, exposes bounded one-record previews, requires an exact SHA-256 plus an idempotency key, and never supports `approve all`. Without the extension, the Board UI truthfully shows pending review as unavailable and nothing is auto-approved.
- Skill or purpose changes increment a capability epoch and rotate the per-profile API key, while the stable Board memory scope remains unchanged. Approving a pending skill-file write immediately marks the existing skill seal pending, moves the Board back to provisioning, and durably queues a fresh seal before another run or new skill decision is allowed.
- Board runs execute in a fresh, killable child process rather than the dashboard process or the multiplex-wide Responses transcript store. The child enters Hermes' official Profile runtime and credential scope, uses the Board Profile as `HERMES_HOME`, and uses a verified empty process `HOME` and `CODEX_HOME` inside that Profile. This blocks both Hermes' global-auth fallback and the operator's `~/.codex/auth.json`. It constructs one real `AIAgent`, attests it, runs it, re-attests it, then exits. Durable Board learning is limited to the dedicated Profile's approval-gated built-in memory.
- Board profiles pin empty `fallback_providers` and legacy `fallback_model` settings. OriginPost never falls back to another profile or provider.
- Readiness is attested from the live Board Profile, not inferred from desired state. OriginPost reads back the exact primary provider/model/output cap, memory flags/provider, both write-approval flags, context engine, no-MCP sentinel, empty fallback chains, external/project/inline/plugin restrictions, configured toolsets, enabled skill catalog, `/v1/toolsets` effective tool names, and the authenticated Profile-scoped `/health/detailed` model check. Its hidden extension additionally verifies path containment, the sealed skill-tree manifest, Hermes source SHA, and the exact registry/final schemas and handler provenance of all four permitted tools. Any unavailable attestation, absent Profile credential, broader or injected tool, same-name override, skill-content drift, missing desired skill, disabled desired skill, symlink escape, or other policy drift fails closed.
- Every run repeats that policy attestation immediately before sending its prompt. A Board with runtime drift cannot execute even if an older database observation said it was ready.
- Run completion is fenced again inside the repository transaction. If purpose, skills, readiness, archive state, configuration epoch, or capability epoch changed while Hermes was working, the response is discarded and is not written to the run ledger or returned as current Board output.

## Board-task operating flow

1. A person creates and triages a Board Task, records any dependencies, and assigns the execution owner as **Team** or **Board agent (Hermes)**. Assignment does not authorize Hermes to act.
2. A Board-agent task can move to **Ready** only when its dependencies are complete. The Board itself must also be ready, with no pending plugin decision and matching observed/current policy epochs.
3. A manager or owner selects **Release to Hermes**. OriginPost requires the exact task version and an idempotency key, changes the task to **Running**, creates one queued Board Task Execution, and commits its audit event and outbox command atomically.
4. The worker claims that execution with a lease and performs at most one Hermes invocation for its execution ID. It sends only the released task plus the server-pinned Profile, Board memory scope, enabled-skill manifest, Kanban binding, configuration epoch, and capability epoch. The queue job itself cannot widen that policy and has no automatic execution retry.
5. Before invocation, the hidden extension re-attests the Board policy and writes an `applying` receipt in the dedicated Profile. A completed invocation replaces it with an immutable result receipt. Re-delivery of the same execution ID returns the completed receipt; a different request or an incomplete prior receipt is rejected instead of invoking Hermes again.
6. OriginPost stores the execution outcome in PostgreSQL. Confirmed output moves the task to **Review** and is shown separately from completion. A human manager or owner must inspect it and mark the task **Done**; the Board agent cannot approve its own work.

A failure confirmed before invocation blocks the task with a safe reason. A lost response, expired lease, post-invocation error, incomplete receipt, or Board-policy change after Hermes returns is treated as **Uncertain** and also blocks the task. OriginPost never retries an uncertain call automatically. An operator must inspect the execution history and Profile-local receipt/state before a person returns the task to **Todo**, moves it back to **Ready**, and deliberately creates a new release.

Board Task Execution is not a publishing path. It cannot create an Approval, Publish Target, Publish Attempt, or Proof of Publish, and it cannot call social connectors. Reviewable output must enter the normal Content Item and Draft Revision workflow before anything can be approved or published.

## Durable lifecycle

Board and desired skill policy changes are committed to PostgreSQL with an audit event and a `board.plugin.reconcile` outbox message in one transaction. The worker dispatches a BullMQ job, rereads the current Board, rejects stale configuration epochs, reconciles the dedicated profile, then stores observed state. Startup and periodic recovery recreate missing reconciliation commands from PostgreSQL. An owner can explicitly retry setup through the same durable path.

The lifecycle is `setup_required` → `provisioning` → `ready` or `attention`. An archived Board cannot change skills or run. Archiving increments both epochs, rotates the profile key, durably queues toolset shutdown and removal from the Hermes multiplex allowlist, and retains the profile, isolated memory, desired/observed policy, run ledger, and audit history. Deleting or purging a Hermes profile is intentionally not implemented.

The Board opens on its own Work surface. Its task columns and governed release flow are separate from the optional free-form **Run** panel. For free-form runs, creators, managers, and owners can run a ready Board; raw prompt and response text stays ephemeral in the browser while PostgreSQL stores only hashes, model/token metadata, timing, and outcome. A deliberate **Send to Content Inbox** handoff creates a normal Content Item for source checking and human review.

Released Board Task Executions instead store their bounded result text and result hash durably so that reviewers can inspect the exact output later. The browser sees only the review-safe execution projection; it never receives the idempotency hash, request fingerprint, claim/lease data, Profile handle, memory scope, Kanban reference, or runtime credentials. Neither kind of Board response is publishing authority.

Hermes profile allowlist reconciliation is globally serialized with worker and queue concurrency of one. Hermes 0.21 stores that allowlist as a shared read-modify-write setting, so this prevents two Boards from overwriting each other during concurrent setup or archive operations.

Run history stores request/response SHA-256 values, model, token counts, latency, outcome, and a safe error code. It never stores the raw prompt, response, memory, provider body, or credentials in the ledger or audit detail.

## Roles

- Viewer: view Boards, Board Tasks, review-safe execution history, and safe plugin status.
- Creator: create and manage tasks and use a ready Board's free-form Run panel, but cannot release Board-agent work or approve a task as done.
- Manager: Creator permissions plus releasing a ready Board-agent task and completing its separate human review.
- Owner: Manager permissions plus creating, editing, archiving, testing, and changing the Board's skill policy.
- Worker: reconcile only the server-stored desired state. It cannot widen policy from a queue payload.

## Current availability and limitations

- The internal Hermes plugin is disabled by default and truthfully remains **Setup required** until session authentication, PostgreSQL, Redis, both trusted Hermes endpoints, the shared secrets, an approved model, and a credential inside each dedicated Profile are configured.
- Only an exact, clean Hermes 0.21.2 checkout at commit `939e45c91d751fadd94dcd1b873ac3cb44846213` is accepted. This repository's tests and attestation contract do not substitute for the required watched two-Board canary in the operator's own environment; the project does not claim that canary has been completed.
- Board skills must already be installed and operator-approved. This release does not install community skills, expose raw skill files, or expose/edit existing memory through OriginPost.
- The Kanban binding is currently a private isolation and execution-fencing identity in the signed OriginPost/Hermes contract. It does not create a second user-visible Hermes Kanban UI or synchronize arbitrary native Hermes cards.
- There is no automatic Content Item creation or automatic publishing. While the current successful Board-agent result is still in **Review**, a manager or owner may deliberately create one normal, unapproved Content Inbox item from it. The handoff is idempotent, preserves the exact task/execution/result-hash provenance, and creates no Draft Revision, Approval, Publish Target, Publish Attempt, or Proof of Publish.
- There is no automatic reconciliation or retry for an uncertain Board Task Execution. Operators inspect the stored execution and the dedicated Profile receipt/state, then decide whether a new human release is safe.

### Hermes 0.21.2 native-Kanban audit

The exact pinned Hermes source has useful per-board storage, but not a safe external-projection API for OriginPost Board Tasks. `hermes_cli/kanban_db.py` accepts the opaque `opk_…` value as a native board slug and stores named boards under the shared Hermes Kanban root. Its public `create_task` call checks an idempotency key, but always generates a Hermes task ID and exposes only normal worker lifecycle states: an ordinary task becomes `ready`, `triage=True` becomes `triage`, and `initial_status` accepts only `running` or `blocked` (with an unblocked, dependency-free `running` request normalized to `ready`). There is no `external`, `mirror`, `observing`, or non-dispatch flag. The idempotency key has a non-unique index and is checked before the write transaction; the source explicitly permits a concurrent-create race to insert two rows, so it cannot be the exactly-one external identity fence by itself.

Those normal states are unsafe for a passive OriginPost projection under Hermes' shipped defaults:

- `ready` cards are dispatcher work; an unassigned card can also receive `kanban.default_assignee`.
- `review` cards are dispatcher work while `kanban.review_dispatch` is enabled, which defaults to `true`.
- `triage` cards are candidates for the gateway's automatic decomposer while `kanban.auto_decompose` is enabled, which defaults to `true`.
- a synthetic `running` card without a real claim is requeued to `ready` by orphan reconciliation, which defaults to enabled.
- `initial_status="blocked"` is initially non-dispatched, but `recompute_ready` promotes a dependency-free block that has no sticky `kanban_block` event. Creating and then explicitly blocking are separate public operations with a dispatcher race, and a permanent block would falsely report a successful or in-review OriginPost execution as blocked.

Hermes' public `request_review` transition does not close this gap: it accepts only `running` or `ready`; a live claim requires its exact run ID (or an explicit force override), and there is no safe `triage` → `review` projection transition. Lifecycle hooks observe Hermes transitions after commit; they do not provide an API for importing externally owned task state. Writing Hermes' SQLite tables directly would couple this plugin to private schema and bypass lifecycle invariants, so OriginPost does not do that.

There is also a path-resolution fence to address before native synchronization. Although callers can pass `board=<opaque-ref>`, the 0.21.2 `_board_path` implementation checks process-global `HERMES_KANBAN_DB`, `HERMES_KANBAN_WORKSPACES_ROOT`, and `HERMES_KANBAN_ATTACHMENTS_ROOT` overrides before deriving the named-board path. A deployment-level override could therefore collapse otherwise distinct Board references onto shared storage unless a future adapter rejects those overrides or Hermes makes the explicit board argument authoritative.

Enabling Hermes' `kanban` toolset is not a workaround. It would expand the currently attested four-tool model boundary and grant lifecycle mutations such as create, claim, complete, block, and request-review. That conflicts with OriginPost's manager release gate, human completion gate, and rule that Hermes can neither approve nor publish.

For this release, the authoritative observability surfaces remain the PostgreSQL Board Task Execution ledger and the Profile-scoped durable execution receipt. Both are keyed and fenced by the OriginPost task/execution IDs, exact policy epochs, Profile, and opaque Kanban reference; receipt replay never invokes the model twice. A future native-Kanban adapter should require an upstream API with all of the following before it is enabled:

1. an externally owned or mirror task/card mode that the dispatcher, review dispatcher, decomposer, and orphan reconciler categorically ignore;
2. a caller-supplied stable external ID with uniqueness scoped to an explicit board;
3. append-only progress/result observations and a non-executing review state, without `force=True` or a fabricated worker claim;
4. explicit-board path resolution that cannot be superseded by process-global DB/workspace/attachment overrides; and
5. a read API returning the mirrored record plus its external ID, state, event cursor, and content hash for reconciliation.

Until that contract exists, creating native cards would reduce—not improve—isolation and run correctness. The opaque Kanban reference therefore remains a signed execution fence and reserved future native-board identity, not a claim that card synchronization is active.

## Setup

Keep `HERMES_BOARD_PLUGIN_ENABLED=false` until all prerequisites are ready. The API and worker both require session authentication, PostgreSQL, Redis, the same Board secret, and trusted Hermes control/execution endpoints.

```dotenv
AUTH_MODE=sessions
HERMES_BOARD_PLUGIN_ENABLED=true
HERMES_BOARD_SUPPORTED_VERSION=0.21.2
HERMES_BOARD_SECRET=<at-least-32-random-bytes>
HERMES_DASHBOARD_URL=http://127.0.0.1:9119
HERMES_DASHBOARD_SESSION_TOKEN=<shared-OriginPost-Board-plugin-token>
HERMES_API_URL=http://127.0.0.1:8642
HERMES_BOARD_PRIMARY_PROVIDER=openai-codex
HERMES_BOARD_PRIMARY_MODEL=<actual-model-id>
HERMES_BOARD_APPROVED_SKILLS=news-research,content-planning
```

For Docker-to-host HTTP, set the two URLs to the trusted host endpoint and explicitly set `HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS=true`. Do not expose either Hermes administration surface to the public internet.

Start the Hermes dashboard from an exact clean checkout using a Python virtual environment outside the checkout. Set `ORIGINPOST_BOARD_PLUGIN_TOKEN` and Hermes' own `HERMES_DASHBOARD_SESSION_TOKEN` to exactly the same 32-byte-or-longer value, and set `PYTHONDONTWRITEBYTECODE=1`. OriginPost's generic Profile/config/secret/skill calls require Hermes' official session-token header; the hidden plugin independently rejects every extension route when its matching token is absent, short, or wrong. OAuth-cookie-only dashboard mode is not sufficient for these direct service-to-service calls. Remove any ignored `*.py`, `*.pyc`, `*.pyo`, native extension, in-tree virtual environment, or `__pycache__` artifact from the exact Hermes checkout before startup.

Start the Hermes dashboard and multiplexed gateway, then start OriginPost. Creating a Board queues Profile provisioning. The first reconcile writes the Profile key, primary-model policy, approval policy, restricted toolsets, no-MCP/context/memory/fallback/plugin boundary, and default-profile multiplex allowlist, then seals the exact enabled skill tree. Configure the chosen Codex credential inside that Profile before retrying setup; the worker never borrows the default Profile's credential. Readiness requires both the gateway's configured-tool report and a hidden-plugin probe in a killable child process. Board execution repeats the same source, credential, tool, and skill checks around the model run. A green configuration check does not replace the final live two-Board canary required before enabling production use.

To enable isolation attestation and pending-write review, copy `integrations/hermes/originpost-board-approvals/dashboard` to `~/.hermes/plugins/originpost-board-approvals/dashboard` and restart the Hermes dashboard. Install is deliberately blocked in practice until the local Hermes runtime is an exact, clean Git checkout of 0.21.2 at commit `939e45c91d751fadd94dcd1b873ac3cb44846213`; the extension checks that identity and rejects any tracked or untracked source change on every request.

## API surface

- `GET/POST /v1/boards`
- `GET/PATCH /v1/boards/:id` with `If-Match` for changes
- `GET /v1/boards/:id/plugins/hermes`
- `PUT /v1/boards/:id/plugins/hermes/skills` with `If-Match`
- `PUT /v1/boards/:id/plugins/hermes/skill-policy` with `If-Match`
- `POST /v1/boards/:id/plugins/hermes/test`
- `POST /v1/boards/:id/plugins/hermes/reconcile` with `If-Match`
- `GET /v1/boards/:id/plugins/hermes/pending/:subsystem/:pendingId` (owner only)
- `POST /v1/boards/:id/plugins/hermes/pending/:subsystem/:pendingId/decision` with exact SHA-256 and `Idempotency-Key` (owner only)
- `GET/POST /v1/boards/:id/tasks`
- `GET/PATCH /v1/boards/:id/tasks/:taskId` with `If-Match` for changes
- `POST /v1/boards/:id/tasks/:taskId/release` with `If-Match` and `Idempotency-Key` (manager or owner)
- `POST /v1/boards/:id/tasks/:taskId/handoff` with `If-Match` and `Idempotency-Key` (manager or owner; current successful review result only)
- `GET /v1/boards/:id/tasks/:taskId/executions`
- `GET/POST /v1/boards/:id/tasks/:taskId/comments`
- `POST /v1/boards/:id/runs`
- `GET /v1/boards/:id/runs`

OriginPost intentionally does not proxy the Hermes dashboard, arbitrary configuration, `.env`, SOUL, terminal, MCP, peer, browser, cron, memory contents, skill contents, or skill-hub installation.
