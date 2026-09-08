# Automation Gateway

The Automation Gateway lets a trusted script, n8n workflow, or another system create work in OriginPost without sharing an owner login. It is an intake and status layer. It does not bypass human approval or publish directly around the normal workflow.

## What it provides

- Workspace, brand, account, and action-scoped API keys
- Immediate key revocation and optional expiry
- Idempotent content and schedule commands
- Required `If-Match` checks for draft, review, schedule, reschedule, and cancel changes
- Staged CSV and JSON imports with row-level errors
- Signed lifecycle webhooks with durable retries and a dead-letter state
- An event and delivery explorer under **Developer API**

Owners create or revoke keys and webhook subscriptions. Managers can inspect events and retry active webhook deliveries. A key secret or webhook signing secret is shown once.

## Create a content item

Create a key with `content:write`. Limit it to the brands and accounts that the integration needs.

```bash
curl -X POST http://localhost:4000/public/v1/content-items \
  -H "Authorization: Bearer $ORIGINPOST_API_KEY" \
  -H "Idempotency-Key: newsroom-source-2026-001" \
  -H "Content-Type: application/json" \
  -d '{
    "brandId": "brand_default",
    "title": "Source-backed story for review",
    "summary": "Facts still need an editor check.",
    "riskLevel": "medium"
  }'
```

The same key and body return the same Content Item. Reusing the key with different content returns `409`. An idempotency key is 8–200 characters and may contain letters, numbers, `.`, `_`, `:`, or `-`.

## Safe updates

First read the Content Item and keep its `version`. Send that version with every change:

```bash
curl -X POST http://localhost:4000/public/v1/content-items/CONTENT_ID/drafts \
  -H "Authorization: Bearer $ORIGINPOST_API_KEY" \
  -H "If-Match: 3" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "instagram",
    "format": "image",
    "title": "Editor-ready title",
    "caption": "Source-backed caption",
    "mediaIds": []
  }'
```

OriginPost returns a conflict if another person or integration changed the item first. Fetch the latest version, compare it, and make a new decision. Do not blindly repeat a stale change.

## CSV and JSON imports

An import has two steps:

1. `POST /public/v1/imports/preview` validates up to 100 rows and creates no Content Items.
2. `POST /public/v1/imports/:id/commit` creates only valid rows as Inbox items.

The key needs `imports:write`. Every row needs a unique `externalRef` and a `title`. Optional fields are `summary`, `researchDepth`, and `riskLevel`.

```bash
curl -X POST http://localhost:4000/public/v1/imports/preview \
  -H "Authorization: Bearer $ORIGINPOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "format": "csv",
    "brandId": "brand_default",
    "data": "externalRef,title,summary,riskLevel\nwire-001,First story,Check the source,medium"
  }'
```

JSON uses `"format":"json"` and a `rows` array. Previewing the same source again returns the same import session. Committing again returns the completed result and creates no duplicates. A failed or invalid row never creates partial hidden data.

## Webhook events

Subscriptions can receive approval, schedule, publish, failure, and proof events. A content audit and its event are stored together before delivery begins. Webhook retries never retry the social publish.

OriginPost sends:

```text
X-OriginPost-Event-Id: automation_evt_...
X-OriginPost-Timestamp: 1787985600
X-OriginPost-Signature: v1=<hex hmac sha256>
```

Verify the signature over the exact bytes:

```text
HMAC_SHA256(signing_secret, timestamp + "." + raw_request_body)
```

Compare signatures in constant time. Reject old timestamps, store each event ID, and ignore an ID already handled. Reply with any `2xx` status only after accepting the event durably.

Delivery uses a 10-second timeout, exponential retry, and at most eight attempts. A final failure becomes `dead_letter` and stays visible for an operator. Disabling a subscription also dead-letters its outstanding deliveries.

## n8n pattern

1. An RSS, form, email, or source monitor starts the workflow.
2. Normalize the source into an OriginPost content or import request.
3. Use the external source ID as `Idempotency-Key` or `externalRef`.
4. Keep the returned Content Item ID.
5. Let editors research, write, and approve in OriginPost.
6. Receive `approval.needed`, `publish.succeeded`, `publish.failed`, and `proof.created` through one signed webhook.
7. Save the event ID before doing any next action.

Use one key per workflow. Do not place an API key in a browser page, public repository, query string, or n8n output log.

## Deployment settings

```dotenv
AUTOMATION_DELIVERY_ENABLED=true
AUTOMATION_DELIVERY_INTERVAL_SECONDS=5
AUTOMATION_ALLOW_PRIVATE_WEBHOOKS=false
```

Private and local destinations are blocked by default. Production webhook URLs must use HTTPS. `AUTOMATION_ALLOW_PRIVATE_WEBHOOKS=true` is only for a trusted local test environment. A public deployment should also use session authentication, a reviewed HTTPS reverse proxy, rate limits, backups, and outbound network rules.

