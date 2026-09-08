# Proof-linked analytics

OriginPost attaches every analytics snapshot to one immutable Proof of Publish. The post ID, account, platform, workspace, brand, and content item must all agree before a worker saves provider data.

## What is implemented

- Instagram media insights through the official media Insights endpoint;
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

Facebook Page publishing proofs appear in the content and calendar workflows, but Facebook Page metrics are not fetched in this release. The Analytics screen says they are unavailable and excludes them from Instagram/YouTube rollups. Missing Facebook data is never shown as zero or mislabelled as YouTube.

Migration `023_post_analytics_snapshots.sql` adds the durable snapshot table and workspace/brand/proof indexes.
Migration `038_analytics_client_reports.sql` adds report definitions, append-only report snapshots, and token-hash-only client links.

## Client Report Studio

Open **Analytics → Client reports**. A workspace manager or owner can select active brands, Instagram/YouTube platforms, a rolling or fixed date range, and the metrics to include. Generating the report creates a new immutable snapshot; it never rewrites an older client report.

Each account stays in its own brand/platform/account group. A metric is added across posts only when its unit, provider metric, source, coverage, and definition version are identical. If definitions differ, the report says **Kept separate**. Missing, permission-limited, failed, and stale data keep their real states and are never changed to zero.

The authenticated report detail shows the complete proof lineage and canonical SHA-256. A public client link receives a reduced view without workspace IDs, proof IDs, content IDs, provider object IDs, raw provider hashes, or provider error details. The server stores only the SHA-256 of the random share token. Links expire after 1–90 days and managers can revoke active links from the report screen. CSV export is available to authenticated report readers and through an active public client link.

The first release intentionally does not generate PDF files, send reports by email, benchmark accounts, invent engagement rates, or merge Instagram and YouTube views. Those are separate later workflows.

Authenticated routes are under `/v1/analytics/reports`. Public read-only routes are `/v1/analytics-reports/:token` and `/v1/analytics-reports/:token/export.csv`; both return `Cache-Control: no-store`.

## Trust rules

An unavailable value is not zero. Connectors omit metrics that a provider did not return, and the interface shows a dash plus the provider state. A measured zero remains numeric zero.

Instagram and YouTube do not define every metric the same way. OriginPost does not combine their views into one performance score. YouTube `views` and `engagedViews` remain separate. Organic Instagram values are not silently merged with paid, Facebook, or cross-posted totals.

Trends require two ready snapshots of the same proof with the same raw metric, source, coverage, unit, and definition version. Definition changes stop comparison instead of creating a misleading trend.

## OAuth scopes

The built-in Instagram Login flow requests `instagram_business_manage_insights` in addition to the publishing scopes. The YouTube flow requests `yt-analytics.readonly` plus the existing upload and channel-read scopes. Existing connections must reconnect to grant newly required analytics access.

## Provider limits

Instagram insights can be delayed. Metric availability varies by media type and account path. YouTube recent dates can be incomplete and privacy thresholds can omit rows. OriginPost records these conditions; it does not scrape either platform as a fallback.

Before external YouTube analytics launch, deployments must add the documented 30-day authorization/video-existence check, deletion after revocation, compliant data retention, YouTube attribution, and policy review. Derived YouTube rates, scores, benchmarks, and cross-owner aggregates remain disabled.

## Verification

Run:

```bash
pnpm db:migrate
pnpm check
```

In safe mock mode, publish one approved post, open **Analytics**, refresh its proof twice, and confirm that the second compatible snapshot—not a hard-coded percentage—produces the displayed trend.

Then open **Client reports**, save a report definition, generate a snapshot, export CSV, create a client link, and revoke it. Confirm that the public URL becomes unavailable immediately after revocation.
