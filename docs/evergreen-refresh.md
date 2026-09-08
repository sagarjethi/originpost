# Evergreen Refresh Queue

OriginPost can turn a proven published post into a bounded refresh cycle:

`publish proof → saved analytics → fresh draft → human approval → normal schedule → new proof`

This is not a blind repost switch. Every cycle creates a new Content Item and a new draft. The old approval is never copied. A person must check and approve the exact new draft before the existing scheduling and publishing flow can use it.

## What the first release does

- shows published candidates with the latest provider-native views, reach, or engaged views when available;
- keeps missing analytics as missing instead of showing `0`;
- requires a written reason when a person chooses a candidate without ready analytics;
- requires a 7–365 day interval, an end date within one year, and a maximum of 1–52 cycles;
- keeps the chosen local wall time across daylight-saving changes;
- prepares the next draft up to 24 hours before its intended date;
- uses deterministic Content Item and cycle identities so worker restarts do not create duplicates;
- pauses a cycle if source lineage, rights, or storage checks fail;
- sends a deduplicated approval notification when the new draft is ready;
- links a later publish proof back to the exact cycle after the refreshed draft is approved and published on the same account;
- supports one-click pause and safe resume without a burst of missed drafts.

## Safety rules

- News, breaking updates, monitor findings, Source Signals, high-risk content, synthetic-media posts, and collaborator posts never become automatic reposts.
- The feature does not automatically publish any cycle in this release. Every refreshed draft needs a new human approval.
- Reuse is not permission. Attached media must still be server-verified, ready, and `owned` or `cleared` when the policy is created. Reference-only source material is not reusable media.
- Relative dates, prices, offers, elections, weather, earthquakes, live scores, office holders, health/legal/financial advice, and similar changing facts are shown as freshness warnings.
- Instagram/Facebook/YouTube connector checks still run through the normal schedule and publish paths. Evergreen never calls a provider directly.
- YouTube video reuse still follows the existing media and API compliance gates. This feature does not claim that repetitive uploads are safe for monetization.

## API

```text
GET  /v1/evergreen/summary?workspaceId=&brandId=
GET  /v1/evergreen/candidates?workspaceId=&brandId=
GET  /v1/evergreen?workspaceId=&brandId=
POST /v1/evergreen
GET  /v1/evergreen/:id?workspaceId=
POST /v1/evergreen/:id/pause?workspaceId=    If-Match: <version>
POST /v1/evergreen/:id/resume?workspaceId=   If-Match: <version>
```

Creating and changing a cycle requires a human manager or owner. Reads use the normal workspace membership guard. Scheduling, review, approval, proof and remote correction stay in the existing Content Item modules.

## Operations

Migration `042_evergreen_reuse.sql` stores workspace/brand-scoped policies, lease-fenced due claims, and one occurrence per policy ordinal. The worker scans every five minutes. It claims work with a 120-second lease, creates or reuses the deterministic draft Content Item, records the occurrence, advances the next local schedule, and notifies the team. PostgreSQL checks the lease with its own clock before it writes a success or failure occurrence.

If content creation succeeds but final cycle recording is interrupted, the next worker claim finds the same deterministic Content Item and finishes the record. It does not make another draft.

After the team approves and publishes that Content Item through the normal channel flow, the worker links the matching account/platform Publish Proof into the cycle history. It never calls Instagram, Facebook, or YouTube by itself.
