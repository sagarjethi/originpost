# Notification action center

OriginPost keeps important workspace events in its own database. Telegram and future email delivery are adapters; they are not the source of truth.

Current notification kinds cover:

- an exact draft revision waiting for approval;
- a draft rejected or sent back for changes;
- a manual Instagram or YouTube handoff becoming due;
- a publish failure or uncertain provider result;
- new monitor findings or a failed monitor run;
- an expiring, blocked, or incompletely disconnected provider account.

Every notification has a workspace, severity, title, body, action link, creation time, optional related record ids, and a deduplication key. The database enforces one notification per workspace and deduplication key. Marking a notification read records the actor and time; it does not delete operational history.

Notification writes are intentionally secondary to the publishing command. A notification delivery problem cannot turn a successful provider publish into a failed publish or cause the provider side effect to run again.

API reads and read-state changes are workspace-scoped and require content read permission:

- `GET /v1/workspaces/:workspaceId/notifications`
- `GET /v1/workspaces/:workspaceId/notifications/summary`
- `PATCH /v1/workspaces/:workspaceId/notifications/:notificationId/read`
- `POST /v1/workspaces/:workspaceId/notifications/read-all`

The public API does not accept arbitrary notification creation. Domain services and workers create notifications from recorded product events.
