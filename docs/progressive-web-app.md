# Progressive web app

OriginPost can be installed from a supported browser and opened in a standalone window. The web app remains the source of truth; installation does not create a second local content store.

## Privacy-safe offline behavior

The service worker never stores:

- authenticated pages;
- workspace, brand, content, media, approval, engagement, analytics, or proof responses;
- `/v1/*` API responses;
- signed `/review/*` pages or responses;
- cookies, tokens, credentials, or form values.

The only pre-cached files are the neutral `/offline.html` document and the reviewed public OriginPost icons. When a normal app or signed-review navigation loses the network, the service worker returns that generic document. It never stores the requested page, URL token, or response. The user must reconnect before reading or changing newsroom data. Provider publishing, approvals, scheduling, and background mutations never run from an offline queue.

## Installation

- Chromium-based browsers use the browser's install event when it is offered.
- On iPhone and iPad, OriginPost gives the native **Share → Add to Home Screen** instruction when the app is not already running standalone.
- Production installation requires HTTPS. Loopback development origins are the only normal HTTP exception.

## Updates

`/sw.js` is served with a JavaScript MIME type, `nosniff`, a same-origin script CSP, `Cache-Control: no-cache, no-store, must-revalidate`, and `Service-Worker-Allowed: /`. The offline document has a no-script CSP and contains no inline event handlers. A newly installed worker waits. OriginPost shows an update notice and activates it only when the user chooses **Reload**. This avoids replacing a running editor session without warning.

## Same-origin API networking

Browser code uses relative `/v1` and `/public/v1` paths. Next.js rewrites them to the server-only `ORIGINPOST_API_UPSTREAM`; the internal upstream is never a `NEXT_PUBLIC_*` value and is not shipped as a browser configuration value.

- Local development defaults to `http://127.0.0.1:4000`.
- Docker Compose embeds `http://api:4000` into the web build and uses the private Compose network.
- A custom deployment must set an origin-only HTTP/HTTPS `ORIGINPOST_API_UPSTREAM` **before** running `next build`.
- The public reverse proxy should expose only the HTTPS web origin. It does not need to expose NestJS on a second browser origin.

This is also the route used by password login, session cookies, CSRF-protected mutations, OIDC start/callback traffic, public automation requests, and signed external review reads/comments. Production provider callback variables such as `API_PUBLIC_URL` and `OIDC_REDIRECT_URI` must therefore use the public web origin plus their documented `/v1/...` paths.

## Deployment check

Before release:

1. Open the public HTTPS origin and verify the manifest, 192 px icon, 512 px icon, and maskable icon.
2. Install the app, launch it standalone, and verify the correct name, colors, and icon.
3. Open a normal workspace page, disconnect the network, and confirm only the neutral offline document appears after navigation.
4. Inspect Cache Storage and confirm it contains only `/offline.html` and the approved public icons. Confirm no API, review, media, authentication, or workspace response is stored.
5. Deploy a changed service worker and verify the update notice appears before activation.
6. Reconnect and verify session authentication, CSRF protection, and the normal server-owned workflow still apply.
7. From a second device, verify the browser calls the public web origin's `/v1` path and never calls loopback, plain HTTP, or the private upstream hostname.
