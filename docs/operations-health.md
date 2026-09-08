# Operations health and alerts

OriginPost evaluates protected workspace operations on a bounded interval and exposes the result inside **Organization → Operations health**. It is not a new top-level product destination. The detailed API and its action-center notifications are limited to owners and managers; the public `/health` endpoint continues to reveal only basic service availability.

The projection checks five failure domains:

- ClamAV reachability plus engine/signature version and signature age;
- webhook deliveries that exhausted their retry policy and entered `dead_letter`;
- Media Assets whose retention cleanup is in `cleanup_failed`;
- uncertain provider publication records, action-required/failed targets, and stalled publishing work;
- failed or overdue durable outbox commands.

Each unhealthy check opens one durable workspace incident. Repeated observations update `last_seen_at` without creating duplicate notifications. A changed failure opens a new notification within the same incident, a healthy observation resolves it, and a later recurrence safely reopens it. Operator notifications are filtered at list, unread-count, individual-read, and mark-all-read boundaries, so ordinary creators and viewers cannot enumerate or mutate them.

## Configuration

```dotenv
OPERATIONS_HEALTH_ENABLED=true
OPERATIONS_HEALTH_INTERVAL_MINUTES=5
OPERATIONS_PUBLISH_STALE_MINUTES=30
OPERATIONS_OUTBOX_STALE_MINUTES=15
MEDIA_CLAMAV_SIGNATURE_MAX_AGE_HOURS=48
```

The API uses ClamAV's private `PING` and `VERSION` commands. Responses return only normalized engine/signature facts; the configured scanner host and port never leave the server. If scanning is disabled, the panel states that explicitly and does not raise an incident because OriginPost separately refuses live publishing without ClamAV.

Use `GET /v1/operations/health?workspaceId=...` for a fresh, authenticated snapshot. Correct the underlying issue before retrying a dead-letter or failed command; an uncertain provider publication must be reconciled with the provider before another write is attempted.
