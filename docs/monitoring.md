# Source monitoring

OriginPost source monitors turn a saved topic into sourced inbox suggestions. A monitor never approves or publishes content.

## Durable behavior

- PostgreSQL is the source of truth for rules, runs, fingerprints, and generated Content Items.
- BullMQ is rebuildable execution state. The worker recreates one scheduler for every enabled rule at startup.
- Creating or changing an enabled rule upserts its scheduler. Disabling a rule removes it.
- Scheduled and manual checks use the same worker path.
- A partial unique index permits only one `running` row for each workspace and monitor.
- A competing job is saved as `skipped` with reason `monitor_already_running`.
- A canonical source URL fingerprint can create only one suggestion for the same monitor. Fragment IDs and common tracking parameters such as `utm_*`, `fbclid`, `gclid`, and `igshid` do not make an old source look new.
- The sourcing provider groups links by event. Unrelated events become separate inbox suggestions instead of one mixed content item.
- Each suggestion, its completed research record, source links, claim links, and deduplication fingerprints are committed together. A crash cannot save the suggestion while forgetting its deduplication record.
- A monitor may create several content items in one run. The run keeps the first `contentItemId` for compatibility and all IDs in `contentItemIds`.
- Monitor suggestions are tagged `multi-source` or `single-source`. The inbox shows a plain cross-check summary based on independent publishers and supported claims.
- A monitor whose enabled tracked sources are exclusively `luma_city` uses the built-in read-only Mumbai adapter instead of the configured general research provider. Mixed-source monitors remain on the configured provider so OriginPost never pretends one city-page read checked unrelated sources.

## Operator view

Open **Automations** to see each monitor's schedule, current health, next expected check, and recent run history. **Run now** queues a one-off check and does not reset the repeat schedule.

Health meanings:

- `paused` — the rule is disabled.
- `waiting` — enabled, but no run has completed yet.
- `healthy` — the latest run completed inside the expected time window.
- `running` — a check is active.
- `failed` — the latest run failed and shows its error.
- `stale` — no recent run arrived within two intervals plus five minutes.
- `coalesced` — an overlapping job was skipped because another run already held the lock.

## API

- `GET /v1/monitors?workspaceId=...` lists rules.
- `GET /v1/monitors/status?workspaceId=...` returns rules with health and recent runs.
- `GET /v1/monitors/:id/runs?workspaceId=...` returns durable run history.
- `POST /v1/monitors/:id/run?workspaceId=...` queues a manual check.

Creating, changing, or manually running a monitor requires `automation:manage`. Reading monitor status requires normal workspace content-read access.

## Recovery check

After restarting the worker, its startup log reports how many monitor schedulers were recovered from PostgreSQL. A healthy recovery preserves the same monitor ID as the BullMQ scheduler key, so repeated restarts upsert rather than duplicate the schedule.

Monitoring uses source links and source text returned by the configured sourcing provider. OriginPost does not bypass Instagram login, copy private posts, or treat a competitor screenshot as proof by itself.
