# Reusable project language profiles

17 September 2026. This note combines existing OriginPost architecture and the installed Gujarati creation skill. Recommendations are distinguished from existing behavior; no paid generation or credential access was performed.

## Reuse the existing project template

OriginPost already documents workspace/brand-scoped templates containing language, writing preset, caption example, original logo, up to three style references and placement rules. Each run freezes its template and asset hashes. Board association organizes templates without inheriting Board skills or memory. Extend that profile instead of introducing a second global source of brand defaults. [Current chat workflow](../agent-chat-ui.md), [master architecture](../master-agent-chat.md)

Recommended saved fields: preferred locale (`gu`, `hi`, `en`, with other supported locales available), audience/region, short house-writing rules, reader preset, approved example, preferred terminology, voice/model defaults, and enabled skill references with pinned revisions. Keep one-off news facts in each run, not in the permanent profile. A past example teaches tone; its names and numbers never become facts for a new story.

Store original-logo and style-reference media IDs, their versions/hashes, and existing placement/crop rules. Reuse validated bytes through the current deterministic composition path; never redraw the logo with an image model. Keep each publisher's brand separate. Publisher-specific asset rules belong to its brand profile, not every OriginPost installation. [Creative Studio](../creative-studio.md)

## Language rules and the locked ledger

The installed creator skill requires a verified fact packet before drafting and a shared pre-layer lock file for the author and reviewer. Its Gujarati language reference favors everyday spoken-standard Gujarati, one idea per line, natural grammar and limited necessary English. Preserve official names and useful familiar acronyms, translate avoidable jargon, keep numbers with units, and read aloud before accepting copy. Local primary sources: the locally installed `create-gujarati-news-posts` skill and its `references/gujarati-language-and-code-mix.md`. Local skills are research inputs, not portable production dependencies; any shipped rule pack needs its own reviewed, versioned repository copy.

The shared ledger should hold:

| Locked field | Rule |
|---|---|
| Names and places | Preserve the verified source form and approved locale spelling. |
| Dates, times and time zone | Preserve the exact event window; do not turn an old update into current news. |
| Numbers, units and comparisons | Keep quantity, denominator, geography and period together. |
| Quotes and attribution | Distinguish verbatim quotation from paraphrase; retain speaker/source. |
| Official and preferred local terms | Use approved spellings consistently; explain unfamiliar terms briefly. |
| Uncertainty and forbidden claims | Keep forecasts, allegations and unverified terms visibly qualified. |

A reviewer may improve grammar around a locked item but cannot silently change it. Corrections to the ledger require a new evidence-bound version and rerun of affected review.

For Hindi and English, share the fact-preservation contract but maintain independently reviewed locale writing rules. Proposed baseline: simple natural Hindi in Devanagari and plain English, short active sentences, consistent number style, preserved official names and no sensational inference. Do not claim the Gujarati rule pack establishes Hindi linguistic quality. Normalize text consistently, but do not blindly delete script-shaping characters from every language; validate the rendered text and spoken result.

## Reader presets and selected context

Use three editorial presets: **News reader** for measured factual delivery, **Weather reader** for clearly separated place/time/temperature/forecast qualification, and **Explainer** for one idea per short sentence. These are product presets, not provider API model names. Save the chosen preset so the user need only paste a new link or facts next time.

For an authoring call, assemble only the selected locale rules, reader preset, compact brand tone, current verified ledger and requested output format. For TTS, use the approved narration and supported voice controls; do not send the logo, full source archive, unrelated skills or entire chat. Send visual rules and logo reference only to the visual/composition path. Existing text and image review remain separate. [Existing review boundaries](../agent-chat-ui.md)

Eleven v3 documents Gujarati, Hindi and English support. Use model capability checks rather than assuming every configured voice model supports all three languages. Model support is not pronunciation acceptance. [ElevenLabs models](https://elevenlabs.io/docs/overview/models)

Measure selected-context length, provider-reported input/output tokens where available, narration character count and reused assets. Avoid numerical savings claims until comparable runs exist. An approved script should go straight to synthesis rather than invoke several prompt agents on every click. Skill authors and language reviewers can improve a versioned pack separately from routine generation.

## Author and reviewer separation

The creator skill calls for independent fact, language and visual checks. OriginPost already runs a separate copy-review session over frozen evidence and finished copy; this may use the same configured model, so it is a separate pass rather than independent reporting. Preserve that honest distinction. Give the reviewer the same locked ledger and exact candidate; do not substitute the author's self-assessment for review. [implemented copy review](../agent-chat-ui.md)

Skill generation should produce a proposed version, a concise diff and two fixtures. Enable the approved version per project; do not let a generated or downloaded skill grant itself tools, publish permissions, cross-project memory or secret access. Runtime requests must resolve the saved profile server-side and reject stale or cross-brand references.

## Cost-conscious two-sample acceptance

For this requested acceptance run, allow **at most two synthesis calls total: one Gujarati and one Hindi**, each at most **100 characters**. These are the user's explicit limits. Do not repeat automatically after changing a model or voice. Use the fictional greeting fixtures in `packages/domain/src/language-skills.ts` to avoid invented current news.

Validate scripts without paid calls first. Check configuration using read-only model/voice discovery. Keep request IDs and reuse completed audio for playback and review. Authentication failures do not count as successful generation. Never automatically retry an uncertain synthesis call.

Record pass/fail per sample with pronunciation notes and a human listening decision. These two samples are a bounded product acceptance check, not proof of every accent, longer script or language. End-to-end release still requires the existing source, copy, asset and publishing checks.
