# Dependency security integration — 2026-09-17

Integrates the reviewed audio/UI work with dependency PRs #2, #3 and #4. PR #1's Node 26 change is deferred: production stays on Node 24 LTS, now pinned to 24.21.0 in both Docker base stages.

## Compatibility fixes

- Align Nest common/core/testing/platform-fastify at 12.0.3 so the application and adapter resolve the same Fastify 5.12.4 types.
- Preserve mock history only in two existing sequential workflow test files; Vitest 5 now clears history by default. Assertions remain unchanged.
- Update developer prerequisites to Node 22.12+, with Node 24 LTS recommended.
- Refresh transitive qs to 6.16.0, fixing the two moderate advisories left behind by the grouped dependency PRs.
- Gate all dependencies at moderate severity, including development tools copied into the current Docker runtime. Keep staged/history secret scanning enabled.
- Run PostgreSQL repository tests explicitly in CI after migrations, with an isolated CI database; previously the normal test run skipped these without TEST_DATABASE_URL.

## Validation

- Full local typecheck, operational script checks, tests and nine-package production build passed.
- All 89 database tests passed against a fresh PostgreSQL 16 test container after all 73 migrations.
- BullMQ 6.3.4 / ioredis 6.0.0 processed a throwaway job successfully against isolated Redis 7 using its default protocol; the queue was removed afterward.
- After the qs refresh, all 63 tests in the affected API HTTP/workflow suites passed. Full dependency audit reports no known vulnerabilities.
- Compose validation, public-release audit and secret-guard regression tests passed. Staged and history scans remain mandatory before push.
- Independent standards and specification reviews found the obsolete setup minimum and qs advisories; both were fixed.
- No live model generation or social publishing was used for dependency validation.

## Upstream references

- [Node production release guidance](https://nodejs.org/en/about/previous-releases)
- [Vitest 5 migration](https://vitest.dev/guide/migration/)
- [ioredis 6 release](https://github.com/redis/ioredis/releases/tag/v6.0.0)
- [qs security advisory](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g)
- [Checkout 7 release](https://github.com/actions/checkout/releases/tag/v7.0.0)
