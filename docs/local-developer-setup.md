# Local developer setup

Run these commands from the OriginPost repository root. Node.js 22.12 or newer (Node 24 LTS recommended) and a running Docker engine are required. The repository pins pnpm 10.28.2; the commands below also work when the globally installed pnpm is older or Corepack is unavailable.

## Install and verify

Keep an existing `.env`. Only copy `.env.example` when `.env` does not exist. Put runtime credentials in this ignored file, and replace the example secrets before starting the containers. The complete environment reference is in `.env.example`.

```sh
npx --yes pnpm@10.28.2 install --frozen-lockfile
npx --yes pnpm@10.28.2 security:hooks
docker compose config --quiet
npx --yes pnpm@10.28.2 typecheck
npx --yes pnpm@10.28.2 build
```

## Run the application in Docker

```sh
docker compose --profile app up -d --build
docker compose ps
curl --fail http://localhost:4000/health
```

The API container runs database migrations before starting. Open <http://localhost:3000>. PostgreSQL, Redis and MinIO keep their data in persistent volumes. If `.env` enables ClamAV, also include `--profile malware-scan` in the startup command.

## Work on the source locally

Choose this mode when editing source files. If the application containers are running, stop only those application processes first so there is one API and worker and no port conflict:

```sh
docker compose stop web api worker
docker compose up -d postgres redis minio
npx --yes pnpm@10.28.2 build
npx --yes pnpm@10.28.2 --filter @originpost/db exec node --env-file=../../.env --import tsx src/migrate.ts
npx --yes pnpm@10.28.2 dev
```

The local `.env` must use the host ports for PostgreSQL, Redis and object storage, as shown in `.env.example`. If ClamAV is enabled, start its Compose profile and use its host address and published port for the local API. The root development command loads `.env` for the web, API and worker. Web changes use Next.js development reload; restart the development command after API or worker source edits, and rebuild changed shared packages.

Stop the foreground development command before returning to Docker mode. Do not use `docker compose down --volumes` to switch modes; that removes persistent data.

## Application setup sections

| Section | Purpose |
| --- | --- |
| Organizations / workspace switcher | Manage workspace, brand and team membership. |
| Publishing channels / Channels | Connect Instagram, Facebook Pages and YouTube for the selected brand. |
| Agent plugins | Configure supported agent integrations. |
| Audio | Configure narration and voice generation. |
| Developer API | Set up integrations with external software. |

Account connection starts at <http://localhost:3000/channels>. Disabled connection buttons show which server configuration is missing. Meta uses `META_APP_ID` and `META_APP_SECRET`; YouTube uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. OAuth also requires the encryption/lookup keys, public URLs and registered callbacks documented in [Channels](channels.md). Restart or recreate the API after changing its environment.

A running local application does not establish live provider connections. Use the full [Channels setup guide](channels.md) for provider permissions and publishing requirements. Brand names, logos and social identities belong in workspace configuration and templates.
