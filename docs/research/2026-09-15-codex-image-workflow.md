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
