# Agent news studio

The `/agent` route now runs a news-to-image workflow inside OriginPost. It replaces the earlier tab-local chat preview. Named agent group conversations remain an architectural proposal; this route currently uses the brand’s assigned text runtime and the server image provider.

## User flow

1. Open **Project templates**. Upload the original logo and up to three rights-cleared style reference images, or select images already in the active brand’s Library.
2. Choose language, square/portrait/Story format, text layout, colors, footer, logo corner, width, margin, background plate, and optional quarter of a four-logo board. The placement preview shows the selected crop and corner.
3. Save an immutable template version. Paste a news URL or news text and optionally add direction for this post.
4. **Research & create** starts source research, then copy, a separate text review against the frozen evidence, one paid image request, deterministic text/logo composition, and a domain draft. The UI polls every four seconds and displays copy and the final image as they become available.
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

The UI checkpoint and public website collector have been pushed to origin/main. Arbitrary social connectors and expanded one-click publishing remain incomplete. Live image/text runtimes still require configuration; no real post was generated or published in this UI pass.

## Second copy review

New runs persist `reviewing-copy` after writing and before image creation or Codex upload handoff. A fresh runtime session receives only the frozen evidence, finished copy and language. It checks factual support, attribution, language, and the proposed visual direction. It can use the same configured model as the writer; this is a separate pass, not independent reporting or a different-model guarantee. It does not fetch new sources or inspect image pixels.

All four categories must appear exactly once and pass. Findings, model/provider, time and input/evidence/copy hashes remain on the run. Rejected reviews block creation; invalid or uncertain responses never trigger image generation. Review calls use the `copy_review` runtime ledger feature for assigned profiles. Existing human approvals remain separate. Existing runs already past writing are not retroactively marked reviewed.

## Publishing from a finished agent post

`@Publisher` is an explicit action in a ready run. It is a bounded recipient (`originpost.publisher`), not arbitrary text-mention parsing or a general agent-group implementation. The panel stays in the project chat and uses existing draft approval and Instagram settings approval endpoints. Human approval is a separate click after inspecting the text and image. The panel preserves previously selected Instagram collaborators, feed choice and cover when changing the native AI label.

The publishing service reads the original run's exact draft, rendered asset, current evidence, brand, account and approved provider settings. Choose the next publish (about one minute) or a specific time. The preview shows a fixed timestamp; an expired preview must be prepared again. A preview binds these inputs and the current content version to a hash. Test connections, changed sources, missing approvals, invalid media, expired access and pending Instagram settings block preparation. Scheduling rechecks the preview and delegates to `ContentService.schedule`, including its conflict acknowledgement and atomic outbox commit. It never generates a human approval or calls the connector's publish method directly.

The target ID is stable per run/draft/account. Retrying an identical request returns the existing target; choosing a different time for that same request requires the existing content/scheduling workflow. Concurrent requests cannot create two targets or outbox deliveries. Status polling reads Content's targets. Queued means requested, not published; the full content receipt retains the provider outcome and proof.

The generated package currently supplies an Instagram image or Story draft. The general content editor remains the route for Facebook adaptations, video creation and YouTube-specific review. Arbitrary natural-language tags, automated pixel-level review and a live-provider end-to-end acceptance run remain incomplete.

## Finished-image review

New post creation requires a healthy assigned runtime with a `visionModel`. Its connection test sends a small generated color sample and verifies the response; a model-list response alone does not enable image review. The sample is a transport/capability check, not a measure of editorial accuracy. Configuring or changing the vision model requires a new test. This can use a different model from the text writer on the same provider endpoint.

After composition, `reviewing-image` reads the exact stored card bytes and the approved original logo, checking scope, rights, inspection and hashes before sending PNG/JPEG data URLs to the configured model. The logo reference uses the selected board crop. The expected headline and footer are withheld from the transcription prompt. Reported text is compared with the saved strings after NFC/whitespace normalization; numbers and punctuation are retained. Legibility, branding, visual integrity and disclosure must all pass, along with the exact-text comparison. A mismatch or incomplete response blocks drafting, preserves the rendered card and displays findings. An uncertain paid call is not automatically repeated.

Receipts retain the card/logo identifiers and hashes, input/evidence/copy hashes, transcribed text, checks, model/provider and time. Image bytes do not enter the runtime usage ledger. Chat publishing checks that a stored image-review receipt still matches the current asset and copy. Existing runs already past composition are not retroactively marked reviewed.

This automated check can be wrong, especially for small or non-Latin text. It cannot establish event authenticity or image-use rights and never creates a human approval. Local live acceptance still requires configured providers. See [the image-review integration notes](research/2026-09-15-image-review.md).

## Create a post from the source desk

Use **Create post** beside a new or saved lead. Agent loads the exact lead version and displays its original sources. Choose a template and image mode, edit the brief if needed, and submit. Opening the page alone does not start a paid run. Stale, dismissed, saving and other-brand leads cannot start; reopen the current lead from its source desk.

The server snapshots the selected lead and capture metadata, carries those sources into a new content item as reference-only with zero verification confidence, and does not inherit crawler claim verdicts. Research receives the original links, dates and bounded excerpts as untrusted leads. The request includes up to 20 web references and states how many were omitted. A new research result, copy review, image review and human release approval are still required. Revisions retain the original lead snapshot; the original source-desk record remains independently available for triage.
