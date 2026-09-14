# News source catalog and evidence requirements

Checked 15 September 2026. This is a small, explicitly tested source catalog, not a promise to collect every story on the web. A feed being reachable proves delivery only; it does not prove a story, image rights, freshness, or permission for commercial aggregation.

## Feed URLs and observed behavior

Checks below were direct HTTPS requests from the development machine followed by XML parsing. No login, browser cookies, access-control bypass, or third-party feed proxy was used. Item counts and dates are observations of one response, not enduring availability guarantees. Sample timestamps are copied from feed metadata, not independently verified event times.

| Publisher / coverage | Feed URL | Language observed | Direct result | Publisher evidence / deployment condition |
| --- | --- | --- | --- | --- |
| NASA / science and space | `https://www.nasa.gov/feed/` | English | HTTP 200; RSS XML; 10 items. First date: `Mon, 14 Sep 2026 19:00:00 +0000`. | Exact feed linked as Recently Published Content in the [official feed directory](https://www.nasa.gov/rss-feeds/). Apply the source-specific media and AI conditions below. |
| PIB / India government releases | `https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3` | Hindi titles in the fetched sample, despite English selected in the directory | HTTP 200; RSS XML; 20 items. Sample items contained title and link only, **no publication date**. | Exact endpoint in [PIB's directory](https://www.pib.gov.in/ViewRss.aspx?lang=1&reg=3). Treat language as observed metadata, not guaranteed by query parameters. Read linked release for date and primary statements. |
| RBI / India monetary policy and banking | `https://rbi.org.in/pressreleases_rss.xml` | English | HTTP 200; RSS XML; 10 items. First date: `Fri, 11 Sep 2026 21:40:00` — **timezone missing**. | Exact link extracted from [RBI RSS page](https://www.rbi.org.in/Scripts/rss.aspx). Preserve raw date; do not silently interpret in the server timezone. Policy text must be checked in the actual release. |
| SEBI / India markets regulation | `https://www.sebi.gov.in/sebirss.xml` | English | HTTP 200; RSS XML; 30 items. First date: `14 Sep, 2026 +0530` — **day precision, no clock time**. | Exact endpoint in [SEBI's instructions](https://www.sebi.gov.in/rss.html). Includes releases, circulars and orders. Do not invent an intraday timestamp. |
| BBC / world | `https://feeds.bbci.co.uk/news/world/rss.xml` | English | HTTP 200; RSS XML; 32 items. First date: `Mon, 14 Sep 2026 11:31:39 GMT`. Next item was later, so feed order is not necessarily newest first. | BBC supplies feed documentation through its [developer site](https://support.bbc.co.uk/platform/feeds/NewsFeeds.htm). Documentation retrieval timed out in this run; feed request succeeded. Verify current terms for intended product use before enabling. |
| BBC / business | `https://feeds.bbci.co.uk/news/business/rss.xml` | English | HTTP 200; RSS XML; 57 items. First date: `Mon, 14 Sep 2026 21:10:15 GMT`. | Same BBC documentation and terms check as above. Do not infer image-reuse permission from an enclosure or thumbnail. |
| Indian Express / Ahmedabad and Gujarat coverage | `https://indianexpress.com/section/cities/ahmedabad/feed/` | English | HTTP 200; RSS XML; 200 items. First date: `Mon, 14 Sep 2026 19:54:12 +0000`. | Exact endpoint in [publisher RSS directory](https://indianexpress.com/rss/). **Restricted: personal, non-commercial consumption. Do not activate commercial aggregation without permission.** |
| Indian Express / India | `https://indianexpress.com/section/india/feed/` | English | HTTP 200; RSS XML; 200 items. First date: `Mon, 14 Sep 2026 17:30:55 +0000`. | Same [directory and restrictions](https://indianexpress.com/rss/). Directory also lists Surat, Rajkot, Gandhinagar, business and science, but those feeds were not fetched in this check. |

The Indian Express feed directory does not grant republication rights to articles or photographs; it explicitly limits feed consumption to personal and non-commercial use. Its working feeds belong in a permission-dependent research catalog, not an automatically enabled commercial preset. [Publisher terms](https://indianexpress.com/rss/).

The Economic Times similarly restricts its feeds to personal use and explicitly disallows aggregation and commercial use without consent. It is not an enabled recommendation here. [ET RSS terms](https://economictimes.indiatimes.com/rss.cms).

## Sources that need further work

| Source | Exact observed evidence | Decision |
| --- | --- | --- |
| DeshGujarat | [Homepage](https://deshgujarat.com/) HTML advertises `https://deshgujarat.com/feed/` with `rel=alternate` and RSS MIME type. Fetch failed strict XML parsing at line 5, column 64. | Do not call operational or build a workaround scraper from this result. Investigate response shape and permission separately. |
| JPL | [Official RSS page](https://www.jpl.nasa.gov/rss/) advertises `https://www.jpl.nasa.gov/feeds/news/`; direct request returned HTTP 403. | Show source unavailable; do not bypass the block. NASA's own main feed is a separate observed working source. |
| Gujarat Samachar, Sandesh, other Gujarati publishers | No directly verified operational Gujarati-language RSS endpoint in this research pass. | No invented `/feed` URLs. Add a documented publisher API/feed or a reviewed, permission-compatible site adapter. A web page labeled “feed” can be a personalization page rather than RSS. |
| Gujarat public services | Local government, weather, transport, courts and police sources need source-by-source endpoint and permission checks. | Use attributable original bulletins or user-submitted official links until adapters are verified. Social posts are leads, not an automatic license for their media. |

A browser bookmark or open Chrome tab can suggest a source, but production collection must run from server-owned configured URLs. Do not transfer personal session cookies or credentials. If a publisher has no feed, a public-page adapter needs explicit extraction fixtures, source terms review and a visible health state. Do not promise arbitrary browser-site crawling as feed support.

## What “recent” must mean

These requirements follow from the malformed/incomplete timestamps observed above:

- Store source publication time, source update time, first discovery time and last successful fetch time separately, with raw timestamp text and precision.
- Sort “Newest published” by trustworthy publication timestamps, not response order or crawler discovery time. Put unknown-date items in a clearly labeled group. Let users separately choose “Newly found”.
- A day-only date can support a daily filter, not “last 10 minutes”. Missing timezone is unknown until source-specific evidence establishes it. Never manufacture freshness by assigning `now()` as publication time.
- Offer section, source, language, verification status and time filters. A 24-hour collection window is not proof that every item describes an event within that window.
- Preserve source fetch failures. An empty successful feed and a failed fetch have different meanings. A daily digest must state the checked source set and failed sources.
- Use feed ID/canonical article URL for stable identity, then content hashes for meaningful updates. Preserve corrections and source snapshots; do not collapse independently reported evidence into one anonymous summary.

## Critical sourcing: two distinct review passes

This is the proposed editorial contract, not a claim that every gate is already enforced in code. It carries forward the project's existing evidence-trail and visual-provenance approach.

1. **Before writing:** record canonical URLs, publisher/author, retrieval time, publication and event dates, location, exact relevant excerpts and source hashes. Build a shared fact ledger for names, numbers, units, dates, quotes, official wording, uncertainty and disputed claims. Prefer the original document for what it actually establishes; an official statement is evidence of that statement, not proof of every disputed allegation. Find independent corroboration for material disputed claims. Two sites syndicating the same wire story are one reporting origin, not two independent sources.
2. **Before release:** independently compare headline, caption and text rendered inside the image with that locked ledger. Reopen material sources for corrections, examine whether translation changes certainty, and verify each image's event/date/location and rights. Record unresolved differences and block the affected claims or media. Human editorial review remains necessary for high-risk stories.

Every discovered item begins as a lead. Search snippets, RSS excerpts, generated summaries, template example captions and similar-post reference images cannot silently become verified facts. A “two checks” badge needs recorded results from both passes; merely calling the same model twice is insufficient evidence of independent verification.

## Image evidence and generation

Keep two separate records: **story evidence** and **visual provenance**. For each original visual, retain its original URL/file hash, creator, owner, permission/license record, event date/location, retrieval time and every transformation. Preserve the unmodified original. A thumbnail in a feed is a discovery clue, not permission to reuse it. Image authenticity and reuse rights are separate checks.

Generated or materially AI-edited imagery must be visibly illustrative and disclosed. It must not impersonate documentary proof of a real incident. Use original approved project logos as exact assets and compose exact headline, credit and disclosure layers deterministically when necessary. Similar-post references supply layout/tone only; they do not supply facts, another publisher's identity, or asset rights.

NASA permits many factual editorial uses subject to its media guidelines, acknowledgment, third-party rights and non-endorsement conditions. Its current guidelines also contain specific AI attribution and logo restrictions; do not turn NASA into a blanket unrestricted source or place its insignia into generated imagery. Source disclosure must not imply NASA reviewed an AI output. Review the precise intended workflow against [NASA's media and AI guidance](https://www.nasa.gov/nasa-brand-center/images-and-media/) before release.

## Operational acceptance evidence

A source is ready to enable only when its ownership, exact URL, allowed use, response parser, timestamp behavior and category/language mapping have been recorded and tested. Polling should honor cache headers, bounded payloads/timeouts, per-host backoff and redirects validated against SSRF rules. Store health and last success per source. Protect against XML entity expansion and treat remote content as untrusted data, never instructions.

For a production daily aggregator, demonstrate: scheduled jobs actually running; durable deduplication across restart; valid newest/date filters on the observed edge cases; source errors visible without dropping successful sources; clicking a lead preserves its original sources in research; and no post can bypass claim, media and approval checks. A successful local feed probe alone does not establish that complete workflow.
