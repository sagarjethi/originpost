# Instagram Reel cover review

OriginPost treats a Reel cover as an approved publishing choice, not as an arbitrary URL entered during scheduling.

## Editor flow

1. Prepare and approve an Instagram Reel draft with one inspected video.
2. Choose the publishing account.
3. In **Instagram Reel cover review**, choose a ready Library image, an exact frame time, or Instagram default.
4. Choose whether to share the Reel to feed.
5. Save a pending settings request, then have a manager or owner approve it.
6. Schedule by the saved Instagram publishing approval ID.

Changing the account, draft, collaborators, feed choice, cover asset/hash, or frame offset requires a new approval.

## Provider contract

- Custom image sends `cover_url` only.
- Video frame sends `thumb_offset` only, in milliseconds.
- Instagram default sends neither.
- The custom image originates from a server-resolved Media Asset. Browser-supplied public URLs and hashes are not accepted.
- Official publishing gives Meta a short-lived hash-bound delivery URL. Storage keys are never exposed.
- Container processing and restart recovery use the existing Instagram durable operation; container creation is not treated as publication success.

## Media and proof

The API and worker both recheck workspace, brand, ready status, inspection status, rights, kind, and SHA-256. Frame selection requires trusted video duration and must be strictly inside the video.

Publish Proof stores the approved Reel cover mode, stable cover media ID/hash or frame offset, and full Instagram settings hash. Media reference checks include cover targets and cover proofs so a governed cover cannot be removed as an orphan.

The UI preview is intentionally labelled as a preview. It does not promise an exact Instagram profile-grid crop.

## Release gate

Before calling official Meta delivery production-ready, run watched tests on a reviewed Instagram Business account for one custom-image cover and one selected-frame cover using the currently pinned Graph API version.
