# Boards and the internal Hermes plugin

Boards are a separate top-level OriginPost work area. Each Board belongs to one active Brand and contains one first-party internal module, `org.originpost.hermes-boards`. Memory and Skills are managed only after opening a Board; they are not global navigation or part of the third-party plugin catalog.

## Isolation model

OriginPost maps one Board to one opaque, dedicated Hermes Profile. Hermes Profiles scope configuration, memory files, skills, and credentials, but are not an operating-system or filesystem sandbox. A different session key alone would not provide even that state separation, so OriginPost never routes a Board through the default Hermes profile or relies on the multiplex-wide Responses transcript store.

The profile handle, per-profile API key, long-term memory scope, transcript session ID, dashboard token, filesystem paths, raw memory, and raw skill instructions remain server-side. The browser receives only safe status, approved skill metadata, desired/applied state, and run summaries.

The Board purpose is user-authored runtime context, not a Hermes profile description or a routing label. OriginPost sends it only in the per-run instruction boundary. The durable profile description contains an HMAC-derived ownership marker plus a policy digest, so reconciliation cannot take over a coincidentally named or operator-created profile. Profile references are globally unique in PostgreSQL and immutable after Board creation.

References: [Hermes Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/), [v0.21.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31), and [v0.21.1 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.7).

## First-release policy

- Hermes is pinned to version `0.21.1` and source commit `2237be355906fbe6065ce1815711eee52b2d646e`; both are checked by the hidden execution extension.
- Profile creation is idempotent and uses an OriginPost-owned opaque handle.
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
HERMES_BOARD_SUPPORTED_VERSION=0.21.1
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

To enable isolation attestation and pending-write review, copy `integrations/hermes/originpost-board-approvals/dashboard` to `~/.hermes/plugins/originpost-board-approvals/dashboard` and restart the Hermes dashboard. Install is deliberately blocked in practice until the local Hermes runtime is an exact, clean Git checkout of 0.21.1 at commit `2237be355906fbe6065ce1815711eee52b2d646e`; the extension checks that identity and rejects any tracked or untracked source change on every request.

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
