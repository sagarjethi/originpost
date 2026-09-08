# Batch Operations

Batch Operations prepares many social drafts without hiding row-level mistakes. It extends the existing Automation Gateway; it is not a second CSV importer.

## Team workflow

1. Open **Batches** and choose one brand, platform, account, caption pattern, start time, interval, and risk level.
2. Select up to 100 images or videos. Each file goes through the normal private Media Library upload, SHA-256 check, rights record, and server inspection.
3. Run **Dry-run**. No Content Item, approval, schedule, or provider write happens during this step.
4. Review every row. Missing media, bad rights, wrong file type, account mismatch, invalid time, and unsupported formats stay visible on the exact row.
5. Choose **Create drafts for review**. OriginPost creates deterministic Content Item and draft IDs, records each media file as source evidence, and saves progress after every row.
6. Managers and owners may select low- and medium-risk review-ready rows, type the exact confirmation, and approve them. High- and sensitive-risk rows must be opened and approved one at a time.
7. Scheduled rows enter the normal calendar, outbox, connector preflight, publish attempt, and Proof of Publish workflow.

## Safety and recovery

- Dry-run is read-only except for saving the plan and its audit event.
- The server rechecks workspace, brand, media readiness, measured media facts, rights, account health, platform, exact draft content, and schedule before it changes workflow state.
- A row failure does not roll back another completed row. The durable row ledger keeps the error and step.
- Content Item and target IDs are deterministic. Retrying an interrupted operation reconciles the existing exact records instead of creating another post or schedule.
- Every processed row is checkpointed with optimistic version control. An active operation cannot be taken over. If it stops updating for five minutes, the UI offers explicit recovery.
- Batch approval is a human command. It cannot be called by an agent actor, and it requires manager or owner permissions plus `APPROVE N` confirmation.
- Duplicate detection currently covers repeated external references and exact rows inside one batch. It does not claim to detect every similar post already on the calendar.

## HTTP interface

- `POST /v1/batch-operations/preview`
- `GET /v1/batch-operations?workspaceId=&brandId=`
- `GET /v1/batch-operations/:id?workspaceId=`
- `POST /v1/batch-operations/:id/commit`
- `POST /v1/batch-operations/:id/approve`
- `POST /v1/batch-operations/:id/archive`

Every mutation is workspace-scoped and uses the visible plan `version`. A stale version returns `409` and requires refresh.

## Current limits

The first browser workflow uses one platform and one optional publishing account per batch, with one file per row. Carousel grouping, campaign folders and labels, calendar-wide duplicate checks, filtered error export, and full campaign CSV export are later extensions. The existing Automation Gateway remains the path for staged CSV/JSON intake from other systems.
