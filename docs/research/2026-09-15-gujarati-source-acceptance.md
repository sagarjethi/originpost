# Gujarati source acceptance — 15 September 2026

## Akashvani / News on AIR Gujarati

Candidate: [the publisher's Gujarati homepage](https://newsonair.gov.in/gu/).

Installed local Chrome opened the public page in a fresh desktop profile at 1440×1000. The page displayed Gujarati national, regional, business, sport and weather headlines with dates from 14 September 2026. The snapshot and extracted visible text are retained privately under `data/gujarati-source-acceptance/`; they are research evidence, not reusable Wing News media.

The web-search copy returned older page content. It must not be used to establish this page's current headlines or freshness. This is a concrete reason to compare a current browser capture with any indexed search result before enabling a source.

The homepage's `rel=alternate` links were language alternatives, not advertised RSS/Atom feeds. No feed endpoint was inferred from those links. The visible dates use Gujarati month names and AM/PM text; a date displayed without an explicit timezone must not silently become an intraday UTC timestamp.

## Collection gate

| Check | Observed result |
| --- | --- |
| Fresh local Chrome page | Succeeded; current Gujarati content was visible |
| Desktop screenshot | Captured at 1440×1000 |
| Advertised RSS/Atom endpoint | None found in alternate-link metadata |
| Existing server-style page collector | Timed out after 30 seconds waiting for page load |
| Second isolated Chrome inspection | Timed out after 30 seconds waiting for DOM readiness |
| Stable story extraction and timestamp mapping | Not yet proven |
| Scheduled collection enabled | No |

The timeouts do not establish their cause, and one successful page view does not establish a reliable collector. Keep this source as a candidate for manual research. Before enabling it, verify a stable public endpoint, record the actual article-card structure, test extraction against a structural fixture, preserve date precision/timezone evidence and demonstrate a completed collection with source health and deduplication. Do not bypass publisher restrictions or copy personal browser cookies to the worker.

The existing NASA, PIB, RBI and SEBI collections are unaffected. This candidate does not close the remaining Gujarati-publisher coverage requirement or establish exhaustive news coverage.

## Wrapped-card extraction follow-up

The bounded public transport subsequently retrieved the Gujarati homepage (HTTP
200, 192,903 bytes) and its permissive robots file. The conventional `/gu/feed/`
probe timed out; it is not an accepted feed.

Inspection of the retrieved HTML identified a separate extraction gap: headline
`h2`/`h3` elements sit inside whole-card anchors. The browser collector now supports
those anchors, reads their accessible full headline, excludes the publisher's
view counters and date labels from excerpts, and retains the richer excerpt when
the same article appears in several sections. Offline Chrome extraction of the
retrieved page found 19 article URLs. Relative Gujarati ages and date strings
without an explicit timezone remain unknown publication dates.

A real Chrome regression test covers wrapped Gujarati cards, duplicate cards,
ordinary article markup, explicit timestamp conversion, and rejection of external
or current-listing links. The six focused extraction/provider tests pass, as does
worker typechecking. A subsequent production collector attempt still aborted.
This fixes extraction coverage, but does not prove reliable live collection; the
Gujarati monitor remains disabled pending successful live acceptance.

## Transport diagnosis and alternative feeds

A traced production-path retry failed while retrieving `robots.txt`, before the
browser was launched. This establishes an intermittent policy-transport failure
on that attempt; it does not establish that browser readiness caused every prior
failure. The collector now preserves a safe, actionable robots-policy failure in
its source-health error. Partial successful collections retain separate failure
codes without exposing raw transport details.

Additional direct bounded probes on 15 September returned:

- `https://www.gujaratsamachar.com/rss`: HTTP 404.
- `https://www.gujaratsamachar.com/rss/top-stories`: HTTP 404.
- `https://sandesh.com/rss`: HTTP 200, HTML application shell, not RSS/Atom XML.

These URLs are not accepted feeds. A search result or an RSS-labelled navigation
link does not prove a working feed. No new scheduled monitor was enabled from
these probes. Nine focused browser extraction, source-provider and robots-policy
tests pass, including preserving successful sources when another fails.

## Desktop rendering diagnosis

The deployed sandboxed worker subsequently reached the Gujarati document but
hit its 30-second full-load deadline. Changing readiness to DOMContentLoaded plus
a three-second resource window reached screenshot creation, which then timed out
waiting for web fonts. The collector now cancels unfinished resource requests at
that boundary, allowing installed fallback fonts. A real Chrome regression uses
both a stalled image and a stalled web font and verifies article text plus a
1440×1000 PNG.

A sandboxed Docker trial then finished in 4.7 seconds with 19 extracted links,
but visual inspection rejected the result: only navigation and player chrome
were visible, with the news cards hidden by script-dependent animation styling.
This is not an accepted source screenshot. Extraction now excludes cards hidden
by ancestor opacity, visibility or display and prevents those hidden cards from
falling back to a fabricated homepage lead. The publisher remains disabled; a
subsequent conventional Gujarati feed probe also timed out.

The existing NASA website collection completed after the preceding worker update
with 18 leads and zero new duplicates. RBI, SEBI and PIB each completed their next
two-hour scheduled run at approximately 03:09 UTC on 15 September, with zero new
duplicates. This verifies continued scheduling and deduplication for those sources,
not completion of Gujarati coverage.
