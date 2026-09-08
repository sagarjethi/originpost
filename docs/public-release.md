# Public release gate

OriginPost is ready for a public commit only when the source tree, dependency graph, migrations, and safe runtime pass the checks below. Passing this gate does not enable live social publishing.

## Automated gate

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

`release:check` runs all type checks, tests, and production builds; audits the candidate worktree for private paths and customer-specific material; rejects known high-severity production dependency advisories; scans source files for secrets with Gitleaks; and validates the Compose configuration.

The Gitleaks image is pinned to `v8.28.0`. `.gitleaks.toml` excludes only generated/local directories, ordinary local `.env` variants, and named deterministic test fixtures. `.env.example` remains in scope.

## Fresh-database migration

Use an empty PostgreSQL database that is safe to destroy:

```bash
DATABASE_URL=postgres://originpost:originpost@127.0.0.1:65432/originpost pnpm db:migrate
```

For CI, the workflow provisions an empty database service and applies every migration. A production upgrade still requires a deployment-specific backup and tested restore before migration.

## Safe runtime proof

Keep all connectors in `mock` mode and `ALLOW_LIVE_PUBLISH=false`. For the release-like media path, set `MEDIA_MALWARE_SCAN_MODE=clamav`, start the `malware-scan` Compose profile, and run `TEST_CLAMAV_HOST=127.0.0.1 TEST_CLAMAV_PORT=63310 pnpm --filter @originpost/api test -- media-malware-clamav.integration.test.ts`. Start the application with unique local secrets, verify `/health`, load the web app through its same-origin `/v1` proxy, and complete one approved mock publish through Proof of Publish. Provider test data is not evidence that an official account is ready.

## Human release checks

- Review [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) after changing runtime dependencies and preserve bundled license texts in distribution artifacts.
- Confirm the GitHub remote and repository visibility before pushing; neither is inferred by the source tree.
- Review the diff for credentials, customer data, generated evidence, screenshots, private research, and personal paths.
- Confirm public documentation describes only tested behavior and labels provider-approval or deployment work accurately.
- Run the [database and object-storage backup/restore drill](disaster-recovery.md) for the exact production topology and retain the successful manifest/check evidence outside the repository.
- Confirm clamd definitions are current, the scanner is reachable only over a trusted network, and clean/infected canaries both produce the expected durable Media Library state.
- Obtain independent security review before exposing the application to the public internet.

## Intentionally external gates

Official Instagram, Facebook Page, YouTube, private-message, and Hermes Board execution require credentials, provider review where applicable, and watched owned-account validation. The public release gate must not silently enable or claim those external approvals.
