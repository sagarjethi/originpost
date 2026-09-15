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
