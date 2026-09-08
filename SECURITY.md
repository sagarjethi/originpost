# Security policy

## Supported version

OriginPost is currently an alpha. Security fixes are applied to the latest commit on the default branch; older snapshots are not supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting flow from the repository's **Security** tab. Do not include access tokens, customer data, private media, or working exploit payloads in a public issue.

Include the affected version or commit, deployment mode, impact, and the smallest safe reproduction you can provide. Maintainers should acknowledge a credible report within seven days and coordinate disclosure after a fix is available.

## Deployment boundary

The default Compose configuration is for a trusted local machine. Live or public deployment requires session authentication, HTTPS, secure cookies, reviewed secret management, backups with a tested restore, outbound network controls, and an independent security review. Live social publishing refuses to start unless server-side ClamAV media scanning is enabled; private messaging has its own separate provider gate. The clamd TCP port is unauthenticated and unencrypted, so Compose exposes it only on loopback and deployments must keep it on a trusted private network.

The local backup tooling deliberately excludes plaintext deployment keys and refuses to write inside the repository. Backup archives and manifests still contain private content and operational identifiers; encrypt and access-control them, keep key recovery separate, and follow [the restore-drill runbook](docs/disaster-recovery.md).

Detailed operations health and its notifications are owner/manager-only. The public health endpoint never exposes scanner endpoints, delivery identifiers, queue contents, media keys, or provider details. ClamAV health responses are normalized to engine/signature facts before they leave the server.
