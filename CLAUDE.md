# Repository rules for every agent

## Never commit or push secrets

This is a mandatory rule for every change, commit and push, regardless of the agent or provider (Claude, Codex, Hermes, or another tool).

- Never put real credentials or critical private data into Git: API keys, access/refresh tokens, passwords, signing/encryption keys, private certificates, OAuth grants, cookies, session files, database dumps, private user/customer data, or sensitive screenshots/logs.
- Keep runtime values in ignored local configuration or a secret manager. Commit only clearly fake placeholders in example files. Never paste secrets into issues, PR descriptions, commit messages, documentation, tests, terminal output, or chat.
- Read `.gitignore` before adding new configuration/artifact paths. Stage exact intended files; inspect the staged diff and changed filenames before committing. Do not use `git add -f` for private files.
- Run `node scripts/secret-guard.mjs staged` before committing and `node scripts/secret-guard.mjs history` before pushing. Install the repository hooks with `git config core.hooksPath .githooks`.
- A failed or unavailable secret scan blocks the commit/push. Never bypass hooks with `--no-verify`, disable the scanner, or add broad allowlists to pass a scan. Investigate false positives and use narrowly reviewed test-fixture exceptions only.
- If a real secret is discovered, stop the push, notify the owner without reproducing the value, and revoke/rotate it. Removing it from the latest file is not sufficient if it exists in Git history. Coordinate any history rewrite before changing shared history.
- These checks reduce mistakes; no scanner guarantees that every secret or sensitive image will be detected. Human/agent review is still required.

## Product scope

OriginPost is provider-neutral. Keep text/research, image, voice, publishing and storage providers behind explicit interfaces. Never silently send a project to a different provider when its configured provider fails. Follow `CLAUDE.md` and `agent.md` as the same secret-handling policy, not exceptions to it.

## Project overview

OriginPost is a general-purpose, self-hosted social content workspace: sources → creation → review → scheduling → publishing proof. It supports multiple workspaces and brands. This is an alpha; distinguish working local features from live provider capabilities.

- Keep publisher names, logos, handles, language preferences, templates, and source lists in workspace/brand configuration.
- Do not import code, runtime settings, credentials, or branding from sibling projects or legacy publisher-specific bots.
- Preserve workspace and brand isolation in every API, query, job, and media operation. Enforce permissions on the server.
- The operator controls storage, keys, and backups. External providers still receive the data required for enabled operations.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js interface and same-origin API proxy |
| `apps/api` | NestJS API, authentication, and workflow services |
| `apps/worker` | Background collection, scheduling, and publishing jobs |
| `apps/telegram-bot` | Optional generic Telegram adapter |
| `packages/domain` | Workflow rules, permissions, and shared types |
| `packages/db` | PostgreSQL repositories and migrations |
| `packages/connectors` | Social platform adapters |
| `packages/agents` | Agent provider interfaces |
| `packages/telegram` | Shared Telegram support |
| `docs` | Feature contracts, setup, and operational guides |

## Setup and development

- Start with [README.md](README.md), [.env.example](.env.example), and [developer setup](docs/local-developer-setup.md).
- Use Node.js 22+ and the pinned pnpm 10.28.2. If needed, prefix commands with `npx --yes pnpm@10.28.2`.
- Preserve existing `.env` values and database volumes. Run either the Docker application services or local development processes, not duplicate API/worker instances.
- Keep browser API requests on relative `/v1` or `/public/v1` routes. `ORIGINPOST_API_UPSTREAM` is server-only and is set before the web build.
- Rebuild shared packages and restart API/worker processes after relevant source edits. Add migrations for schema changes; do not rewrite already-applied migrations.

## Connections and publishing

- Social accounts belong in **Channels** for the selected brand. Supported publishing adapters include Instagram, Facebook Pages, and YouTube; follow [channels.md](docs/channels.md).
- Configure AI runtimes and audio providers separately. A social login does not grant AI access.
- Keep OAuth credentials encrypted server-side. Never expose tokens through browser responses, logs, job payloads, or audit records.
- Default local publishing uses mock connectors and `ALLOW_LIVE_PUBLISH=false`. Do not describe mock results as live publication.
- Preserve approval of the current draft, account/media checks, provider permissions, and publishing proof. Never bypass these checks to make a demo succeed.
- Live use requires the documented session authentication, HTTPS, malware scanning, provider configuration, and any required provider approvals. Follow [public-release.md](docs/public-release.md).

## Change and verification workflow

1. Read the relevant feature documentation and existing implementation before editing.
2. Keep changes scoped; preserve unrelated work and avoid customer-specific defaults or fixtures.
3. Run targeted tests for behavior changes, `pnpm typecheck`, and `pnpm build` as appropriate. Documentation-only edits need link and diff checks.
4. For a release, run `pnpm release:check` and the documented backup/restore checks. A passing build does not prove live provider readiness.
5. Stage exact files, inspect the staged diff, and run the mandatory secret checks above before committing or pushing.

Keep user-facing setup guidance short and actionable. Link to detailed docs instead of duplicating long instructions. Report what was verified and any remaining provider setup accurately.
