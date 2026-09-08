# Account posting queues

OriginPost posting queues let an approved draft reserve the next free weekly time for one connected Instagram, Facebook Page, or YouTube account. A queue is an account clock, not a second publishing system: the command creates an ordinary immutable publish target, audit event, reservation, and `publish.target.requested` outbox record in one transaction. The existing worker, provider recovery, and Proof of Publish flow remain authoritative.

## Profile and preview

Owners and managers configure a profile in **Channels → Account posting queue**. Each profile contains:

- one connected account and brand;
- an IANA time zone;
- zero or more `HH:mm` wall-clock times for each weekday;
- an enabled flag and optimistic version.

Saving a profile never moves targets that were already scheduled. Before saving, the editor sends proposed values to a read-only preview command; it validates and resolves them without persisting a profile, audit event, target, reservation, or provider action. The preview calculates exact future instants and displays the saved-zone time, UTC offset, ISO instant, proposed profile version, and earlier occupied or daylight-saving candidates that were skipped. A daylight-saving gap is skipped instead of silently shifted. When a wall time occurs twice, OriginPost chooses the earlier occurrence and labels it. Already-active times for that account are skipped.

## Schedule next available

Creators, managers, and owners can use **Add to next account slot** from the exact approved draft. The command requires:

- the current Content Item version in `If-Match`;
- an `Idempotency-Key`;
- the connected account and current queue-profile version;
- the exact approved draft and any platform-specific approved settings;
- a healthy account for automatic publishing.

The PostgreSQL repository locks the account profile, reads the database clock, selects the first unoccupied instant, and commits the target, normalized target row, reservation, audit, and outbox message together. Concurrent commands for the same account cannot receive the same active slot. Replaying the same idempotency key returns the original target; using that key for a different command fails. Cancelling a queued target releases its reservation transactionally so the time can be offered again.

YouTube queueing keeps the required title, description, audience, synthetic-media declaration, notification choice, visibility gate, and exact-draft check. Instagram queueing resolves any approved collaborator, Reel-cover, feed-share, or AI-disclosure settings before the reservation. Manual handoff uses the same reminder and proof path as an explicitly scheduled target.

## HTTP routes

- `GET /v1/posting-queue-profiles?workspaceId=&brandId=` — sanitized account/profile rows.
- `PUT /v1/posting-queue-profiles/:connectedAccountId` — owner/manager versioned profile save.
- `GET /v1/posting-queue-profiles/:connectedAccountId/preview?workspaceId=&brandId=&count=` — exact read-only projection.
- `POST /v1/posting-queue-profiles/:connectedAccountId/preview` — owner/manager preview of unsaved normalized values; performs no write.
- `POST /v1/content-items/:contentItemId/schedule-next` — atomic next-slot reservation.

Queue cancellation uses the existing target cancellation route. Calendar month/list cards identify queue-assigned targets and retain the original local slot metadata even if the profile later changes.

## Release checks

- Apply migration `050_account_posting_queues.sql` before starting the API.
- Keep PostgreSQL as the production store; the in-memory adapter is for local development and tests.
- Exercise one account in its real operating time zone, including a DST boundary when applicable.
- Confirm concurrent next-slot commands allocate distinct instants, cancellation releases a slot, and replay returns the same target.
- Complete the normal watched provider publish/recovery/proof acceptance for each enabled platform. Queue allocation does not weaken connector or account gates.
