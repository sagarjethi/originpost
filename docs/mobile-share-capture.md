# Mobile Share Capture

Mobile Share Capture sends one phone photo or video, a web link, or selected text into OriginPost's existing governed Media Library and Content Inbox. It never publishes, approves, or schedules from the capture screen.

## Use it

### Android and ChromeOS Share Target

1. Install OriginPost from a Chromium browser that exposes installed PWA Share Targets.
2. In the phone Share menu, choose **OriginPost** and share at most one supported photo or video. A title, text, and URL can accompany it.
3. OriginPost streams the file into private quarantine, verifies its hash, performs server-side malware scanning, and then performs bounded media inspection.
4. On the review screen, choose the exact Workspace, Brand, purpose, and rights. Rights have no default.
5. Choose either:
   - **Save to Library** — saves one inspected asset and creates no content; or
   - **Create Content Item** — available only for creative media with owned or cleared rights. It creates one unapproved, unscheduled draft with the exact asset attached.

Link- and text-only shares still use **Add to Inbox** and remain `reference-only` source context.

### iPhone, iPad, desktop, and unsupported browsers

The `/capture` screen offers **Upload from phone** using the normal authenticated browser upload. This is an honest fallback, not iOS Share-sheet parity. A real iOS Share-sheet receiver requires a native containing app and Share Extension and is outside this PWA slice.

## File contract

- Exactly one `media` part is accepted.
- Images: JPEG, PNG, WebP, or GIF, up to 64 MiB.
- Videos: MP4, MOV/QuickTime, or WebM, up to 500 MiB.
- The declared MIME type and file extension must match the allowlist.
- Text fields, part count, and total selected-file count are bounded. Empty, interrupted, extra, repeated, or unsupported parts fail closed.
- Upload parsing streams with backpressure into a mode-0600 temporary file; arbitrary video bytes are not buffered into the API heap.
- The object store verifies exact length, content type, and SHA-256 before quarantine is accepted.

## Trust boundary

- Share Target data uses `POST multipart/form-data` to `/v1/share-captures/intake`; shared content never appears in the redirect URL.
- Team deployments require the normal signed-in session. The narrow CSRF alternative applies only to the Share Target route, a top-level/system or same-origin navigation, and exact form or multipart content. Cross-site submissions are rejected.
- The normal `/v1/share-captures/uploads` fallback uses the standard CSRF token.
- The API sets a random 32-byte receipt token in an HttpOnly, SameSite cookie. PostgreSQL stores only its SHA-256 hash.
- Browser responses omit the token hash, normalized URL, quarantine object key, materialization claim owner, and claim expiry.
- Receipts belong to one user, expire after 15 minutes, and clear shared title/text/URL after conversion or expiry.
- Private preview responses are `private, no-store` and available only through the user-bound receipt.
- The user-selected Workspace is authorized by membership; Brand and media lineage are resolved server-side.
- A file cannot become a ready Media Asset until the finalized server bytes pass inspection again.
- Unknown and reference-only rights may be saved to the Library, but they cannot create a publishable draft.

## Replay, leases, and cleanup

The receipt owns deterministic Media Asset and Content Item identities. Materialization records a canonical hash of Workspace, Brand, purpose, rights, mode, and draft choices before any final copy.

PostgreSQL atomically elects one materializer with a DB-clock lease. A second request returns busy, and an expired worker cannot finalize the receipt. Exact retries reuse the same pending or ready asset; a transient database write after byte verification leaves a retryable pending record rather than deleting valid bytes.

When content mode is selected, the Content Item and initial draft use deterministic receipt lineage. A crash after the asset or item save reconciles the same records instead of creating duplicates. Terminal receipt cleanup removes the quarantine object in bounded retryable passes.

## Compatibility and current limits

- Draft choices are derived from inspected MIME type, dimensions, duration, purpose, and rights. Later schedule and worker preflight checks still run.
- Instagram Story images require an exact 9:16 inspected JPEG; Story video requires exact 9:16 and 3–60 seconds.
- YouTube Short intake is limited to square/vertical inspected video up to 180 seconds.
- The first release is online-only. Offline receipt/outbox, multi-file/carousel capture, a native iOS app, browser extension, email forwarding, and provider publishing are not claimed.
- Installed Web Share Target availability must still be tested on the exact production HTTPS origin and target Android/ChromeOS devices.
