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
