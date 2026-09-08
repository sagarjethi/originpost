# Boards and the internal Hermes plugin

Boards are a separate top-level OriginPost work area. Each Board belongs to one active Brand and contains one first-party internal module, `org.originpost.hermes-boards`. Memory and Skills are managed only after opening a Board; they are not global navigation or part of the third-party plugin catalog.

## Isolation model

OriginPost maps one Board to one opaque, dedicated Hermes Profile. Hermes profiles isolate configuration, memory files, skills, and credentials. A different session key alone would not provide that isolation, so OriginPost never routes a Board through the default Hermes profile or relies on the multiplex-wide Responses transcript store.

The profile handle, per-profile API key, long-term memory scope, transcript session ID, dashboard token, filesystem paths, raw memory, and raw skill instructions remain server-side. The browser receives only safe status, approved skill metadata, desired/applied state, and run summaries.

The Board purpose is user-authored runtime context, not a Hermes profile description or a routing label. OriginPost sends it only in the per-run instruction boundary. The durable profile description contains an HMAC-derived ownership marker plus a policy digest, so reconciliation cannot take over a coincidentally named or operator-created profile. Profile references are globally unique in PostgreSQL and immutable after Board creation.

References: [Hermes Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/), and [v0.21.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31).

## First-release policy

- Hermes is pinned to `0.21.0` and checked before profile administration.
- Profile creation is idempotent and uses an OriginPost-owned opaque handle.
- `memory.memory_enabled` and `memory.user_profile_enabled` are on.
- `memory.write_approval` and `skills.write_approval` are always on.
- The effective API-server toolsets are restricted to `memory` and `skills`. Hermes' `no_mcp` sentinel is also pinned in configuration, the built-in `compressor` context engine is required, and external memory providers and model fallback chains are disabled. Terminal, files, browser automation, messaging, cron, peer delegation, code execution, and MCP capabilities are not granted.
- The `skills` toolset is needed for Hermes to load an enabled Board skill. It exposes the official skill reader plus `skill_manage`; both skill and memory writes remain approval-gated, and OriginPost does not silently approve runtime write requests. Skill enablement itself is performed only by the owner-governed OriginPost reconciliation path.
- Only skills preinstalled and named in `HERMES_BOARD_APPROVED_SKILLS` can be enabled by a Board owner. Hermes' mandatory bundled `hermes-agent` skill is attested as an internal system baseline, never shown as a Board toggle, and never included in Board desired/applied state. OriginPost does not install community skills in this release.
- Every profile is pinned to the operator-selected `HERMES_BOARD_PRIMARY_PROVIDER` and `HERMES_BOARD_PRIMARY_MODEL`. The internal `openai-codex` provider is pinned to `codex_app_server`; other providers still require their credentials to be configured inside each dedicated Hermes profile.
- `model.max_tokens` is pinned to 4,000 because Hermes 0.21 does not honor a Responses-body `max_output_tokens` override. OriginPost omits that misleading request field.
- Existing memory text is not listed or edited through OriginPost. Pending memory proposals and pending skill-file changes can be reviewed only through the hidden, authenticated `originpost-board-approvals` Hermes dashboard backend extension. The extension has no tab, accepts only opaque Board profiles, uses Hermes' context-local profile override, exposes bounded one-record previews, requires an exact SHA-256 plus an idempotency key, and never supports `approve all`. Without the extension, the Board UI truthfully shows pending review as unavailable and nothing is auto-approved.
- Skill or purpose changes increment a capability epoch and rotate the per-profile API key, while the stable Board memory scope remains unchanged.
- Board runs use stateless `/p/<profile>/v1/responses` calls with `store: false`; OriginPost does not use Hermes 0.21's multiplex-wide Responses transcript store. Durable Board learning is limited to the dedicated profile's built-in memory.
- Board profiles pin empty `fallback_providers` and legacy `fallback_model` settings. OriginPost never falls back to another profile or provider.
- Readiness is attested from the live Board profile, not inferred from desired state. OriginPost reads back the exact primary provider/model/output cap, memory flags/provider, both write-approval flags, context engine, no-MCP sentinel, empty fallback chains, configured toolsets, enabled skill catalog, `/v1/toolsets` effective tool names, and the authenticated profile-scoped `/health/detailed` model check. Any absent model, broader or injected tool, enabled unapproved skill, missing desired skill, disabled desired skill, or policy drift fails closed.
- Every run repeats that policy attestation immediately before sending its prompt. A Board with runtime drift cannot execute even if an older database observation said it was ready.
- Run completion is fenced again inside the repository transaction. If purpose, skills, readiness, archive state, configuration epoch, or capability epoch changed while Hermes was working, the response is discarded and is not written to the run ledger or returned as current Board output.

## Durable lifecycle

Board and desired skill policy changes are committed to PostgreSQL with an audit event and a `board.plugin.reconcile` outbox message in one transaction. The worker dispatches a BullMQ job, rereads the current Board, rejects stale configuration epochs, reconciles the dedicated profile, then stores observed state. Startup and periodic recovery recreate missing reconciliation commands from PostgreSQL. An owner can explicitly retry setup through the same durable path.

The lifecycle is `setup_required` → `provisioning` → `ready` or `attention`. An archived Board cannot change skills or run. Archiving increments both epochs, rotates the profile key, durably queues toolset shutdown and removal from the Hermes multiplex allowlist, and retains the profile, isolated memory, desired/observed policy, run ledger, and audit history. Deleting or purging a Hermes profile is intentionally not implemented.

The Board opens on its own Work surface. Creators, managers, and owners can run the ready Board there; viewers can inspect only the safe ledger. Raw prompts and responses stay ephemeral in the browser, while PostgreSQL stores only hashes, model/token metadata, timing, and outcome. A deliberate **Send to Content Inbox** handoff creates a normal Content Item for source checking and human review. A Board response is never publishing authority by itself.

Hermes profile allowlist reconciliation is globally serialized with worker and queue concurrency of one. Hermes 0.21 stores that allowlist as a shared read-modify-write setting, so this prevents two Boards from overwriting each other during concurrent setup or archive operations.

Run history stores request/response SHA-256 values, model, token counts, latency, outcome, and a safe error code. It never stores the raw prompt, response, memory, provider body, or credentials in the ledger or audit detail.

## Roles

- Viewer: view Boards and safe plugin status.
- Creator/Manager: view and run a ready Board according to normal content permissions.
- Owner: create, edit, archive, test, and change skill policy.
- Worker: reconcile only the server-stored desired state. It cannot widen policy from a queue payload.

## Setup

Keep `HERMES_BOARD_PLUGIN_ENABLED=false` until all prerequisites are ready. The API and worker both require session authentication, PostgreSQL, Redis, the same Board secret, and trusted Hermes control/execution endpoints.

```dotenv
AUTH_MODE=sessions
HERMES_BOARD_PLUGIN_ENABLED=true
HERMES_BOARD_SUPPORTED_VERSION=0.21.0
HERMES_BOARD_SECRET=<at-least-32-random-bytes>
HERMES_DASHBOARD_URL=http://127.0.0.1:9119
HERMES_DASHBOARD_SESSION_TOKEN=<Hermes-dashboard-session-token>
HERMES_API_URL=http://127.0.0.1:8642
HERMES_BOARD_PRIMARY_PROVIDER=openai-codex
HERMES_BOARD_PRIMARY_MODEL=<actual-model-id>
HERMES_BOARD_APPROVED_SKILLS=news-research,content-planning
```

For Docker-to-host HTTP, set the two URLs to the trusted host endpoint and explicitly set `HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS=true`. Do not expose either Hermes administration surface to the public internet.

Start the Hermes dashboard and multiplexed gateway, then start OriginPost. Creating a Board queues profile provisioning. The first reconcile writes the profile key, primary-model policy, approval policy, restricted toolsets, no-MCP/context/memory/fallback boundary, discovered-toolset deny baseline, and default-profile multiplex allowlist, then reads both the live profile and its effective execution readiness/tools back before it can become ready. Hermes may require a gateway restart before the new `/p/<profile>/...` route becomes available; the Board shows `attention` until an owner restarts Hermes and tests or retries setup. A green configuration check does not replace the final live two-Board canary required before enabling production use.

To enable pending-write review, copy `integrations/hermes/originpost-board-approvals/dashboard` to `~/.hermes/plugins/originpost-board-approvals/dashboard` and restart the Hermes dashboard. Install is deliberately blocked in practice until the local Hermes runtime is exactly 0.21.0; the extension itself also checks the runtime version on every request.

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
- `POST /v1/boards/:id/runs`
- `GET /v1/boards/:id/runs`

OriginPost intentionally does not proxy the Hermes dashboard, arbitrary configuration, `.env`, SOUL, terminal, MCP, peer, browser, cron, memory contents, skill contents, or skill-hub installation.
