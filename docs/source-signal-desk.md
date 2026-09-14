# Source Signal Desk

Source Signal Desk is the review queue between a tracked public source and the Content Inbox. A finding is not a post and is not approved content. A person must save it before normal writing, review, scheduling, and publishing can begin.

## Luma Mumbai event watch

The built-in **Luma Mumbai events** preset watches the official public city page at <https://luma.com/mumbai>. A dedicated bounded adapter reads that one page's structured public listing directly, even when general source research remains in safe mock mode. It keeps only:

- event title and official Luma event URL;
- scheduled date and time;
- the publicly displayed or approximate venue;
- public host or organizer names.

The adapter rejects non-public and online events, caps the page and result count, validates direct event URLs, and fails closed if Luma's structured page contract changes. It never returns or persists attendee counts, featured guests, private guest records, email addresses, or guest-only exact venue details. It does not open individual event pages or bypass login, rate limits, or visibility controls. The Mumbai image in the interface is a city reference supplied by the workspace owner. It is not documentary proof of a listed event.

Luma documents city pages and city iCal subscriptions as public discovery surfaces. Calendar API access is a separate Luma Plus feature and requires a calendar-scoped API key; OriginPost does not request that private key for public Mumbai discovery. See [Luma event search](https://help.luma.com/p/searching-for-events), [Luma API](https://help.luma.com/p/luma-api), and [Luma calendar syncing](https://help.luma.com/p/ical-syncing).

The preset checks every 60 minutes. **Check Luma now** asks the existing monitor queue to run immediately. A result appears only after the bounded public adapter completes the run. This is a curated public-source watch, not a promise that every Mumbai event is present.

## Supported tracked sources

- `rss_atom`: an explicit RSS or Atom source.
- `luma_city`: currently only the exact official `https://luma.com/mumbai` page.
- `publisher_site`: public, server-rendered publisher pages collected with a desktop browser and a private source screenshot.
- `public_profile`: stays disabled until a dedicated official connector exists.

All collected links are stored as `reference-only`. Source visibility does not grant image-reuse rights.

## Ranking

The visible score is simple and explainable:

- 35 points for matching a tracked source;
- 10 for a primary source, or 5 for a trusted source;
- up to 30 for configured terms;
- 15 when two or more independent publishers support the event;
- 10 for a valid recent publication time.

Provider confidence is not used as authority. A future timestamp gets no freshness points. The interface shows the reasons next to every score.

Repeated observations use an event fingerprint made from the normalized title plus stable provider IDs or all canonical event URLs. It is not based on one primary URL alone.

## Human save and recovery

`POST /v1/signals/:id/save` requires the current signal version in `If-Match`. The server reserves the signal before it creates the Content Item. The reservation has a short lease and a deterministic Content Item ID.

This order prevents two editors from creating duplicate content. If the process stops after the Content Item commit, retrying the same save completes the existing reservation instead of creating another item. Dismiss and restore are also version checked.

## Routes

- `GET /v1/signals`
- `GET /v1/signals/summary`
- `GET /v1/signals/:id`
- `POST /v1/signals/:id/save`
- `POST /v1/signals/:id/dismiss`
- `POST /v1/signals/:id/restore`

Signals are always scoped to the authenticated workspace and brand.

## Daily news collections and critical sourcing

Create a named section with explicit RSS/Atom feeds in the News & Source Desk. The dedicated public-feed collector reads RSS 2.0 and Atom, keeps original article links, strips markup from excerpts, and marks claims unverified. It never downloads feed images or treats them as licensed media. Feed provenance permits article URLs outside the feed path only when supplied by the dedicated collector. Repeated URLs retain their signal identity when headlines change.

The worker supports feed, publisher-page and mixed Luma/feed/page collections without falling through to a mock researcher. Collection continues when a source fails; partial failures appear as degraded monitor health. Complete failure remains a failed run. Each feed has a 2 MB response limit, 15-second request deadline, up to three redirects with public-address validation, and no credentials. XML document entities are rejected. At most 500 entries per feed and 500 entries per collection are processed; the desk pages through 100 matches at a time. This is bounded discovery, not exhaustive web coverage.

Newest published uses a source publication timestamp with an explicit clock and timezone. Missing, day-only, or timezone-free timestamps remain unknown. Newly found uses first observation, never the latest repeat. The 2-hour, 24-hour and 7-day windows filter by publication before the result limit and exclude unknown dates. Sections filter by monitor; all queries remain workspace/brand scoped.

Save & research preserves the selected report and original evidence, then queues the existing research workflow. It does not claim the research completed, and a replay does not queue duplicate research. If queuing cannot be confirmed, the saved item remains accessible. Critical claims must be checked against independent reporting origins, then the final caption and rendered image compared with the evidence before approval.

[Checked source catalog](research/2026-09-15-news-source-catalog.md) documents endpoint tests, date limitations, rights, and text/image review requirements. Chrome was also used locally to inspect the rendered PIB page. Publisher-page collection now saves desktop screenshots. The interactive Codex image upload continuation is also implemented; see [the image handoff contract](research/2026-09-15-codex-image-workflow.md).

## Local acceptance — 2026-09-15

A real `Science · NASA` section was saved from the desktop owner UI with a 120-minute interval and `https://www.nasa.gov/feed/`. The rebuilt Docker worker's scheduled run completed with provider `public-feeds`, seven discoveries, and seven new persisted signals. The desktop section filter plus Last 24 hours displayed article links, source publication times, and separate first-seen times in newest-first order. No source image was downloaded, no claim was approved, and nothing was published. The overlapping manual check was skipped without duplicate work. Monitor health now uses the latest non-skipped run while retaining skipped checks in history.

Validation includes live feed retrieval; six feed parser/network-policy tests; source-domain freshness and provenance tests; real PostgreSQL publication filtering, pagination, and isolation tests; API query validation; worker routing; and desktop UI inspection. Live text/image generation and connected-platform publishing still need their own acceptance checks. Browser-capture acceptance is recorded below.

## Desktop publisher capture — 2026-09-15

Choose **Publisher websites · desktop screenshots** when creating a collection. The worker opens each configured page in an isolated 1440×1000 browser context, collects up to 40 same-origin story links, and retains a viewport screenshot with its final page URL, capture time and SHA-256. A screenshot of an index is evidence of the index page; it does not imply every linked article was read or appears in the viewport. Claims remain unverified and screenshots remain reference-only.

The browser does not reuse personal Chrome cookies or profiles. Scripts, service workers, frames, downloads and WebSockets are disabled. Page and resource requests use a DNS-pinned public HTTP(S) transport with no forwarded credentials. Robots restrictions and rate-limit responses are respected. Requests have byte and time limits; no more than four resource fetches run concurrently, with a 24 MB page budget, 96-resource cap and a 45-second capture deadline. Up to 20 configured pages run sequentially; slow collections can exceed their nominal check interval, and overlapping runs are skipped. Some images or styling may be absent; the viewer reports resource failures. Intraday filters require a source-provided timezone-qualified timestamp, not a date inferred from a screenshot.

Screenshots are content-addressed in the private S3 bucket under workspace/brand scope. `GET /v1/signals/:id/sources/:sourceId/screenshot` signs only the screenshot referenced by an accessible signal. They are not publishable Library media. Identical screenshots reuse the same key; historic objects remain until operator-managed retention removes them. There is no automatic screenshot cleanup yet.

A real **Science · NASA website** collection, configured for two-hour checks, used local Google Chrome to follow NASA's news URL to `https://www.nasa.gov/news/recently-published/`. Its scheduled run stored 20 leads and a desktop screenshot. The screenshot was opened and visually inspected inside the source desk. A second run in the sandboxed Docker Chromium worker found 18 current listing links and zero new signals, demonstrating URL-based deduplication. Exact publication times were unavailable on that listing and stayed unknown. No claims were approved and nothing was published.

For the local worker, install its browser using `pnpm --filter @originpost/worker exec playwright install chromium`. `WEBSITE_BROWSER_EXECUTABLE` may point to an installed Chrome binary for a local run. The Docker worker installs its pinned browser and dependencies, runs as the non-root `node` user with Chromium sandboxing, and uses the included namespace-enabled seccomp profile. Private S3 storage must be configured. See [Playwright browser installation](https://playwright.dev/docs/browsers), [network interception](https://playwright.dev/docs/network), and [sandboxed Docker crawling](https://playwright.dev/docs/docker#crawling-and-scraping).

The complete local web/API/worker stack was subsequently rebuilt and redeployed. A fresh capture through the main API completed with 18 discoveries and zero new signals; its 1440×1000 image was visually checked in the deployed source desk at `http://localhost:3000/signals`.
