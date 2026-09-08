# Review links and manual handoff

OriginPost keeps external review and native-app publishing inside the same source-to-proof record.

## Signed review links

A review link is locked to one immutable Draft Revision. Its HMAC-SHA256 token contains the link ID, workspace, Content Item, draft ID, draft SHA-256, expiry, and token version. The server also checks the stored link record on every request, so expiry and revocation take effect immediately.

Set a private signing secret before running the API in production:

```env
REVIEW_LINK_SECRET=replace-with-at-least-32-random-characters
WEB_PUBLIC_URL=https://your-originpost.example
```

Create a 72-hour comment-enabled link:

```http
POST /v1/content-items/:contentItemId/review-links
Content-Type: application/json

{
  "draftId": "draft_…",
  "expiresInHours": 72,
  "allowComment": true
}
```

Revoke it:

```http
POST /v1/content-items/:contentItemId/review-links/:linkId/revoke
```

The public reviewer route returns only the selected draft, selected source fields, ready attached media through short-lived signed downloads, and non-internal comments for that revision. Responses use `Cache-Control: no-store`. External comments are always stored with `reviewer` audience and cannot change approvals or publishing state.

Rotating `REVIEW_LINK_SECRET` invalidates all existing tokens. Keep the secret outside source control and logs.

## Manual Instagram handoff

Use manual handoff when an operator must finish a Reel, add native music, use an Instagram-only feature, or publish through the native app.

Schedule an approved draft with `deliveryMode: "manual_handoff"`:

```http
POST /v1/content-items/:contentItemId/schedule
Content-Type: application/json

{
  "platform": "instagram",
  "accountId": "instagram-main",
  "draftId": "draft_…",
  "scheduledFor": "2026-09-01T09:00:00.000Z",
  "deliveryMode": "manual_handoff",
  "notifyDestinationId": "optional-allow-listed-telegram-chat"
}
```

When due, the worker changes the target to `action_required` and does not call a platform connector. The dashboard shows it under **Post now** with the exact approved caption.

The operator accepts the handoff:

```http
POST /v1/content-items/:contentItemId/targets/:targetId/acknowledge
```

After publishing in Instagram, the operator records the result:

```http
POST /v1/content-items/:contentItemId/targets/:targetId/manual-confirm
Content-Type: application/json

{
  "externalPostId": "platform-post-id",
  "liveUrl": "https://www.instagram.com/p/example/",
  "publishedAt": "2026-09-01T09:05:00.000Z",
  "disclosure": "none"
}
```

OriginPost rechecks the exact approval and every ready media hash, then creates one numbered Publish Attempt and one immutable Proof of Publish. Reusing the same platform post ID is rejected.
