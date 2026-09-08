# Proof-linked analytics

OriginPost attaches every analytics snapshot to one immutable Proof of Publish. The post ID, account, platform, workspace, brand, and content item must all agree before a worker saves provider data.

Every proof now records how existence was established: `official`, `manual_attestation`, `provider_reconciliation`, or `simulation`. Legacy rows are classified without rewriting their immutable payload. Simulated proofs are visibly labeled, never receive a “View live” action, cannot enter remote-correction controls, and are blocked from public client links. Legacy proofs whose provenance cannot be classified are restricted in the same places until replaced by verified or human-attested evidence. CSV exports retain an `evidence_mode` column so internal test data cannot be mistaken for provider results.

## What is implemented

- Instagram media insights through the official media Insights endpoint;
- Facebook Page Post insights through the official, version-pinned post Insights endpoint when the deployment and Page grant both pass their independent gates;
- YouTube owned-channel metrics through the YouTube Analytics `reports.query` endpoint;
- a BullMQ refresh queue and automatic first capture after publishing;
- immutable PostgreSQL snapshots with a SHA-256 of the provider response instead of the raw provider payload;
- current, stale, pending, unavailable, privacy-threshold, expired, hidden, permission-missing, unsupported, and failed states;
- per-proof history and trends only between compatible ready snapshots;
- brand-scoped reads and per-account/platform rollups;
- a responsive proof ledger with live-post links and role-aware refresh controls;
- reusable multi-brand Client Report definitions with rolling or fixed date ranges;
- immutable report snapshots tied to the exact Proof of Publish and saved provider snapshots;
- expiring, revocable read-only client links and UTF-8 CSV exports.

Facebook analytics is proof-level only: views (`post_media_view`), unique viewers (`post_total_media_view_unique`, displayed as reach), and clicks (`post_clicks`). OriginPost does not fetch Page-wide time series, ad analytics, Reels insights, or legacy impression/reach metrics. Missing Facebook data is never shown as zero or mislabelled as another platform.

Migration `023_post_analytics_snapshots.sql` adds the durable snapshot table and workspace/brand/proof indexes.
Migration `038_analytics_client_reports.sql` adds report definitions, append-only report snapshots, and token-hash-only client links.
Migration `059_facebook_page_post_analytics.sql` permits Facebook proof snapshots without changing the immutable proof lineage.

## Client Report Studio

Open **Analytics → Client reports**. A workspace manager or owner can select active brands, Instagram/Facebook/YouTube platforms, a rolling or fixed date range, and the metrics to include. Generating the report creates a new immutable snapshot; it never rewrites an older client report.

Each account stays in its own brand/platform/account group. A metric is added across posts only when its unit, provider metric, source, coverage, definition version, and aggregation contract are identical. If definitions differ, the report says **Kept separate**. Facebook unique viewers are marked non-additive and are never summed across posts. Missing, permission-limited, failed, and stale data keep their real states and are never changed to zero.

The authenticated report detail shows the complete proof lineage and canonical SHA-256. A public client link receives a reduced view without workspace IDs, proof IDs, content IDs, provider object IDs, raw provider hashes, or provider error details. The server stores only the SHA-256 of the random share token. Links expire after 1–90 days and managers can revoke active links from the report screen. CSV export is available to authenticated report readers and through an active public client link.

The first release intentionally does not generate PDF files, send reports by email, benchmark accounts, invent engagement rates, or merge views across providers. Those are separate later workflows.

Authenticated routes are under `/v1/analytics/reports`. Public read-only routes are `/v1/analytics-reports/:token` and `/v1/analytics-reports/:token/export.csv`; both return `Cache-Control: no-store`.

## Trust rules

An unavailable value is not zero. Connectors omit metrics that a provider did not return, and the interface shows a dash plus the provider state. A measured zero remains numeric zero.

Instagram, Facebook, and YouTube do not define every metric the same way. OriginPost does not combine their views into one performance score. YouTube `views` and `engagedViews` remain separate. Facebook unique viewers are independently calculated and non-additive. Organic Instagram values are not silently merged with paid, Facebook, or cross-posted totals.

Trends require two ready snapshots of the same proof with the same raw metric, source, coverage, unit, definition version, and aggregation contract. Definition changes stop comparison instead of creating a misleading trend.

## OAuth scopes

The built-in Instagram Login flow requests `instagram_business_manage_insights` in addition to the publishing scopes. The YouTube flow requests `yt-analytics.readonly` plus the existing upload and channel-read scopes. When Facebook analytics is enabled, Facebook Login requests `read_insights` together with `pages_read_engagement` and `pages_show_list`, and the selected Page must expose the `ANALYZE` task. Existing connections must reconnect to grant newly required analytics access.

Facebook analytics is disabled by default even when Page publishing is official. Enabling it requires `FACEBOOK_ANALYTICS_CONNECTOR_MODE=official`, a lowercase SHA-256 reference to immutable Meta App Review evidence, and a lowercase digest plus current operator-attested time window for an externally watched owned-Page probe on the exact `META_GRAPH_API_VERSION`. OriginPost validates this recorded evidence but does not claim to run the external probe. The window may not exceed 30 days. Connection Doctor reports the deployment gate and Page grant separately from publishing readiness.

## Provider limits

Instagram insights can be delayed. Metric availability varies by media type and account path. Facebook post metrics commonly update daily, so the automatic first capture waits 24 hours. Empty or omitted Facebook rows remain pending or unavailable rather than becoming zero, and omitted metrics are retried individually once. YouTube recent dates can be incomplete and privacy thresholds can omit rows. OriginPost records these conditions; it does not scrape any platform as a fallback.

Before external YouTube analytics launch, deployments must add the documented 30-day authorization/video-existence check, deletion after revocation, compliant data retention, YouTube attribution, and policy review. Derived YouTube rates, scores, benchmarks, and cross-owner aggregates remain disabled.

## Verification

Run:

```bash
pnpm db:migrate
pnpm check
```

In safe mock mode, publish one approved post, open **Analytics**, refresh its proof twice, and confirm that the second compatible snapshot—not a hard-coded percentage—produces the displayed trend.

Then open **Client reports**, save a report definition, generate a snapshot, export CSV, create a client link, and revoke it. Confirm that the public URL becomes unavailable immediately after revocation.
