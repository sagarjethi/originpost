# Source-to-proof research flow

OriginPost treats agent research as a tracked job, not as trusted final copy.

1. A user creates a Content Item and starts research.
2. The API stores a queued Research Run and adds a BullMQ job.
3. The worker marks it running and calls either the safe mock provider or Hermes.
4. Hermes can search and extract web pages through its own tools.
5. OriginPost saves direct source links, dates, excerpts, checked claims, and tool history.
6. A human uses the saved evidence to create and approve a platform draft.
7. Publishing uses a separate target job and records Proof of Publish.

## API example

```bash
curl -X POST http://localhost:4000/v1/content-items/CONTENT_ID/research \
  -H 'content-type: application/json' \
  -d '{
    "query": "Ahmedabad rainfall update",
    "depth": "standard",
    "languages": ["English", "Gujarati", "Hindi"],
    "region": "Gujarat, India",
    "sourceLimit": 8,
    "freshnessHours": 168
  }'
```

The response is `202 Accepted`. Read the Content Item again to see the latest `researchRuns`, `sources`, and `claims`.

## Safety rules

- A completed research run is evidence for review, not automatic approval.
- Direct URLs and publication dates must be kept with factual claims.
- Screenshots may help discovery but do not grant media reuse rights.
- A failed run remains visible in audit history.
- Real social publishing stays disabled until an official connector is configured and reviewed.
