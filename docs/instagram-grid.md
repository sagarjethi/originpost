# Instagram profile-grid projection

OriginPost’s Calendar includes a read-only **Instagram grid** view for each connected Instagram account. It projects the profile-visible image, carousel, and Reel targets that OriginPost already owns, newest first in Instagram’s three-column order.

## Honest coverage

The projection is derived from the selected brand’s Content Items, approved Instagram targets, Publish Proofs, and ready Media Library records. It does not call Meta, request a new provider scope, or imply access to the account’s complete profile history.

The first release deliberately excludes:

- Stories, because they never occupy a profile-grid tile;
- Reels whose approved settings set `shareToFeed` to `false`;
- posts created natively or before the account was connected to OriginPost;
- cancelled, failed, draft-only, or unapproved work;
- drag-to-reorder, because Instagram publishing order is determined by actual publication time.

A published tile uses its verified Publish Proof time. A planned tile uses its exact scheduled time. The newest effective time appears in the top-left position.

## Media and privacy

The API returns only sanitized account names/statuses, projection metadata, and safe Media Asset metadata. It never returns credentials, external account identifiers, object keys, provider response bodies, or storage URLs.

The browser requests a short-lived same-origin preview URL. The existing media-delivery verifier checks workspace, media ID, SHA-256, expiry, ready state, and owned/cleared rights before streaming bytes with `private, no-store`. The ordinary signed download URL remains available for downloads.

## API

`GET /v1/instagram-grid?workspaceId=<workspace>&brandId=<brand>&accountId=<optional>&limit=<1..60>`

The response includes:

- sanitized Instagram account choices;
- `selectedAccountId`;
- projected tiles with target status, effective time, proof state, and optional ready-media preview metadata;
- `coverage: "originpost_records_only"`;
- `providerHistoryIncluded: false` and `storiesExcluded: true`.

An account ID outside the exact workspace, brand, or Instagram platform returns `404`. Unknown query fields are rejected.

## Persistence and release scope

No migration is required. The projection is a read model over the existing Content Item, Connected Account, Publish Proof, Instagram settings, and Media Asset records. A future provider-history sync or visual reorder planner would be a separate reviewed feature with its own capability and consistency contract.
