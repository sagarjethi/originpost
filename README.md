# OriginPost

Self-hosted social content software: collect sources, create a post, review it, publish it, and keep the publishing proof.

**Status: alpha.** Local setup works without social or AI credentials. Live publishing needs your provider setup and account approval.

![OriginPost desktop dashboard](docs/images/admin-desktop.jpg)

*Desktop screenshot with local test records; not evidence of live publishing.*

[Project overview](docs/project-overview.md) · [Developer setup](docs/local-developer-setup.md) · [Architecture](docs/architecture.md)

## How it works

![Find sources, create, review, publish, and keep proof](docs/images/source-to-post.svg)

## Guided server setup

New installations can configure social applications and image generation in **Setup** instead of editing provider values in `.env`.

```sh
node scripts/install.mjs prepare
node scripts/install.mjs start
```

The installer requires Docker Compose and Node.js. It generates private installation files, encryption keys and a first owner account, then starts a separate `originpost-installed` stack. It does not replace an existing installation. Read your sign-in details from the protected `.originpost-install/first-login.txt` file and open **http://127.0.0.1:3100/setup**. The initial API is on port 4100 and object storage on 61900; these ports listen only on loopback. Use an SSH tunnel for first setup on a remote server.

Setup guides the installation owner through public addresses, password and team access, provider applications, connected accounts and the first reviewed post. Provider secrets are write-only in the UI and saved encrypted. Ordinary workspace owners and creators cannot change deployment settings. Meta/Google registration and any required provider approvals still happen with those providers.

Saved server settings require a coordinated restart. When no generation or publication is in progress, run:

```sh
node scripts/install.mjs apply
node scripts/install.mjs status
```

The application reports pending changes until the API reloads its saved version. Check worker health separately; this is not a zero-downtime rollout or a live publishing test. Keep the generated directory private and back it up securely with the database; losing its encryption keys prevents credential recovery. **Never commit it or upload it in support logs.**

Read the [guided installation guide](docs/installation.md) for HTTPS, account connections, access roles and the remaining release requirements. The existing developer setup below remains available.

## 1. Install

Requirements: **Node.js 22.12+ (Node 24 LTS recommended), Docker, and pnpm 10.28.2**. Run from the repository root:

```sh
# First installation only; preserve an existing .env.
cp -n .env.example .env
npx --yes pnpm@10.28.2 install --frozen-lockfile
npx --yes pnpm@10.28.2 security:hooks
```

Keep `.env` private. The pinned `npx` commands work even if your global pnpm is older.

## 2. Set the keys

Edit `.env` before starting:

| Setup | Values |
| --- | --- |
| Required local secrets | Replace `REVIEW_LINK_SECRET`, `MEDIA_DELIVERY_SECRET`, and `S3_SECRET_KEY` placeholders with separate random values. |
| Social token storage | Set `CREDENTIAL_ENCRYPTION_KEY`, `PROVIDER_LOOKUP_HMAC_KEYS`, and `PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION` using the [Channels guide](docs/channels.md). |
| Instagram / Facebook | Your `META_APP_ID`, `META_APP_SECRET`, and pinned `META_GRAPH_API_VERSION`. |
| YouTube | Your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. |
| Optional AI / voice | Configure the selected [agent runtime](docs/agent-runtimes.md), [image workflow](docs/creative-studio.md), or [audio provider](docs/audio.md). |

Generate each secret separately: `openssl rand -base64 32`. Lookup keys use `version:key`. Keep all keys server-side.

## 3. Start locally

```sh
docker compose --profile app up -d --build
docker compose ps
curl --fail http://localhost:4000/health
```

Open **[localhost:3000](http://localhost:3000)**. Database migrations run automatically.

Default local mode uses `AUTH_MODE=single-user`, mock social connectors, and `ALLOW_LIVE_PUBLISH=false`. Keep it on your trusted machine.

For `pnpm dev`, follow [developer setup](docs/local-developer-setup.md). Avoid running duplicate application processes.

## 4. Connect social accounts

1. Choose the workspace and brand in the top-left switcher.
2. Open **Publishing channels**, or **Studio & system → Channels**.
3. Add provider keys and register callbacks from the [Channels guide](docs/channels.md).
4. Complete production requirements below; enable the network’s `official` mode and recreate API/worker containers.
5. Click the platform’s **Connect** button, sign in, and select the account.
6. Check account health before scheduling an approved post.

Instagram: professional accounts. Facebook: Pages. YouTube: videos. Connections and branding belong to the selected brand.

## 5. Self-hosted production / self-custody

You control the server, database, media, encrypted tokens, keys, and backups. Enabled AI/social providers still receive data needed for their operations.

Before public or live use:

- Set HTTPS URLs/callbacks, `AUTH_MODE=sessions`, a strong owner password, and `AUTH_COOKIE_SECURE=true`.
- Keep infrastructure private. Configure production credentials and an HTTPS reverse proxy; Compose defaults target local use.
- Set `MEDIA_MALWARE_SCAN_MODE=clamav` and start with `--profile app --profile malware-scan`.
- Enable configured networks, set `ALLOW_LIVE_PUBLISH=true`, and obtain required provider approvals.
- Run `npx --yes pnpm@10.28.2 release:check`, test backup restoration, and complete the [production release checklist](docs/public-release.md).

[Authentication](docs/authentication.md) · [Backup and restore](docs/disaster-recovery.md) · [Full configuration](docs/technical-overview.md)

## What can block setup?

| Symptom | Next step |
| --- | --- |
| Compose asks for a secret | Replace the named placeholder in `.env`. |
| Port 3000 or 4000 is busy | Run either Docker application services or local development processes. |
| Social connect button is disabled | Read its server-setup message; add the missing provider/key configuration and recreate the API. |
| Login works but publishing is blocked | Check account health, permissions, live mode, media scan, and approval of the current draft. |
| AI generation is unavailable | Configure the selected provider; social login does not supply AI access. |

Missing provider setup blocks that feature, not local exploration.

## Your brand and workspace

![Illustrative template with your logo, visual, headline, and social handle](docs/images/template-guide.svg)

Set your own logo, templates, language, and social handles per brand. Team: Organizations. Media: Library. Integrations: Developer API.

[Agent and templates](docs/agent-chat-ui.md) · [News sources](docs/source-signal-desk.md) · [Verified capabilities](docs/research/2026-09-15-workflow-acceptance.md)

## License and secrets

[AGPL-3.0-only](LICENSE). Follow [AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md). Repository hooks scan commits and pushes; never commit credentials, private exports, or customer data.
