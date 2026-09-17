# Audio providers, project connections and access control

Researched 17 September 2026 against primary documentation. The implementation recommendations below are proposed design, not a claim that all features or live credentials are configured.

## Verified ElevenLabs integration

Start with downloadable text-to-speech. ElevenAgents is a separate conversational product with its own agent configuration, knowledge, tools and session authentication; it is not required to make narration for posts. The supplied [API quickstart](https://elevenlabs.io/docs/eleven-api/quickstart) currently uses `eleven_v3`. The supplied [TTS cookbook](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/text-to-speech) redirects to that quickstart. The [Agents quickstart](https://elevenlabs.io/docs/eleven-agents/quickstart) instead builds a conversational assistant.

| Capability | Current API | Implementation consequence |
|---|---|---|
| Generate speech | `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` | Server sends `xi-api-key`, JSON `text`, explicit `model_id`, and supported `language_code`; returned body is audio. Start with `output_format=mp3_44100_128`. |
| Discover account voices | `GET https://api.elevenlabs.io/v2/voices` | Search and paginate; return safe voice metadata to the UI. |
| Discover models | `GET https://api.elevenlabs.io/v1/models` | Filter `can_do_text_to_speech`; use returned language and limit metadata. |

The speech endpoint defaults to `eleven_multilingual_v2`, so always specify the intended model. `language_code` uses ISO 639-1; unsupported codes are ignored, and this parameter is unsupported by multilingual v2. Higher-quality output formats can require higher subscription tiers. [Speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

Voice discovery accepts `search`, `page_size` (default 10, maximum 100), and `next_page_token`. Continue using `has_more` and `next_page_token`; never label one page as the entire catalog. The response contains more personal/account metadata than the UI needs: project only ID, name, safe labels and category. The [voice library](https://elevenlabs.io/app/voice-library) is the provider's interactive application, not a REST endpoint. [List voices](https://elevenlabs.io/docs/api-reference/voices/search)

Model responses describe supported languages, TTS capability, per-request character limits and rate factors. These are discovery fields, not a substitute for the connected account's actual entitlement or invoice. [List models](https://elevenlabs.io/docs/api-reference/models/list)

### Languages and editorial quality

Eleven v3 explicitly includes Gujarati, Hindi and English among its 70+ supported languages. Multilingual v2 lists Hindi and English but does not list Gujarati. Do not route Gujarati to v2 or silently change providers for a cheaper generation. Prioritize `gu`, `hi`, `en` in the UI, then expose additional supported languages from capability discovery. [Model language lists](https://elevenlabs.io/docs/overview/models)

Recommended application behavior: preserve Unicode scripts, names, dates, units and verified numbers; preview a short pronunciation sample before a long paid generation; store the exact approved narration with output provenance. Translation or script improvement should be an explicit action, not an invisible transformation during TTS. Label generated narration as synthetic where used publicly. Native-language review remains necessary; model language support does not guarantee pronunciation quality.

### Voice cloning and conversational agents

The supplied [instant cloning guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/instant-voice-cloning) uses uploaded audio samples to create a voice. The provider's [product guide](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning) requires confirmation of rights and consent. Keep cloning a separately authorized capability with a recorded consent reference, retention/deletion controls and private sample storage. An uploaded file or public voice clip alone is not evidence of permission. Existing authorized account voices can be used without building cloning into the first TTS release.

If real-time ElevenAgents is added later, authenticate the OriginPost user on the server and issue a temporary provider signed URL rather than distributing the API key. The documentation describes a 15-minute initiation window and recommends signed URLs for client applications. [Agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)

## One project, several social accounts

Use one OriginPost workspace/brand as the security and billing boundary, with explicit project associations to existing connected social accounts. A project stores account IDs and publishing preferences, never duplicate OAuth tokens. OAuth connection, disconnect and credential rotation belong to a narrow management permission; drafting and generating audio can be separate permissions. This is a proposed domain boundary, to be reconciled with existing brand/project schemas before migration.

| Platform | Provider-owned requirement | Product setup |
|---|---|---|
| Instagram through Facebook Login | Professional Business/Creator account linked to a Page; `pages_show_list`, `instagram_basic`, `instagram_content_publish`, and `pages_read_engagement` are publishing/discovery-related permissions in Meta's collection. Personal consumer accounts are unsupported by this route. | Connect with OAuth, select the actual Instagram identity, associate it with the brand/project, show granted capabilities. Request comment permissions only if comment features are enabled. |
| Facebook | Meta's official collection obtains managed Pages from `/me/accounts` and uses a Page access token for actions on that Page. | Select a returned Page instead of accepting an arbitrary Page ID and token pasted by an editor. |
| YouTube | OAuth 2.0 authorizes channel operations; `youtube.upload` is an accepted upload scope. Unverified API projects created after 28 July 2020 have uploads restricted to private viewing until the required audit. | Configure Google OAuth credentials and callback, let the channel owner connect, show channel identity and publishing restrictions. YouTube needs a video asset; a generated MP3 or image is not itself a YouTube video upload. |

Sources: [Meta's official Instagram collection](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00), [Meta's official Page token collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api), [Google server OAuth guide](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps), [YouTube upload API](https://developers.google.com/youtube/v3/docs/videos/insert).

Meta's developer-site pages returned access errors in this research, so Meta claims above are limited to its official Postman collection. Revalidate app-review requirements and exact publishing scopes against the selected Meta login route during production setup; Instagram Login is a different integration and must not be conflated with the existing Facebook Login route.

Recommended OAuth handling: registered callback URL, server-side authorization-code exchange, expiring single-use state bound to the initiating user/workspace, encrypted access/refresh tokens, refresh/revoke lifecycle, and explicit readiness state. Do not label localhost callbacks or mock accounts as live production connections. Keep a reviewable post package with explicit target IDs before a user's publish action.

## Modular implementation plan

1. **Audio provider profile:** workspace-bound provider ID, label, encrypted credential reference, configured model, enabled capabilities, optional brand grants, version and audit metadata. Public responses expose configuration status only. Fixed provider adapters define their endpoints; an arbitrary URL and key do not imply compatibility.
2. **Provider contract:** `listModels`, `listVoices`, `synthesize` with bounded input/output, timeout and sanitized typed errors. ElevenLabs is first; reserve additional adapter IDs without pretending unimplemented providers work. The user's name “Arbombs” remains unidentified and needs an exact provider name/documentation before an adapter can be built.
3. **Durable job and media:** reserve an idempotency key before paid synthesis; persist queued/running/succeeded/failed/uncertain state; retain provider request ID where supplied. Store generated audio in the normal inspected media library with workspace/brand provenance and attach its media ID to the post. Do not automatically retry an uncertain paid request. Downloads use authorized, short-lived links.
4. **Least privilege:** separate managing credentials, using generation, attaching media and publishing. An editor may use an authorized profile without seeing or changing its key. A generic admin or cross-tenant support role must not automatically receive secret read access. Enforce the same checks in the backend, independent of hidden UI controls.
5. **Network policy:** distinguish inbound admin IP allowlists from provider outbound IP restrictions. Configure trusted reverse proxies before accepting forwarded addresses. Validate CIDRs, audit changes and prevent accidental lockout; an IP rule supplements authenticated roles, never replaces them. Prefer deployment-level enforcement until the product has a tested recovery route.
6. **UI:** Audio studio with project/brand, provider, model, language, voice, exact narration, character count, generate, status, play, download and attach-to-post. Add explicit empty/error/reconnect/insufficient-permission states. Settings should distinguish provider configuration from each project's permitted use.
7. **Verification:** cross-workspace denial, editor-versus-owner permissions, credential redaction and encryption, bad/expired key, unsupported model/language, pagination, bounded audio, duplicate requests, timeout uncertainty, media access and post attachment. Live provider acceptance needs an owner-configured key; live social acceptance needs authorized OAuth accounts.

## Skills and token efficiency

ElevenLabs documents reusable `text-to-speech` and `agents` skills; its CLI can also generate command-group skills from its embedded API definition without an API key. [API quickstart](https://elevenlabs.io/docs/eleven-api/quickstart), [Agents CLI](https://elevenlabs.io/docs/eleven-agents/operate/cli)

Recommended OriginPost skill packaging: a versioned manifest (`id`, author/source, revision, hash, locales, capability requirements, entrypoint, size), reviewed Markdown resources, and explicit enablement per project. Download only from configured catalogs, pin revisions, bound archive/file size, reject traversal/symlinks and executable install hooks, and never let imported text change authorization or access secrets. Downloaded skills are untrusted content, not administrative commands.

Use a small skill summary in discovery and load only the selected task's full instructions. Store reusable language rules once, pass only relevant locked facts and style requirements, and avoid repeatedly sending all provider documentation or entire conversations. Cache discovery by profile/version and reuse approved generated assets within the same workspace. A prompt-authoring role can propose compact templates and a separate language/editorial reviewer can check them; role labels must not imply real credentials or extra permissions. No numerical token-saving claim is established without measuring representative workloads.

## Phased extension: delivery styles, music and video

Current implementation scope is TTS narration exported as MP3. The following music and video work is a plan, not an implemented or live-tested capability.

**Phase 1 — narration presets.** Add News reader (measured, neutral, short factual sentences), Weather reader (clear locations, dates, temperatures and uncertainty), and Conversational explainer (plain language and shorter clauses). These are OriginPost editorial presets, not ElevenLabs API style enums. Preserve the source facts and chosen language; show any proposed script change before synthesis. Save a versioned preset with the voice/model and exact final narration so an output can be traced to its inputs.

Eleven v3 exposes stability modes Creative, Natural and Robust; higher stability reduces responsiveness to expressive direction. Bracketed audio tags can influence performance, but their effect depends on the selected voice. It does not support SSML break tags. Use punctuation and native-language sentence breaks for a neutral baseline; preview optional tags with the actual voice instead of promising deterministic delivery. [Current TTS best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)

The product guide explicitly marks speed, similarity and speaker boost unavailable for Eleven v3. Its generic FAQ says speed applies to all models, which conflicts with those model-specific statements. Follow the model-specific restrictions and validate any advanced setting with the actual provider before exposing it. Do not reuse the full v2 settings payload blindly or invent a `news_reader` API parameter. A numeric stability mapping should be adapter-validated; the named mode descriptions alone are not proof of accepted numeric values. [TTS product settings](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)

**Phase 2 — music as a separate provider capability.** Implement `composeMusic` behind a dedicated capability, permission and job type, with model, duration, prompt, instrumental preference, provenance and downloadable media output. The official endpoint is `POST https://api.elevenlabs.io/v1/music`; it accepts either a text prompt or a composition plan, not both. `force_instrumental=true` is available for prompt-based requests. The reference currently defaults to `music_v1` and describes v2/v2.5 behavior; the current quickstart uses `music_v2_5`. Specify the selected model rather than inheriting a changing default. Public API documentation is not evidence that a particular connected account has entitlement or credits. [Compose API](https://elevenlabs.io/docs/api-reference/music/compose), [Music quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/music)

For a first post-music workflow, offer a bounded instrumental bed with no generated lyrics, preview/download, and attach-to-project. Keep it distinct from sound effects and TTS. Do not claim upload-to-inpainting is a free library-upload operation: ElevenLabs documents generation-equivalent cost and copyright inspection for its music upload endpoint. Use OriginPost's normal media upload for existing authorized music. [Music upload API](https://elevenlabs.io/docs/api-reference/music/upload)

**Phase 3 — narrated video export.** Compose an approved image/video layer, narration and optional music into a downloadable MP4 in a bounded worker job. This is deterministic media composition, separate from generative video. Pin the FFmpeg build, normalize loudness, reduce music volume while speech is active, and render readable Gujarati/Hindi/English captions from the approved script. Use actual approved brand assets. FFmpeg documents audio mixing, sidechain compression, loudness normalization and subtitles as filter capabilities; these require application assembly and visual/audio acceptance tests. [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html)

Acceptance: narration remains intelligible over music, facts and pronunciation pass language review, output duration matches intended content, no clipped audio or cropped captions, normal desktop download works, and project authorization is preserved. Pass the rendered MP4 through existing media inspection and platform validation before a separate publish action. An audio download must not be presented as a ready YouTube upload.

## Implementation verification — 17 September 2026

Implemented: brand-scoped ElevenLabs configuration, owner-only credential/settings writes, explicit allowed generation roles, model/voice discovery, MP3 generation into Library, protected downloads, optional post association, nine language/style skill presets with checksummed JSON import/export, network restrictions for credential mutations, and atomic database deduplication/daily budgets. A provider adapter interface keeps future audio APIs separate. Music composition and narrated-video rendering remain the phases above.

Verification: 8 audio API/adapter checks, 2 UI permission checks, and a real PostgreSQL concurrency test passed. Related authentication, runtime, configuration, media and route checks passed; all workspace packages typechecked and production container builds completed. Live credential verification used only model/voice metadata reads. The supplied values were rejected (one as an API key ID rather than a secret key), were not saved, and no paid generation was requested. Use the secret beginning with `sk_` in the owner settings screen. No real speech-quality, music or video generation acceptance is claimed.

## Security and operational limits

ElevenLabs authenticates API requests through `xi-api-key`. Keys can be restricted by endpoint scope, credit quota and IP allowlist. Never return the key from OriginPost read APIs, expose it in browser bundles or place it in a URL. [Authentication](https://elevenlabs.io/docs/api-reference/authentication)

For production, ElevenLabs recommends service-account keys where the account supports them; user keys depend on their user's membership. Public IPv4/IPv6 addresses and CIDRs are supported for key allowlists; private ranges are not. Therefore an ElevenLabs key allowlist contains the server's public outbound IP, not the admin's LAN address. [Workspace API keys](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys)

Keep provider pricing linked to the [current pricing page](https://elevenlabs.io/pricing/api), rather than promising a fixed number of free minutes. Display the chosen model and character count before generation. Enforce an application per-job cap, concurrency cap and request idempotency, in addition to provider credit limits. These are recommended OriginPost controls; no account-specific quota or paid request was verified in this research.

These security controls apply equally to narration, music, video and skills. Keep paid actions idempotent and separate credential management from permitted use. Do not store credentials in research notes, generated prompts, media metadata or Git. An HTTP 401 from a configured provider means authentication failed; it is not a successful live generation acceptance test. No credential value belongs in this document.
