# Scheduling conflict preflight

OriginPost checks the whole brand calendar before an exact schedule, a queue allocation, or a reschedule is committed. The first release reports two precise warning classes:

- `exact_content_duplicate`: the same approved draft SHA-256 is already active on the same connected account;
- `account_time_overlap`: another active target for the same account is less than 60 minutes away.

The check is account-scoped. A simultaneous post on another connected account is not a conflict. Cancelled, failed, and published history is excluded. When a target is being rescheduled, that target is excluded from its own preflight.

## Explicit confirmation

Preflight is read-only. It returns the matching Content Item title, target, status, exact scheduled instant, distance in minutes, and an `acknowledgementSha256` that binds:

- the workspace, brand, Content Item, exact approved draft hash, platform, account, and proposed instant;
- the 60-minute policy window; and
- the current sorted conflict set.

If warnings exist, the scheduling command must return that exact hash as `conflictAcknowledgementSha256`. A missing or stale hash fails with `schedule_conflict_confirmation_required`. The web UI shows every warning and requires a human checkbox; it never silently suppresses or automatically accepts a warning.

This is a warning and acknowledgement workflow, not an automatic deletion or merge. Teams may intentionally repeat approved content. Acknowledged warnings and their count are recorded in the schedule audit event.

## Transactional recheck

The browser preflight is guidance, not authorization by itself. Every direct schedule, queue allocation, and reschedule recomputes the conflict set inside the same database transaction that writes the target. Writes for one workspace and connected account share an advisory transaction lock. If another scheduler changes that account's calendar after the browser check, the submitted hash is stale and the write fails instead of silently creating an unreviewed conflict. Queue allocation recomputes against the actual slot selected under the queue-profile lock, not the earlier preview slot.

The in-memory development repository applies the same domain assertion. A real PostgreSQL concurrency regression starts two unacknowledged same-account duplicate writes together and proves that exactly one commits.

## API

- `POST /v1/content-items/:contentItemId/schedule-preflight?workspaceId=...`
- `POST /v1/content-items/:contentItemId/schedule?workspaceId=...`
- `POST /v1/content-items/:contentItemId/schedule-next`
- `PATCH /v1/content-items/:contentItemId/targets/:targetId/reschedule?workspaceId=...`

The preflight body uses the proposed platform, account, draft, UTC instant, time zone, and delivery mode. A reschedule preflight also includes `excludeTargetId`.

## Boundaries

- Detection is exact, explainable, and provider-free. It does not claim semantic similarity or use AI.
- It does not merge, delete, or move existing targets.
- Within-batch duplicate checking remains a separate batch invariant; this preflight covers the already-scheduled calendar across Content Items.
- Provider execution idempotency and crash recovery remain separate safeguards after scheduling.
