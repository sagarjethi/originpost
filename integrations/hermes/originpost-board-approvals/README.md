# OriginPost Board approvals (Hermes dashboard backend plugin)

This is a hidden, version-pinned Hermes 0.21.1 dashboard backend extension. It adds no Hermes tab and is not an OriginPost catalog plugin. OriginPost calls it only from the built-in Hermes panel inside a Board.

Install only after switching the Hermes runtime to a clean Git checkout of exactly `0.21.1` at commit `2237be355906fbe6065ce1815711eee52b2d646e`. Keep its Python virtual environment outside that Git checkout. The extension rejects tracked and untracked source changes plus ignored executable Python code/bytecode, including an in-tree virtual environment:

```sh
mkdir -p ~/.hermes/plugins/originpost-board-approvals
cp -R integrations/hermes/originpost-board-approvals/dashboard ~/.hermes/plugins/originpost-board-approvals/
```

Set one random shared secret of at least 32 bytes in the Hermes dashboard process under both names, and start Python with bytecode writes disabled:

```sh
export ORIGINPOST_BOARD_PLUGIN_TOKEN='<same value configured as OriginPost HERMES_DASHBOARD_SESSION_TOKEN>'
export HERMES_DASHBOARD_SESSION_TOKEN="$ORIGINPOST_BOARD_PLUGIN_TOKEN"
export PYTHONDONTWRITEBYTECODE=1
```

Restart `hermes dashboard` and keep it bound to a trusted private interface. OriginPost's generic Profile/config/secret/skill administration calls use Hermes' official `HERMES_DASHBOARD_SESSION_TOKEN`; the hidden extension independently checks the same value through `ORIGINPOST_BOARD_PLUGIN_TOKEN`. Browser OAuth-cookie mode alone cannot authenticate these direct service-to-service administration calls.

Before starting the dashboard, set `ORIGINPOST_BOARD_PLUGIN_TOKEN` to the exact 32-byte-or-longer secret configured as `HERMES_DASHBOARD_SESSION_TOKEN` in OriginPost. Hermes 0.21.1 does not provide a sufficient authentication boundary for generic dashboard plugin routes, so this extension authenticates every route itself and fails closed when the token is missing.

The extension accepts only OriginPost profile handles. Every hidden request requires both the dashboard token and a fresh HMAC signed by that Board Profile's rotated `API_SERVER_KEY`; the signature binds the method, route, canonical body, nonce, timestamp, ownership marker, memory scope, and policy digest. Nonces are consumed inside the Profile to reject replay. Each Profile pins `model.openai_runtime: auto`, and execution must resolve to Hermes' `codex_responses` loop. The `codex_app_server` shortcut is rejected because it bypasses the attested Board tool and memory boundary.

OriginPost seals the enabled skill names and a digest of every enabled skill package into the Profile contract. Before readiness and before every run, a fresh child process verifies the exact Hermes source commit `2237be355906fbe6065ce1815711eee52b2d646e`, enters Hermes' official Profile runtime/secret scope, rejects external/project/plugin skill sources and symlinks, re-hashes the skill tree, and attests each allowed tool's name, final schema, registry schema, handler module, and handler-file digest. The child has a hard wall timeout and is killed as a process group if it overruns. `HERMES_HOME` points at the Board Profile; `HOME` and `CODEX_HOME` point at verified empty directories inside that Profile. This blocks both Hermes' global-auth fallback and the operator's `~/.codex/auth.json`.

The extension also verifies that the Profile's memory, skills, and runtime-state trees do not escape their Profile root. It lists bounded pending-write metadata, requires an exact record SHA-256 plus an idempotency key for one-record decisions, and never offers an `approve all` operation.

Hermes Profiles are a state-scoping feature, not an operating-system sandbox. OriginPost separately disables filesystem, terminal, browser, MCP, peer, messaging, cron, external-skill, project-skill, inline-shell, and Profile plugin capabilities and re-attests the effective API-server toolset before every Board run.

Run the extension security tests with the Python environment belonging to the approved Hermes checkout:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/path/to/hermes-agent /path/to/external-hermes-venv/bin/python -B -m unittest discover -s integrations/hermes/originpost-board-approvals/tests -p 'test_*.py'
```
