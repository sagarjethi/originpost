# Guided installation

This is an initial guided setup release. It moves deployment provider entry into an installation-owner screen and preserves existing publication guards. It does not claim automatic certificate issuance, provider App Review, general named-agent chat, reference layout extraction or proven live publication.

## Fresh server

Run `node scripts/install.mjs prepare` then `node scripts/install.mjs start` from a trusted checkout with Node and Docker Compose installed. Preparation never reads the existing `.env`, never overwrites its own directory and does not start services. It generates fresh passwords, a fixed installation owner identity, encryption/signing keys and private Compose configuration under `.originpost-install/`. Start builds and launches a separately named stack and separate volumes.

The directory and keys are private filesystem files, not values an administrator needs to copy into `.env`. Infrastructure credentials necessarily remain on the server. Provider keys entered in Setup are AES-GCM encrypted with an independently generated master key. The master key is not writable by the application; the worker also has read-only settings access. Do not lose the key during backup/restore or copy it into Git, tickets, screenshots or logs.

The initial account is `installer@originpost.local`; its random password is only in the protected `first-login.txt` file. Read that file on the server and sign in. Change the password in **Setup → Secure access**. The configured initial identity remains the deployment administrator; other workspace owners cannot change its global service settings. This first version uses a generated account rather than an unauthenticated public claim wizard.

Initial addresses are `http://127.0.0.1:3100/setup` (web), port 4100 (API) and port 61900 (object storage). They are deliberately loopback-bound; use SSH tunnels for remote initial setup. Existing ports or another installed stack will cause startup to fail rather than replace their processes. Run only one installed stack from this script on a host unless you deliberately provide a separately reviewed deployment configuration.

## Setup in the application

1. **Your site:** enter the final public HTTPS web, API and object-storage addresses. Configure the corresponding reverse proxy, TLS certificates and DNS on the server. Entering an address does not create those resources. The saved public web address enables secure cookies after restart.
2. **Secure access:** change the initial password and add individual members through Organizations. Creator can prepare drafts; Owner and Manager can approve and publish. The installation owner alone can manage these server settings. IP allowlisting is an additional operator-level network policy; this release does not expose a self-locking network editor.
3. **Connect services:** save the Meta/Google application credentials and optional server image credentials. Blank secret fields retain the saved value; the application never reads it back. Saving validates configuration but does not make a provider call or prove a key is usable. Copy the displayed callback addresses into the correct provider dashboard.
4. **Apply settings:** during a quiet period run `node scripts/install.mjs apply`. This drains/stops API and worker before starting them against the saved revision. Long operations exceeding the two-minute stop window may require reconciliation; do not apply while paid generation or publishing is in progress. Refresh Setup and inspect `node scripts/install.mjs status` before proceeding. An API version match alone is not worker readiness.
5. **Connect accounts:** use Channels to complete actual OAuth, select the correct project/brand and grant access to the intended Instagram professional account, Facebook Page or YouTube channel. Application credentials and test accounts are not authorized live accounts. Text runtimes are configured in Agent plugins, and voice keys in Audio.
6. **Your first post:** save your brand template and references, create the draft, verify sources/copy/image and approve the exact version. Enable the intended official connector modes and live publication together only after deployment prerequisites are met. Apply the change, inspect account health, then request one explicitly approved publication. Confirm the final provider proof.

## Provider requirements and current boundaries

See [current provider onboarding research](research/2026-09-20-admin-onboarding-requirements.md) and [Channels](channels.md) for authoritative setup links. The first UI version retains the existing shared Meta credential configuration. Direct Instagram Login can require Instagram-specific application credentials; do not assume those are interchangeable with Facebook Login credentials. Deployments needing both credential families independently need the follow-up adapter/configuration change before claiming both routes are ready.

The Agent pipeline produces a reviewed, unapproved Instagram draft. General `@Codex`/`@Hermes` participant dispatch is still proposed. Its Codex-image mode is a manual handoff, and reference uploads guide style rather than infer editable positions. Facebook and YouTube require their supported formats; an Instagram image is not a YouTube video.

The UI intentionally distinguishes saved configuration, active configuration, connected accounts and proof of publication. YouTube public/unlisted publishing has additional audit gates; optional analytics, comments and private messaging have their own requirements. Their advanced release evidence is not automatically granted by this setup screen.

## Existing installations

This installer is for a new isolated stack. It does not migrate an existing `.env`, database, ownership or account grants. Existing deployments continue to start with their previous configuration; the new Setup screen explains why it is unavailable until the installation owner and protected settings storage are provisioned. Do not create a second stack and expect it to contain the first stack's projects. Plan and test migration separately, including secure backups and retained encryption keys.

## Checking readiness

Run `node scripts/install.mjs status` after startup or when Setup cannot reach the workspace. It lists only the installed stack and requests its local API health endpoint on port 4100. The Docker listing has a ten-second limit and the API request has a five-second limit. An empty response, invalid health response, request timeout or Docker failure exits with an error, even if Docker reports the container as running. This check does not call a paid provider, publish a post or restart services; a healthy API alone does not prove worker or provider readiness.

If startup has just begun, allow migrations to finish and run status again. If the API keeps failing while its container appears to be running, check the Docker runtime and the installed stack's service state. A stale Docker task may require an operator to restart Docker or Colima. Coordinate that restart with anyone using other projects on the same runtime. After recovery, restore the installed stack with its existing images and private configuration, then recheck:

```sh
docker compose --env-file /dev/null -f .originpost-install/compose.private.json up -d --no-build
node scripts/install.mjs status
```

Do not rerun `prepare`, delete data volumes or replace encryption keys to fix a health check. Keep private configuration and unreviewed service logs out of support tickets and Git.

## Operational limitations

- Restart application is an operator command, not a browser action with access to the Docker socket.
- A deployment-level encrypted file assumes one writable API deployment. It is not a distributed configuration service for multiple hosts.
- Save uses version conflict checks and atomic replacement. A crash during a write can leave a lock directory; inspect the process before removing a stale lock. Never discard the key or replace the settings file with plaintext.
- Backup the protected installation files together with application data using secure, access-controlled storage. Keep configuration and credentials out of Git.
- New setup must pass actual HTTPS/login/upload/provider authorization/publication checks before being called production-ready. Automated test providers do not satisfy those checks.
