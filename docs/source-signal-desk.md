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
- `publisher_site` and `public_profile`: may be recorded only as disabled reference entries. They cannot start generic crawling. A future official connector must explicitly enable them.

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
