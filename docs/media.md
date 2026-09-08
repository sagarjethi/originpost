# Private media

OriginPost keeps uploaded images, videos, audio files, and PDFs private. PostgreSQL stores ownership, rights, purpose, file metadata, status, and the expected SHA-256. MinIO or another S3-compatible service stores the bytes.

## Upload flow

1. The browser calculates the file SHA-256.
2. `POST /v1/media-assets/uploads` validates the file type, size, workspace, optional Content Item link, and rights state.
3. The API returns a 15-minute private PUT URL for a temporary object key. The browser uploads directly to object storage.
4. `POST /v1/media-assets/:id/complete` streams the temporary object, recalculates its size and SHA-256, checks its content type, and reads its S3 entity tag/version.
5. A matching object is conditionally copied to a hash-bound finalized key only if the temporary object still has the entity tag that was verified.
6. The API reads the finalized bytes and streams bounded frames to ClamAV `clamd` with the documented [`INSTREAM` protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html#instream). An infected, oversized, changed, timed-out, malformed, or unavailable scan fails closed: the finalized object is deleted and the asset is rejected/quarantined.
7. Only after the malware gate passes does the API reread the same hash-bound finalized object. It measures image width/height with a bounded parser and video width/height/duration with a time-limited, single-threaded `ffprobe` process. Browser-provided dimensions and duration are never accepted.
8. The database atomically records the finalized key, malware result, scanner identifier, scan time, and metadata result before the asset becomes `ready`, then removes the temporary upload. Reusing the original PUT URL can only change the abandoned temporary key, never the approved bytes.
9. Only a matching, accepted finalized object becomes `ready`. A storage, scan, or required metadata failure becomes `rejected` and both temporary/finalized objects are removed. Malware and metadata inspection have separate explicit states so storage validity is never confused with publishability.
10. Ready files receive five-minute private download URLs from `GET /v1/media-assets/:id/download-url`.

For split-network deployments, set `S3_ENDPOINT` to the API-reachable private object-store endpoint and `S3_PUBLIC_ENDPOINT` to the browser-reachable endpoint. Upload and download links are signed against the public endpoint; verification, scanning, promotion, and cleanup continue over the private endpoint.

Raw bucket keys are not returned by the HTTP API. Storage operations and metadata writes stay workspace-scoped. Upload requests, verification, and rejection create audit events. `reference-only` and `unknown` rights remain explicit; saving a screenshot does not grant reuse rights.

## Lifecycle and Trash

An upload request is a lease, not permanent storage. By default, an unfinished upload expires after 60 minutes. The lifecycle coordinator checks expired uploads and due Trash items at startup and every 15 minutes. Cleanup failures remain visible and use durable retry times instead of disappearing.

Managers and owners can move an unused file to Trash. OriginPost first checks every content draft and proof in the workspace; a referenced file cannot be trashed. Trash is recoverable for seven days by default. After that date, the private object is removed and the database keeps a small `deleted` record with its audit history. Reusing a stale browser version is rejected, so two managers cannot silently overwrite each other's decision.

The Library shows stored bytes, ready assets, unfinished uploads, recoverable bytes, cleanup errors, Trash, and cleanup history. The lifecycle settings are bounded at startup:

```bash
MEDIA_UPLOAD_LEASE_MINUTES=60
MEDIA_TRASH_RETENTION_DAYS=7
MEDIA_CLEANUP_INTERVAL_MINUTES=15
MEDIA_CLEANUP_ENABLED=true
MEDIA_FFPROBE_PATH=ffprobe
MEDIA_INSPECTION_TIMEOUT_MS=15000
MEDIA_MALWARE_SCAN_MODE=disabled
MEDIA_CLAMAV_HOST=127.0.0.1
MEDIA_CLAMAV_PORT=63310
MEDIA_MALWARE_SCAN_TIMEOUT_MS=120000
MEDIA_MALWARE_SCAN_MAX_BYTES=536870912
```

`disabled` exists only for non-live local development. The API and worker both refuse `ALLOW_LIVE_PUBLISH=true` unless `MEDIA_MALWARE_SCAN_MODE=clamav`. Compose keeps clamd on its private service network and maps port 3310 to loopback port 63310 for local development/testing; never expose the unauthenticated clamd TCP socket publicly.

Start the official multi-platform ClamAV 1.4 Debian image and the application together with:

```bash
MEDIA_MALWARE_SCAN_MODE=clamav docker compose --profile app --profile malware-scan up -d --build
```

The ClamAV signature database is persisted in `originpost-clamav`. FreshClam updates it in the [official container](https://docs.clamav.net/manual/Installing/Docker.html). The profile configures the stream, file, and aggregate scan ceilings to 512 MB, enables limit-exceeded alerts, and allows up to 120 seconds per scan. ClamAV recommends substantial memory for the signature engine; size the deployment before enabling this profile.

After the stack is healthy, verify the complete API → presigned object upload → ClamAV → metadata path with `node scripts/runtime-media-malware-smoke.mjs`. It admits a tiny clean PNG and submits the official harmless EICAR antivirus test signature, which must be rejected and removed from object storage. The named clean QA asset and rejected evidence record remain in the local development Library for inspection; do not run this smoke script against a production workspace.

The manual `POST /v1/media-assets/cleanup` endpoint is manager/owner-only and workspace-scoped. It uses the same lifecycle rules as the coordinator.

## Publish preflight

Before scheduling, the NestJS application loads every referenced Media Asset and asks the selected platform connector to validate the complete draft. Publishing is blocked when a file is missing, not `ready`, has an infected/unavailable/pending malware result, is not `owned` or `cleared`, is not an image/video type accepted by the connector, or lacks trusted server-measured metadata. The worker runs the same checks again immediately before publishing. Files that predate migration 057 are marked `unavailable` and must be re-uploaded before publication.

The current Instagram contract requires exactly one image for an image post, 2–10 media files for a carousel, or exactly one video for a Reel. The first Facebook Page contract accepts text with no media or one single-image post. The YouTube Shorts contract requires one square/vertical video no longer than three minutes. Caption, media-count, alt-text, size, measured shape, and measured duration checks run through one reusable media-policy seam.

Media responses expose only normalized inspection/scan facts: malware status, scan time/tool identifier, bounded threat name or stable failure summary, detected content type, width/height in pixels, duration in integer milliseconds, and metadata inspection time/tool identifier. They never expose clamd network details, `ffprobe` stderr, command lines, object keys, or browser-declared dimensions. Images are limited to 64 MB and 100 megapixels during metadata inspection; video metadata inspection is limited to 512 MB, 15 seconds by default, one thread, a 10 MB probe/analyze budget, and 64 KB of tool output. Malware protocol frames and responses are bounded independently. The API image includes `ffprobe`; custom deployments must keep it installed or set `MEDIA_FFPROBE_PATH` to an approved executable. Files uploaded before migration 031 are also marked metadata `unavailable` until re-uploaded.

The worker repeats preflight before calling a connector. Successful Proof of Publish records contain the exact SHA-256 of every published media file; the worker never replaces attached media with an empty list.

## Temporary provider delivery

Official social APIs may need to download an image or video from an internet-reachable URL. OriginPost does not make the bucket or Library public. In official connector mode, the worker creates a delivery token that is:

- signed with a separate `MEDIA_DELIVERY_SECRET` of at least 32 bytes;
- valid for no more than two hours;
- bound to one workspace, Media Asset ID, and exact SHA-256;
- accepted only while the asset is still `ready` and its rights are `owned` or `cleared`.

The provider receives `/v1/media-assets/delivery/:token`. The public route verifies the signature, expiry, workspace ownership, current hash, readiness, and rights before streaming the private object with `Cache-Control: private, no-store`. It never returns the bucket key. A copied, changed, expired, wrong-workspace, wrong-hash, uncleared, or rejected grant returns no media.

The route advertises `Accept-Ranges: bytes` and supports one `bytes=start-end` or `bytes=start-` request. A valid range is read directly from private object storage and returns `206` with `Content-Range` and the exact partial `Content-Length`, so a provider can resume a large video without the API loading or sending the whole file. Suffix, malformed, unsatisfiable, and multiple ranges return `416`; signed-grant checks still run first so an invalid token cannot be used to discover private object sizes.

Use a different value from every other application secret:

```bash
MEDIA_DELIVERY_SECRET="$(openssl rand -base64 48)"
```

## Current limits

Allowed types are JPEG, PNG, WebP, GIF, MP4, MOV, WebM, MP3, MP4 audio, WAV, WebM audio, and PDF. A single object may be at most 500 MB. ClamAV scanning and server metadata inspection are independent gates; neither is a transform or full decode/transcode. Media transforms, resumable multipart upload, and per-workspace quotas are not part of this alpha yet. The temporary delivery route is a prerequisite for an official connector; it does not enable live publishing by itself.
