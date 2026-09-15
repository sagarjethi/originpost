# Codex images → OriginPost templates → reviewed publishing

Verified 15 September 2026. This is implementation research, not evidence that a live image or social post was created.

## What a person can do

Yes: a person can ask Codex to create an image and supply an existing image as a visual reference. The official image-generation guide describes generation/editing from the composer and interactive CLI use of `$imagegen` with `-i` or `--image`. The former Codex documentation URL currently redirects to the shared ChatGPT Learn documentation. This confirms the interactive workflow; it does not establish that every account or unattended runtime has the same tools. [Official image-generation guide](https://learn.chatgpt.com/docs/image-generation)

Images can be attached/pasted into the composer or read from local files. The CLI accepts multiple files through repeated `--image` flags or comma-separated paths. Say whether each file is a source photograph, a layout reference, or a logo; an attachment alone does not explain the requested use. [Official image-input guide](https://learn.chatgpt.com/docs/image-inputs)

```text
News link + project template + image references
                       ↓
             Verify the story and write
                       ↓
      Generate a visual in Codex or OriginPost
                       ↓
       Keep the exact original logo and text
                       ↓
          Review facts, picture and caption
                       ↓
       Approve the selected platform version
                       ↓
           Publish → save the real receipt
```

## Separate the three execution paths

| Path | What is verified | OriginPost consequence |
| --- | --- | --- |
| Interactive Codex | Generate/edit with references in a supported interactive session. | An editor can create an asset, inspect it and bring the resulting file into the project. |
| Codex app-server | A documented integration protocol for authentication, history, approvals and streamed events; turn input supports `image` URLs and `localImage` paths. | Suitable for a deliberately built local client, with its own lifecycle and permissions. Image input does not itself prove a headless image-output tool exists. |
| OriginPost image worker | Current repository adapter calls the official Images API using a configured server key. | The web app can run image creation independently of an open desktop session when its provider is configured. |

The app-server documentation does **not** establish a public endpoint equivalent to the desktop session's `image_gen` tool. Do not expose or reverse-engineer a desktop tool as a shared hosted service. A future local connector must test capability discovery, output retrieval and failure handling on the exact installed runtime. [Official app-server protocol](https://learn.chatgpt.com/docs/app-server)

The public Image API provides generation and editing endpoints. The Responses API additionally supports conversational image generation and edits with image inputs. Both are documented server integration choices. The current guide lists `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`; model access must be tested for the deployment's account. [Official API image guide](https://developers.openai.com/api/docs/guides/image-generation)

## What the repository already does

These findings come from the files linked below, inspected on the verification date:

- [Image provider](../../apps/api/src/image-generation/image-generation.provider.ts): uses `/v1/images/generations` for a new visual and multipart `/v1/images/edits` when reference bytes are supplied. It returns image bytes, request identity and available usage. It does not call Codex desktop.
- [Provider setup](../../apps/api/src/image-generation/image-generation.module.ts): requires `IMAGE_GENERATION_MODE=openai` and `OPENAI_IMAGE_API_KEY` or `OPENAI_API_KEY`; otherwise capability is disabled. The inspected default is `gpt-image-2.5-sunburst`. A configured name is not a successful live access test.
- [Agent workflow](../../apps/api/src/agent-posts/agent-posts.service.ts): saves evidence, uses supported claims for writing, checks reference hashes, requests a wordless visual, composes the original logo and exact headline through Creative Studio, then adds an **unapproved Instagram draft**. A successful run does not establish Facebook/YouTube distribution.
- [Media controller](../../apps/api/src/media/media.controller.ts): provides authenticated upload creation/completion and scoped download URLs. This is an existing ingestion seam for externally created files, not a Codex-to-agent-run completion bridge.
- [Hermes runtime contract](../hermes-local-codex.md): OriginPost Boards require isolated Hermes Profiles and the restricted `codex_responses` execution loop. Personal `codex_app_server` use is separate. Switching Board execution to app-server would break the current attested boundary.

## Concrete implementation seams

The following is a proposal, not an implemented capability claim.

1. **Export a generation brief.** Export the immutable template ID/version, output format, visual prompt, source ledger and cleared style references from an agent run. Include an explicit instruction to omit logos/text from the generated visual. Keep credentials and private delivery URLs out of copied briefs.
2. **Accept a Codex-created visual.** Let an authorized editor upload the returned file and associate it with that exact run. Persist declared generation origin, prompt/reference hashes, supplied model identity when known, and source provenance. Do not label an external upload as an original documentary photo or fabricate a provider receipt.
3. **Resume composition without another paid generation.** Validate brand ownership, decoded image type/dimensions, inspection status, rights and the saved evidence/template hashes. Use a versioned, idempotent transition from an explicit awaiting-visual stage. Apply the same deterministic template compositor as the existing worker path.
4. **Review both copy and pixels.** Check names, dates, numbers, attribution and unresolved claims against sources. Separately inspect the actual rendered image for readable text, exact logo, cropping, disclosure and authenticity. A second model opinion or a green generation job is not independent documentary corroboration.
5. **Interpret “post this” as a concrete publishing intent.** Bind it to a visible content version, destination accounts and supported format. Reuse OriginPost's content approval and publishing permissions. Preserve per-destination status and actual provider receipts; retry only failed destinations after reconciling uncertain ones. A still image is not automatically a YouTube video.

Exact composition remains necessary: OpenAI documents limitations in precise text placement, recurring brand consistency and structured layout control. Reference fidelity is not a guarantee of a pixel-identical logo. [Official API limitations](https://developers.openai.com/api/docs/guides/image-generation#limitations)

## Evidence needed before calling this end-to-end

- A reference-guided image produced by the configured live provider or a supported interactive Codex session, with the resulting bytes inspected.
- A real imported/generated visual composed with a saved project template, exact original logo, exact headline and required disclosure.
- Independent source verification and a rendered-output review recorded against the same content version.
- A scoped authorized publishing attempt on each supported destination, followed by an actual provider receipt and visible post verification.
- Recovery tests for expired asset links, changed references/evidence, upload failure, provider timeout and duplicate publish intent.

This research does not verify any live account credentials, local generation entitlement, deployed worker, or social-platform publication. Those remain runtime acceptance checks rather than documentation facts.

## Implemented upload continuation (15 September 2026)

Agent now accepts `imageMode: codex-upload`. It runs research and writing, then persists `awaiting-image` without polling or calling the Images API. An authorized editor downloads `GET /v1/agent-posts/:id/image-brief`, generates the image interactively in Codex, uploads through normal inspected media storage, and submits `POST /v1/agent-posts/:id/image` with `mediaId`, `briefHash`, `expectedVersion`, and brand/workspace scope. The UI exposes both actions.

The brief freezes the template, copy and evidence hash, with source records included for review. Import checks the scope, evidence, brief hash, ready/cleared image and exact run version. Duplicate attachment of the same image/brief returns the existing run. The worker copies the uploaded bytes to a separately inspected AI-labelled asset; it does not relabel the original Library upload. Lineage says `editor-attested-codex-upload` and records import time without inventing a generation timestamp or provider receipt. The original logo and exact headline are composed by the existing renderer; the result is an unapproved draft.

Migration `067_agent_post_external_images.sql` adds the waiting stage. Server generation remains the default. Waiting runs are not subject to the one-hour execution timeout; upload resumes a bounded execution window. This is an interactive file handoff, not a headless Codex image API or automatic @mention publishing. Real-provider generation, double editorial/visual review and connected-platform publishing still require live acceptance.

## Local CLI image-input acceptance — 15 September 2026

A live smoke test used installed Codex CLI 0.153.4 with its existing ChatGPT sign-in. An ephemeral, read-only invocation with user configuration ignored received a generated 480×160 PNG of three colour panels. It returned `{"colors":["blue","yellow","red"]}`, matching the actual pixels. The runtime reported `gpt-6-astra`; no provider key was copied into OriginPost, and no news story, private creative or publication was involved.

This proves local non-interactive image input and a text result on this account. It does not prove image generation output, news verification accuracy, isolation between product users, or an installed OriginPost runtime adapter. A local connector still needs bounded process lifecycle, constrained tools, private temporary asset cleanup, exact run binding and a capability test. It must not expose the personal authenticated CLI as a public shared endpoint. The installed personal Hermes is 0.20.6 with a carried local commit; it was not upgraded or repurposed as the pinned OriginPost Board runtime.

The official [non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode) documents CLI automation; the [app-server protocol](https://learn.chatgpt.com/docs/app-server) is the separate integration seam for streaming clients. Neither this smoke test nor image-input support establishes unattended image-output capability.

## Live acceptance findings — source context and layout guidance

The first real NASA training draft was correctly blocked by copy review: its caption contained details absent from the saved short excerpt. The blocked run is retained. Local source retrieval now preserves a bounded window of independently fetched text, its hash and a truncation marker alongside the original quote check. Writing and review receive the same window, and editors can inspect it in the source card. Text presence is not a truth verdict.

Both server generation and exported Codex briefs now share layout-specific placement guidance. A top-headline template reserves the upper area and places the illustrative subject below it; lower-headline, side-panel and statement layouts have separate guidance. This fixes a conflict where every template previously reserved the lower area for text. Actual final pixels still require review.

The first revision exposed a PostgreSQL source-key collision: a new content item reused a discovery source ID already owned by the original item. Source imports now derive a separate ID per content item and retain the original lead IDs in the audit event. Live PostgreSQL verification confirmed distinct IDs, unchanged original evidence and a running research job. The failed revision remains recorded; it failed before content creation or a provider call.

Top-headline text can shrink by at most 15% to fit its three-line limit. Text geometry is checked before image generation, so a headline that still cannot fit is blocked before requesting a paid image.

## Real Codex image and durable composition acceptance

An interactive Codex image call produced a conceptual NASA-training equipment illustration, then an image edit repositioned the subjects. The tool did not return a model identifier; provenance records it as unknown. The selected PNG was uploaded through normal inspection and copied to a separate AI-labelled media record. The original upload remained unchanged.

This exposed two production defects: full-canvas cropping hid part of the illustration under the headline, and PostgreSQL rejected creative snapshots containing the logo/disclosure fields. Renderer v7 fits the image into a dedicated window between opaque text panels. Migration 071 accepts the supported fields and top-headline layout while retaining strict field validation. Actual PostgreSQL tests cover persistence plus rejection of unknown keys, malformed logo hashes and oversized disclosure text.

The retained image rendered successfully through Creative Studio at 1080×1920. An independent pixel/brand/provenance review returned `PASS_WITH_NOTES`; human publication approval remains absent. No image-generation retry was needed for composition recovery.

The resumed product vision check correctly blocked this candidate before draft creation: the propeller-plane illustration did not match the aircraft described by the NASA source. Headline, footer, disclosure and logo passed. The independent report alone therefore does not establish acceptance. A new revision removes all aircraft from the illustrative direction; the blocked candidate and both reviews remain retained.

`GET /v1/agent-posts/:id/composition-recovery` offers matching ready compositions among the latest 100 projects. `POST` accepts a project ID and expected run version. Recovery is restricted to uncertain Codex-upload composition handoffs with unchanged live evidence, a passed copy review, the bound brief and the retained AI image. It compares the complete creative-spec hash, records the prior error and recovering editor, and continues through the normal image-review/draft stages. It cannot resume an uncertain image review, generation-provider call or draft write. A changed revision blocks continuation. The chat exposes this as **Find saved composition**.

## Corrected draft acceptance

The next candidate passed factual review but stopped on Gujarati agreement in its image instructions. The editor correction flow now addresses this without repeating completed research: `POST /v1/agent-posts/:id/copy-revisions` takes corrected headline/caption/visual direction, the parent version and an idempotency key. It creates a new candidate in the same chat, retaining the original rejected candidate. Only an unchanged, live-researched source set can be reused. Old reviews, images, generation IDs and approvals are never copied. Stale, unauthorized, unchanged rejected-copy and conflicting replay requests are rejected. The new copy is independently checked before image creation continues.

This flow was exercised with the real NASA candidate. All four corrected-copy checks passed. Codex edited the illustration to remove the unsupported aircraft; normal media inspection accepted the PNG. OriginPost then applied the template, passed all four pixel-review categories and saved draft `draft_33d637fa-1a9e-436f-8a0c-a2880a970e00` automatically. No manual composition recovery was needed for this corrected run. The independent copy review found no material defect. Publication readiness returned only mock Instagram accounts and no approved targets; this proves local draft acceptance, not live social publishing.

A separate independent visual review returned `PASS_WITH_NOTES` for final image SHA-256 `0ca56727266270788cda916e0bed0855461ae5361a8d704ab46e0b2c8e575258`. It verified Gujarati text, original logo, handles, disclosure and safe areas. Its remaining recommendation is source/date on the card for standalone Story sharing. The package validator reports no errors; the Gujarati linter's only warning concerns the internal English template name. Human publication approval remains absent.

The correction form was opened and checked in installed desktop Chrome at 1440×1000 using an isolated profile. Its fields and submit control were reachable; editing hides the competing chat composer, and cancel restores it. The UI check did not submit a duplicate revision or publish anything.
