# Creative Studio

Creative Studio turns one ready, server-inspected Library image into an exact social image without bypassing OriginPost's content, approval, or proof workflow. Its internal ChatGPT image-creation panel can first generate a visual foundation; it is intentionally not a separate top-level product area.

## First release

- Templates: Headline, Photo-led editorial, and Quote.
- Outputs: 1080×1080 square, 1080×1350 portrait, and 1080×1920 story/reel cover.
- Text: kicker, headline, subtitle, and footer with bundled Latin, Gujarati, and Devanagari font fallbacks.
- Controls: layout, font family, alignment, focal point, zoom, and a five-color palette.
- Source requirements: image, `ready`, inspection `ready`, same workspace and brand, and rights `owned` or `cleared`.
- Output: immutable PNG in the existing Media Library, with exact measured dimensions, SHA-256, propagated rights, source/render audit lineage, and reference-safe retention.
- Optional visual foundation: one-shot OpenAI Image API generation using the server-configured GPT Image model, followed by the normal inspection and Library pipeline.

The editor's browser preview is intentionally marked as a layout guide. Only the exact server render is publishable: JPEG for Instagram Story outputs and PNG for the other Creative Studio formats.

## Immutable workflow

```text
Ready rights-cleared Library image
  → immutable CreativeRevision with canonical spec SHA-256
  → revision + renderer/font/template manifest SHA-256
  → leased background render
  → server image inspection and exact dimension/hash comparison
  → ready Library output
  → new immutable Instagram/Facebook image draft, or Instagram Story draft for 1080×1920 output
  → existing human approval, schedule, publish, and proof workflow
```

When the visual starts with ChatGPT, the full journey is:

```text
Human brief + optional Content Item context
  → one idempotent paid image request
  → clearly illustrative visual foundation with no rendered copy or logos
  → malware and image inspection
  → immutable AI lineage in the Library
  → deterministic Creative Studio text, brand, credit, crop, and safe-area composition
  → editorial/brand check
  → immutable draft with server-derived synthetic-media state
  → required platform disclosure, human approval, publish, and proof
```

The provider request includes the selected Content Item's title and summary only as editorial context. Source IDs are validated against that Content Item. Generated assets never become factual evidence: a real-event claim still needs its own verified Source Evidence.

Saving edits appends a revision. It never changes an older revision or silently replaces an approved draft. Attaching an output creates a new content draft; it never mutates an existing approved revision.

A Story-format render is intentionally attached only as an Instagram `story` draft. Its review copy remains internal and is not sent as a caption. Basic auto-publish supports the baked 9:16 image; interactive Story overlays stay in the manual-handoff path.

## Rendering and recovery

With Redis configured, the NestJS coordinator sends work to `originpost-creative-render`. The render attempt is already durable in PostgreSQL before BullMQ receives the job. A database-clock lease fences completion and failure writes. Duplicate requests reuse a ready or active identical manifest; an expired or failed attempt is reclaimed with a higher attempt count. A periodic recovery pass reconstructs expired work from PostgreSQL.

Without Redis, the same coordinator executes in-process for local self-hosted development. PostgreSQL remains the authority when configured.

The renderer bounds source bytes and decoded pixels, normalizes orientation, applies deterministic focal cropping, rejects text overflow instead of clipping it, escapes text before SVG composition, and emits a deterministic PNG. Generated output is inspected again through the normal trusted-media pipeline before the render is marked ready.

## ChatGPT image creation

OriginPost uses the OpenAI Image API for this one-shot generation workflow, following OpenAI's guidance that the Image API is the best fit when a single prompt produces a single image. The adapter calls only `https://api.openai.com/v1/images/generations`, requests PNG bytes, bounds the returned base64 and decoded payload, and stores the provider request ID when available. See the official [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation) and [GPT Image model documentation](https://developers.openai.com/api/docs/models/gpt-image-2).

Generation is disabled by default:

```dotenv
IMAGE_GENERATION_MODE=disabled
OPENAI_IMAGE_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst
OPENAI_IMAGE_TIMEOUT_MS=180000
```

Set `IMAGE_GENERATION_MODE=openai` and provide `OPENAI_IMAGE_API_KEY` on the API server to enable it. `OPENAI_API_KEY` is accepted as a server-side fallback. Neither key is returned to the browser, persisted in a generation record, audit detail, or provider error, nor written to a Library asset.

Each accepted request requires an `Idempotency-Key`. OriginPost durably records the request fingerprint and lease before making the paid provider call. It never automatically retries a timeout or unavailable/ambiguous provider result, because doing so could create duplicate paid output. Such results become `uncertain` and require human inspection. Confirmed provider rejection becomes `failed`.

The generated media stores its model, generation ID, prompt SHA-256, generation time, verified source IDs, and mandatory disclosure flag. The exact prompt remains in the protected generation record but not in audit-event detail. A deterministic Creative Studio render preserves the upstream synthetic lineage. When a user creates a social draft, the API derives `containsSyntheticMedia` from the attached Library bytes; the browser cannot clear it. Scheduling then fails closed unless Instagram's native AI-info setting or YouTube's altered/synthetic setting is approved as required. Facebook proofs record `synthetic-media` when generated lineage is present.

Conversational image editing is not included in this slice. The capability endpoint reports `editing: false` instead of implying that a one-shot generator supports iterative edits.

## API

- `GET /v1/creative-studio/templates`
- `GET /v1/creative-studio/projects?workspaceId=&brandId=`
- `GET /v1/creative-studio/projects/:projectId?workspaceId=`
- `POST /v1/creative-studio/projects`
- `POST /v1/creative-studio/projects/:projectId/revisions` with `If-Match`
- `POST /v1/creative-studio/projects/:projectId/revisions/:revisionId/render` with `If-Match`
- `GET /v1/image-generations/capability?workspaceId=`
- `GET /v1/image-generations?workspaceId=&brandId=`
- `GET /v1/image-generations/:generationId?workspaceId=`
- `POST /v1/image-generations` with `Idempotency-Key`

Render leases, bucket keys, and internal worker ownership are never returned to the browser.

## Non-goals and safety

This slice does not generate synthetic documentary evidence, perform conversational image editing, remove backgrounds, edit video, scrape media, or provide unrestricted free-form layers. It does not claim that the browser preview is the publication artifact. Uploaded source images must be owned or cleared; generated foundations carry a separate mandatory disclosure-bearing lineage contract.

Custom fonts and arbitrary SVG/HTML uploads are not accepted. The renderer uses shipped font families and fixed template code to avoid remote-font drift and unsafe markup execution.
