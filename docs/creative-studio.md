# Creative Studio

Creative Studio turns one ready, server-inspected Library image into an exact social PNG without bypassing OriginPost's content, approval, or proof workflow.

## First release

- Templates: Headline, Photo-led editorial, and Quote.
- Outputs: 1080×1080 square, 1080×1350 portrait, and 1080×1920 story/reel cover.
- Text: kicker, headline, subtitle, and footer with bundled Latin, Gujarati, and Devanagari font fallbacks.
- Controls: layout, font family, alignment, focal point, zoom, and a five-color palette.
- Source requirements: image, `ready`, inspection `ready`, same workspace and brand, and rights `owned` or `cleared`.
- Output: immutable PNG in the existing Media Library, with exact measured dimensions, SHA-256, propagated rights, source/render audit lineage, and reference-safe retention.

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

Saving edits appends a revision. It never changes an older revision or silently replaces an approved draft. Attaching an output creates a new content draft; it never mutates an existing approved revision.

A Story-format render is intentionally attached only as an Instagram `story` draft. Its review copy remains internal and is not sent as a caption. Basic auto-publish supports the baked 9:16 image; interactive Story overlays stay in the manual-handoff path.

## Rendering and recovery

With Redis configured, the NestJS coordinator sends work to `originpost-creative-render`. The render attempt is already durable in PostgreSQL before BullMQ receives the job. A database-clock lease fences completion and failure writes. Duplicate requests reuse a ready or active identical manifest; an expired or failed attempt is reclaimed with a higher attempt count. A periodic recovery pass reconstructs expired work from PostgreSQL.

Without Redis, the same coordinator executes in-process for local self-hosted development. PostgreSQL remains the authority when configured.

The renderer bounds source bytes and decoded pixels, normalizes orientation, applies deterministic focal cropping, rejects text overflow instead of clipping it, escapes text before SVG composition, and emits a deterministic PNG. Generated output is inspected again through the normal trusted-media pipeline before the render is marked ready.

## API

- `GET /v1/creative-studio/templates`
- `GET /v1/creative-studio/projects?workspaceId=&brandId=`
- `GET /v1/creative-studio/projects/:projectId?workspaceId=`
- `POST /v1/creative-studio/projects`
- `POST /v1/creative-studio/projects/:projectId/revisions` with `If-Match`
- `POST /v1/creative-studio/projects/:projectId/revisions/:revisionId/render` with `If-Match`

Render leases, bucket keys, and internal worker ownership are never returned to the browser.

## Non-goals and safety

This slice does not generate synthetic documentary imagery, remove backgrounds, edit video, scrape media, or provide unrestricted free-form layers. It does not claim that the browser preview is the publication artifact. The user must own or clear the source image rights. Synthetic image generation, when introduced later, needs a separate disclosure-bearing lineage contract.

Custom fonts and arbitrary SVG/HTML uploads are not accepted. The renderer uses shipped font families and fixed template code to avoid remote-font drift and unsafe markup execution.
