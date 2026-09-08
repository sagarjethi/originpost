# First Comments

OriginPost treats a First Comment as a separate governed operation attached to one successful Instagram or Facebook Page publication. It is never embedded in the main publish request and never inferred from caption text.

## Lifecycle

```text
exact scheduled target + approved draft
  → comment draft
  → submit for approval
  → separate human manager/owner approval
  → wait for the exact Publish Proof when necessary
  → queued write intent
  → DB-clock leased worker claim
  → provider comment create once
  → exact provider read-back
  → append-only First Comment proof
```

The intent binds the workspace, brand, Content Item, target, account, platform, draft SHA-256, and Publish Proof. Changing the target, account, draft, or comment body creates a different immutable approval/execution identity. Main-post success does not imply comment success, and comment failure never rewrites the Publish Proof.

## HTTP routes

Routes are scoped below `/v1/content-items/:contentItemId/first-comments`:

- `GET /capability` checks the exact account and target without returning credentials or provider identifiers.
- `GET /` lists sanitized intents and evidence states.
- `POST /` creates a draft comment.
- `PATCH /:intentId` revises an unapproved draft with optimistic version checking.
- `POST /:intentId/submit` moves a draft to pending approval.
- `POST /:intentId/approve` performs separate human approval and queues only after exact lineage and capability checks.
- `POST /:intentId/cancel` cancels an eligible draft or pending intent.
- `POST /:intentId/reconcile` either schedules read-only provider inspection or, with explicit human confirmation, records that the comment was checked as not sent and authorizes one new write intent.
- `POST /:intentId/manual-attestation` records sanitized operator evidence without presenting it as provider-confirmed proof.

Clients cannot supply provider comment IDs, provider response digests, execution leases, approval identities, or Publish Proof lineage.

## Roles and approval

Creators can prepare and submit their own drafts. Managers and owners approve delivery. The approver must be a human and normally must differ from the requester. A workspace with exactly one active owner can use the recorded sole-owner override only after both explicit confirmations. Viewers are read-only.

## Delivery and recovery safety

- The worker claims a queued intent with a database-clock lease before any provider write.
- `executionMode=write` is the only mode that can call the provider create edge.
- `executionMode=reconcile` is read-only and cannot fall through to create.
- A clear provider acceptance is checkpointed before read-back.
- A timeout, response loss, missing identity, body mismatch, or persistence ambiguity becomes `uncertain`; it is never automatically returned to the write queue.
- Expired processing leases recover to an operator-visible uncertainty state.
- Provider-confirmed and provider-reconciled evidence are distinct from operator attestation.
- API projections omit provider identifiers, response hashes, leases, credentials, and raw provider bodies.

## Provider gates

Instagram uses the comments edge belonging to the credential's verified endpoint family. Instagram Login and Facebook Login credentials use their own required comment-management scopes. Facebook Page delivery requires `pages_manage_engagement`, `pages_read_engagement`, and the Page `MODERATE` task. Official connectors use bearer authorization, reject redirects, bound response parsing, and verify the exact top-level provider account, body, and accepted time.

Before production enablement, obtain the applicable Meta App Review/Advanced Access, Business Verification, Page/Instagram tasks and permissions; reconnect existing accounts for newly requested permissions; run watched tests on owned accounts; and monitor rate limits, permission loss, and uncertain outcomes. Local mock connectors are test-only and must not be presented as live Meta delivery.

## Release checks

- drafting and approval bind the exact target, account, draft hash, and Publish Proof;
- concurrent workers elect one write claimant;
- provider transport ambiguity produces no automatic second comment;
- provider inspection is demonstrably read-only;
- evidence proof is append-only and workspace/account scoped;
- creators cannot self-approve or resolve uncertainty as sent;
- sanitized API/UI views expose no provider IDs, tokens, response bodies, or lease fields;
- PostgreSQL migrations `047_first_comment_workflow.sql` and `048_first_comment_target_fk_deferred.sql`, API, worker, and responsive Content Studio tests pass before deployment.
