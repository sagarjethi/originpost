# Agent news studio

The `/agent` route now runs a news-to-image workflow inside OriginPost. It replaces the earlier tab-local chat preview. Named agent group conversations remain an architectural proposal; this route currently uses the brand’s assigned text runtime and the server image provider.

## User flow

1. Open **Project templates**. Upload the original logo and up to three rights-cleared style reference images, or select images already in the active brand’s Library.
2. Choose language, square/portrait/Story format, text layout, colors, footer, logo corner, width, margin, background plate, and optional quarter of a four-logo board. The placement preview shows the selected crop and corner.
3. Save an immutable template version. Paste a news URL or news text and optionally add direction for this post.
4. **Research & create** starts source research, then copy, one paid image request, deterministic text/logo composition, and a domain draft. The UI polls every four seconds and displays copy and the final image as they become available.
5. Open **Sources & review** to inspect evidence and approve the exact draft through the existing workflow. Nothing is automatically published.

Templates and runs are scoped to Workspace and Brand. A run freezes its template, logo/reference hashes, and verified evidence hash. Changing a saved template does not change an existing run. New versions create a new run and paid request; they do not silently overwrite a prior draft.

## Implementation

- UI: `apps/web/components/agent-chat/news-post-workspace.tsx` and its CSS module.
- API: `apps/api/src/agent-posts/`.
- Domain: `packages/domain/src/agent-post.ts`.
- Persistence: `packages/db/src/postgres-agent-post-repository.ts`, migration `066_agent_post_runs.sql`.
- Existing Content, AgentRuntime, ImageGeneration, Media, and CreativeStudio services perform the work. Generated outputs retain synthetic lineage and a visible illustration label.
- Style references are normalized and sent to the official image-edit endpoint. The original logo is excluded from model input and composed from its validated bytes afterward. Exact Gujarati/Devanagari/Latin text uses the renderer’s bundled fonts.

## Configuration and operation

Apply migrations with the project’s database environment, then rebuild/restart API and web. For local development using the root `.env`:

```sh
node --env-file=.env --import ./packages/db/node_modules/tsx/dist/loader.mjs packages/db/src/migrate.ts
pnpm --filter @originpost/domain build
pnpm --filter @originpost/db build
pnpm --filter @originpost/api build
pnpm --filter @originpost/web build
```

The capability endpoint (`GET /v1/agent-posts/capability?workspaceId=…&brandId=…`) checks the research queue, enabled image provider, and a tested brand text runtime (or configured Hermes fallback). A connected queue is not proof that an external research worker is healthy; stalled research times out visibly.

Required live services: PostgreSQL, Redis plus research worker, private media storage, a tested brand runtime or Hermes, and `IMAGE_GENERATION_MODE=openai` with `OPENAI_IMAGE_API_KEY` (or `OPENAI_API_KEY`) on the server. `OPENAI_IMAGE_MODEL` chooses the deployment’s supported image model. Never put credentials in templates or post text. Memory storage remains development-only and loses runs on restart.

The API scans pending runs every three seconds and claims stages using repository compare-and-swap. A normal restart resumes unclaimed stages. An expired in-flight claim or unconfirmed command becomes `uncertain`, requiring inspection of linked receipts before another paid request. There is no automatic paid retry, resume button, cancel endpoint, or template deletion UI in this slice. Saved template assets are protected from Trash.

On 2026-09-14, migration 066 was applied locally and the local UI was connected to the updated API. The local image provider was disabled and no tested brand text runtime was assigned. No live image generation was claimed or performed.

## Validation

HTTP integration coverage substitutes external research/text/image providers while exercising real content creation, image receipts, media storage, rendering, and unapproved drafts. Additional coverage checks duplicate requests, concurrent claims, disputed evidence, expired claims, original logo pixels/hash rejection, multipart references, and PostgreSQL scope/CAS/idempotency in an isolated schema. Live provider credentials remain necessary for a real-news acceptance run.

## Project chat UI checkpoint — 2026-09-15

Implemented project filtering using existing Boards, versioned template configuration, explicit original-logo and reference uploads, reference thumbnails, four reusable writing presets, and a caption example used only for tone and structure. Board association organizes templates; it does not execute Board-installed Hermes skills or share their memory.

Completed runs accept revision messages in the same saved conversation. A revision retains the original source input and snapshots its template; it researches and generates a new paid image. Prior versions stay accessible. Unknown parents, changed source inputs, and active or uncertain parents are rejected. This is a post-revision conversation, not general-purpose multi-agent group chat.

The setup drawer reads actual brand account and generation capability status, distinguishes test connections, and links to channel, runtime, and Board configuration. Instagram, Facebook, and YouTube use the existing connector setup; publishing checks and approval still apply. Private output previews refresh while open.

The crawler, new viral-news card discovery, arbitrary social connectors, and expanded one-click publishing remain deferred until the UI checkpoint can be pushed. No Git remote is configured locally. Live image/text runtimes still require configuration; no real post was generated or published in this UI pass.
