# Audio and project connections

## Connect social accounts to one project

OriginPost uses a **brand** as the shared scope for publishing accounts, posts, media, and audio providers. Select the project's brand in the workspace switcher, open **Channels**, and connect Instagram, Facebook Pages, and YouTube. Pick the specific Page/channel during OAuth. A workspace owner must make these connections; managers and creators cannot change credentials. Select the connected accounts as publishing destinations when reviewing a post.

The server operator first configures the Meta and Google applications, encryption key, HTTPS public URLs, redirect URIs and provider modes. Follow [Channels](channels.md) for exact environment variables and callbacks. Use session authentication (`AUTH_MODE=sessions`) for a shared installation. Single-user mode gives every local visitor owner access and is suitable only for a trusted local machine. A connected account still needs the provider's required permissions and any applicable App Review. Do not enter social account passwords into OriginPost.

## Start with ElevenLabs

1. Open **Audio → Connect provider** as the workspace owner.
2. Paste the secret ElevenLabs API key starting with `sk_` (not its key ID), with only the permissions needed for model discovery, voice discovery and speech generation. Set its credit quota in ElevenLabs. Use a provider-side public egress-IP restriction where appropriate.
3. Choose an explicit model ID. `eleven_v3` supports Gujarati, Hindi and English; availability still depends on the account. OriginPost checks `/v1/models` before generation and will not silently substitute another model.
4. Choose who may generate: owner, manager and/or creator. The default is owner only. Set a character limit and a daily request limit, then save. Keys are encrypted with the server's `CREDENTIAL_ENCRYPTION_KEY`; API responses never contain them.
5. Click **Load voices & check connection**. Select a voice and a supported language. Additional voice pages can be loaded explicitly.
6. Choose writing guidance or use your own script. Review the exact text, confirm voice/script usage rights, optionally select a post, and generate.
7. Listen to the result, download the MP3, or reuse it from **Library**. A selected post is recorded as the asset's content association; this does not edit an approved draft or automatically mix audio into a video. Instagram and YouTube require a suitable video for narrated posts.

Narration carries AI provenance and a script hash. The run ledger stores hashes, character counts, model, voice, language, skill version, actor, status and output ID; it does not store the script, API key or provider error body. The provider receives the script for generation. Save the reviewed script in the post if you need to retain it.

## Access and keys

| Action | Owner | Manager / creator | Viewer |
|---|---|---|---|
| Connect, replace key, disable, change limits or skills | Yes | No | No |
| View provider metadata and run history | Yes | Yes | Yes |
| Generate | Only if enabled in allowed roles | Only if explicitly enabled | No |
| Read raw provider key | No API route | No | No |
| Read brand media | Workspace permission | Workspace permission | Workspace permission |

There is no extra “superuser” credential-read endpoint. Database-only access exposes encrypted provider credentials. A server operator who controls both the application encryption key and database can decrypt them; use deployment isolation and a secret manager to separate that authority. Workspace membership is the existing authorization boundary; brands separate project data within a workspace, not memberships. Use separate workspaces for teams that must not read each other's projects.

`ADMIN_ALLOWED_IPS` optionally restricts credential-changing requests for Channels, Agent runtimes and Audio profiles. It accepts comma-separated exact IPs or CIDR ranges. Empty means no additional IP restriction. It uses the actual API peer IP and ignores untrusted forwarded headers. Behind Next.js or another reverse proxy the peer is the proxy: enforce original-client IP policy at the trusted ingress as well. This is distinct from ElevenLabs' public egress-IP allowlist. Configure this server-side, then restart the API; it is not editable through the dashboard.

## Skills and efficient generation

Nine starter skills cover news-reader, weather-reader and conversational-explainer writing in Gujarati, Hindi and English, with short guidance and character limits. These guide the reviewed script; selecting one does not secretly change voice settings or add background music. The owner can download and import a checksummed JSON pack, review instructions, then save them for the brand. Other languages use the same format and must be supported by the configured model. Increment a skill's semantic version when changing its content. Imports accept declarative fields only, with count/length bounds; no shell commands, external URL fetches or executable plugin installation run during import. A checksum detects edits; it does not establish a publisher's trustworthiness.

The pack format is `{schemaVersion: 1, skills: [...], sha256: "..."}`. Each skill has `id`, `version`, `name`, `language` (ISO code), `instructions`, and `maxCharacters`. Compute SHA-256 over UTF-8 `JSON.stringify({schemaVersion:1,skills})`. Export from the settings screen for a working example. Imported guidance is displayed for review; it is not silently appended to speech or used to rewrite facts. A prompt author can propose a compact skill and a separate local-language reviewer can approve it before the owner imports it.

Speech generation makes one TTS call using only the reviewed script. It does not send chat history or all installed skills, call a second model to rewrite the script, or switch providers. A durable request key deduplicates repeat submissions, including concurrent requests across API processes. The database serializes daily budget reservations. The limit counts attempted generations in UTC, including failures; a failed or interrupted call may have incurred provider charges. The UI keeps the same key for an unchanged request in its mounted session. A reload/new session can create a new key, so check existing recordings before submitting again.

## Architecture and limits

`AudioProvider` defines model discovery, paginated voice discovery and synthesis. `AudioProviders` currently registers ElevenLabs only. Add future providers as explicit adapters with capability mapping, endpoint restrictions and contract tests; a random API key or URL does not make an unsupported provider compatible. Text/research runtimes, image generation, TTS and social publishing remain separate interfaces. ElevenAgents realtime conversations and voice cloning are separate capabilities and are not enabled here. Voice cloning requires explicit rights and consent before any future implementation.

Profiles and runs have PostgreSQL and in-memory repository implementations. PostgreSQL uses optimistic profile versions, a unique workspace/request identity and row locks for budgets. Generation is synchronous with a 90-second provider timeout and a 20 MB output limit. An interrupted run remains `generating` for operator investigation; there is no automatic paid retry. This conservative first adapter does not include a distributed worker/reconciliation service, video/audio mixing, arbitrary plugin execution, or live voice cloning. Generated MP3s use the existing media store, malware gate, protected downloads and synthetic provenance.

Run `pnpm db:migrate` before starting the new API. Existing installations gain no provider key or permission automatically. See [primary-source research and rollout plan](research/2026-09-17-audio-providers.md).

## Post-to-voice workflow

Generated news posts expose **Create voice**, a compact editable script bubble beside the copy. **Choose a voice** opens Audio with the original news item and project profile. The URL carries identifiers only; the edited script uses a user/workspace/brand/run-scoped session-storage handoff that expires after 15 minutes and is removed when consumed. If storage is unavailable, Audio recovers persisted post copy. A mismatched workspace or brand is rejected rather than silently reassigned.

Audio shows the originating news headline, profile and date. Recordings can be filtered by project board, project profile and local calendar date; results are grouped by date and link back to the news item. New runs retain their project template ID even if the provider's default profile changes. Downloads reuse the existing protected media route.

Project profiles now store bounded, versioned Gujarati/Hindi/English language guidance. Both post writer and independent copy reviewer receive only matching locale skills. Narration drafting uses the same selected project profile with up to 12 supported claims and eight associated sources. The evidence packet is limited to 16,000 characters. It does not include the logo or provider credentials. Imported skills remain declarative guidance; they grant no tools or permissions.

**Draft script from this post** invokes the configured text runtime once; it does not synthesize speech. The editor reviews the script and separately selects **Generate narration**. The harness is intentionally explicit: scoped evidence → selected language guidance → editable draft → rights/review check → idempotent synthesis → protected media and linked run. It never switches providers or retries paid synthesis automatically.

Provider configuration lives in an owner-only dialog with shared collapsible form sections. New UI connections default to 100 characters per request and two requests per UTC day. Short-sample mode is also checked by the API before usage reservation. For this acceptance run, allow at most two samples total: one Gujarati and one Hindi, each no more than 100 characters. Read-only authentication/model discovery and mocked tests come first. A valid ElevenLabs secret is required for live testing; a key ID is not sufficient.

### Security and review

Server authorization validates the workspace, brand, content item and project template independently of the browser. Provider secrets remain encrypted and absent from script packets, URLs and client responses. Text drafts require editor review; a successful model call is not a factual or pronunciation approval. Secret scans and repository hooks remain mandatory before commit and push. No script, key or private screenshot belongs in Git.

### Review hardening

Script drafting has its own owner-configured daily quota (`dailyDraftRequests`, default 10) and durable replay ledger, separate from voice requests. Identical retries return the saved draft; concurrent and failed attempts count toward quota and never automatically retry. Migration 073 creates this ledger. The bounded generated script is stored privately for replay; source packets and credentials are not copied into it.

Changing the selected news item resets its script, profile context, language and review state. The composer is disabled during an active request so a late draft cannot overwrite another story. Audio uses container-based layout changes: two columns when space permits and stacked panels in narrower workspace columns. No separate mobile product view is introduced.

Both API and web TypeScript checks now reject unused locals and parameters. Existing commit/push secret hooks and the Verify CI workflow remain enabled; CI runs release, dependency, secret and test checks.

### Spoken scripts and connection settings

Voice handoffs clean the saved social caption before editing: URLs, hashtag-only footers, and empty link/source labels are omitted. Inline hashtag words and textual source attribution are preserved to avoid removing facts. Linked prose stays readable, and attribution within sentences, names, numbers, and uncertainty remain. The text-model instructions request short spoken sentences without publishing metadata, stage directions, or music cues. The same shared cleanup runs before saving generated scripts and before speech synthesis; quotas and request hashes use the cleaned narration. Empty cleaned scripts are rejected without a voice request.

The connection dialog keeps its header and save controls visible while advanced settings scroll. Workspace settings now link directly to Channels and Audio for the selected brand. Social publishing still uses the existing owner-only OAuth flow and draft approval; entering an Instagram handle alone cannot grant publishing access. See [Channels](channels.md) for operator setup and live-publishing requirements.
