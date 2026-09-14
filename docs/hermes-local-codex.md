# Hermes and local Codex guide

Verified against the official OpenAI and Hermes documentation on 2026-09-14.

## Name the components correctly

The local OpenAI terminal client is **Codex CLI**. There is no separate `chatgpt` CLI in this setup. Codex CLI can authenticate with a ChatGPT account for subscription access or with an OpenAI API key for usage-based access.

Hermes Agent can use Codex in two different ways. They are not interchangeable in OriginPost.

## Runtime decision

### OriginPost Board runtime

Use this for the internal Hermes plugin inside an OriginPost Board:

```yaml
model:
  provider: openai-codex
  openai_runtime: auto
```

`auto` must resolve to Hermes' `codex_responses` loop. OriginPost deliberately rejects the `codex_app_server` shortcut for Board execution because a Board run must keep its four-tool, profile-memory, skill-seal, receipt, and approval boundary. Every Board gets a distinct opaque Hermes Profile and a distinct API server key.

### Personal or developer Hermes runtime

Use this only for a trusted local coding agent that needs Codex shell, patching, plugins, and app-server events:

```text
/codex-runtime codex_app_server
```

Hermes then spawns `codex app-server` and projects its events into the Hermes session. This is useful for local development, but it is not the OriginPost Board execution path.

## 1. Install and authenticate Codex CLI

```sh
npm i -g @openai/codex
codex --version
codex login
codex login status
```

`codex login` opens the ChatGPT browser sign-in flow. For API-key authentication, pipe the key through stdin rather than placing it on the command line:

```sh
printenv OPENAI_API_KEY | codex login --with-api-key
```

For a headless host, use `codex login --device-auth` when device-code login is enabled for the account or workspace. Treat the Codex auth cache like a password and never commit or paste it into OriginPost.

## 2. Prepare the pinned Hermes runtime

OriginPost currently requires Hermes `0.21.2`, release tag `v2026.9.11`, at commit:

```text
939e45c91d751fadd94dcd1b873ac3cb44846213
```

Use an exact clean checkout. Keep the Python virtual environment outside the checkout. Confirm both identity and cleanliness:

```sh
git -C /absolute/path/to/hermes-agent rev-parse HEAD
git -C /absolute/path/to/hermes-agent status --short
```

The first command must print the pinned commit. The second must print nothing. The hidden OriginPost extension rejects tracked changes, untracked files, ignored executable Python, bytecode, and an in-tree virtual environment.

## 3. Install the hidden OriginPost extension

From the OriginPost repository:

```sh
mkdir -p ~/.hermes/plugins/originpost-board-approvals
cp -R integrations/hermes/originpost-board-approvals/dashboard \
  ~/.hermes/plugins/originpost-board-approvals/
```

The extension remains a backend-only part of the Board. It adds no Hermes tab and is not exposed in the OriginPost third-party plugin catalog.

## 4. Configure OriginPost while disabled

Run `openssl rand -hex 32` twice. Store the outputs securely as two independent secrets: one Board derivation secret and one dashboard/plugin session token.

```dotenv
AUTH_MODE=sessions
HERMES_BOARD_PLUGIN_ENABLED=false
HERMES_BOARD_SUPPORTED_VERSION=0.21.2
HERMES_BOARD_SECRET=<first-independent-secret>
HERMES_DASHBOARD_URL=http://127.0.0.1:9119
HERMES_DASHBOARD_SESSION_TOKEN=<second-independent-secret>
HERMES_API_URL=http://127.0.0.1:8642
HERMES_BOARD_PRIMARY_PROVIDER=openai-codex
HERMES_BOARD_PRIMARY_MODEL=<approved-model-id>
HERMES_BOARD_APPROVED_SKILLS=news-research,content-planning
HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS=false
```

Keep the plugin disabled until PostgreSQL, Redis, the OriginPost API and worker, Hermes dashboard, Hermes gateway, session authentication, model configuration, and per-Profile credentials are ready.

For Docker-to-host HTTP on an intentionally trusted private network, set the exact trusted host URLs and opt in with `HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS=true`. Never expose the Hermes dashboard or API server directly to the public internet.

## 5. Start Hermes locally

The dashboard process must receive the same session token that OriginPost uses:

```sh
export ORIGINPOST_BOARD_PLUGIN_TOKEN='<same value as HERMES_DASHBOARD_SESSION_TOKEN>'
export HERMES_DASHBOARD_SESSION_TOKEN="$ORIGINPOST_BOARD_PLUGIN_TOKEN"
export PYTHONDONTWRITEBYTECODE=1
hermes dashboard
```

Start the gateway in a second terminal:

```sh
hermes gateway
```

The official Hermes API server defaults to `127.0.0.1:8642` and requires bearer authentication. Do not enable browser CORS for OriginPost: OriginPost connects server-to-server.

## 6. Provision a Board

1. Open **Boards** in OriginPost.
2. Create or select a Board.
3. Open **Hermes settings**.
4. OriginPost creates an opaque dedicated Hermes Profile and applies the restricted policy.
5. Configure the chosen OpenAI Codex credential inside that exact Hermes Profile. Do not clone the default Profile's OAuth token into multiple independent owners.
6. Return to OriginPost and select **Retry setup**.
7. Wait for **Ready**, then use **Check status**.

The browser never receives the Profile handle, API key, filesystem path, raw memory, raw skill instructions, task prompt, or provider response.

## 7. Prove isolation before enabling work

Create two test Boards with deliberately different approved memory and skills. Verify that:

- each Board reports its own Profile, key, memory, state database, Kanban binding, and skill seal through server-side attestation;
- neither Board can read or use the other Board's state;
- an unavailable or mismatched attestation fails closed;
- assigning a task to Hermes does not start it;
- only a manager or owner can release a Ready task;
- a successful result moves to Review and cannot approve or publish itself; and
- an uncertain execution is not retried automatically.

Only after this canary passes should the deployment owner set:

```dotenv
HERMES_BOARD_PLUGIN_ENABLED=true
```

Restart the OriginPost API and worker after changing the flag.

## Board operating flow

```text
Create task
  → resolve dependencies
  → assign Board agent
  → move to Ready
  → manager/owner releases
  → one Hermes execution receipt
  → human Review
  → optional handoff to a new unapproved Content Item
  → normal content approval
  → publish
  → proof
```

Hermes never receives social-publishing authority, cannot approve its own result, and cannot turn a task result directly into Proof of Publish.

## Personal Hermes + Codex app-server

For a separate personal/developer profile:

1. Complete `codex login` separately from Hermes authentication.
2. Start a Hermes chat.
3. Run `/codex-runtime codex_app_server`.
4. Start a new Hermes session; the runtime switch applies on the next session.
5. Run `/codex-runtime` to inspect the active state.

Keep Codex permissions at `:read-only` unless writes are required. Hermes may manage a marked section of `~/.codex/config.toml`; keep user overrides outside that managed block.

If building a custom local backend client directly on Codex, use `codex app-server`. Its default transport is newline-delimited JSON over stdio. Each connection must send `initialize`, then `initialized`, before starting or resuming a thread. WebSocket transport is experimental; keep it on localhost unless it is authenticated and protected by TLS.

## Safe diagnostics

```sh
codex --version
codex login status
curl -fsS http://127.0.0.1:8642/v1/models \
  -H "Authorization: Bearer $HERMES_API_KEY"
docker compose ps api worker web redis postgres
```

Do not include auth files, access tokens, profile paths, full prompts, raw results, or secrets in diagnostic output shared with another person.

## Official references

- [Codex CLI](https://developers.openai.com/codex/cli)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Hermes Codex app-server runtime](https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime)
- [Hermes Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/)
- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [OriginPost Board security contract](boards.md)
- [OriginPost hidden Hermes extension](../integrations/hermes/originpost-board-approvals/README.md)
