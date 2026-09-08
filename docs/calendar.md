# Calendar and time zones

OriginPost stores every publish time as one UTC instant in `scheduledFor`. It also stores the editor's IANA time zone, such as `Asia/Kolkata`, so the calendar can show the intended wall time without guessing from the server or browser.

The Calendar has month and list views. Both views are constrained to the selected month in the browser's IANA time zone. Each entry shows the saved-zone time and UTC. Rescheduling accepts a new local date/time and IANA zone, rejects invalid daylight-saving gaps, converts the choice to UTC, and records an audit event.

## CSV export

Month and list views can export the current saved schedule for the active Brand. The server reloads the authoritative Content Items and connected-account display names; it does not export demo/browser data and does not call Hermes or a social provider. The export uses a half-open local-month interval—month start inclusive and next-month start exclusive—in the exact calendar grouping zone, together with the selected platform and target-status filters.

Every target is one row. The allow-listed columns contain the content title, platform, connected-account display name, local time in the Calendar grouping zone, the Calendar zone, local time in the target's saved zone, the saved zone, exact UTC instant, content status, target status, and delivery mode. Keeping both local-time views explicit prevents a target saved in one zone from being mistaken for the Calendar's current viewing zone. Provider account IDs, draft IDs, credentials, tokens, captions, source text, hashes, proof details, and Hermes identifiers are excluded. A missing account record is shown as `Unavailable`.

CSV responses are UTF-8 with a byte-order mark, CRLF rows, quoted cells, private no-store caching, and a fixed ASCII filename. Values that spreadsheets could interpret as formulas are made literal before quoting. An empty valid result is a header-only file.

Before a schedule or reschedule is committed, OriginPost runs the brand-wide [scheduling conflict preflight](schedule-conflicts.md). Exact approved-content duplicates on the same account and active same-account targets less than 60 minutes away are shown explicitly. If warnings exist, the operator must acknowledge the exact current warning hash; a stale acknowledgement cannot authorize a changed calendar. The conflict set is recomputed under an account-scoped database transaction lock at the final write, so two concurrent schedulers cannot both rely on the same earlier clear preview.

Rescheduling does not rewrite the old publish target. OriginPost marks the old target `cancelled` and creates a new queued target with a new idempotency key. This preserves history and prevents an already-created queue record from silently changing meaning.

Only `queued` or `pending` targets can be rescheduled or cancelled. Once provider work or a manual handoff begins, the operator must finish or recover that workflow instead.

API commands:

- `PATCH /v1/content-items/:contentItemId/targets/:targetId/reschedule?workspaceId=:workspaceId`
- `POST /v1/content-items/:contentItemId/targets/:targetId/cancel?workspaceId=:workspaceId`
- `GET /v1/content-items/schedule/export.csv?workspaceId=:workspaceId&brandId=:brandId&month=YYYY-MM&timeZone=:ianaZone&platform=:platform&status=:status`

The two write commands support `If-Match` with the current Content Item version.

The export is read-only and is available to authenticated roles with `content:read`. `brandId`, `month`, and `timeZone` are required; `platform` and `status` are optional closed-enum filters. The Brand is revalidated inside the authenticated Workspace and must be active. Calendar export is Brand-scoped rather than Board-scoped: Boards may create content in future, but Board/Hermes state is not publishing authority and is never inferred as content provenance.
