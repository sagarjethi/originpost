# News-to-publication acceptance

Checked against the running local app on 15 September 2026. The workflow is
verified through a reviewed draft. A live published post is not yet verified.

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Simple README with diagrams and images | README contains the source-to-post diagram, template guide and 1440×1000 local-owner screenshot; no mobile screenshot | Complete |
| News collection and sections | BBC Gujarati, NASA feed/site, PIB, RBI and SEBI enabled at two-hour intervals; status API reports completed, healthy runs | Working for these configured sources |
| Recent and most-recent news | BBC section returned 2, 10 and 18 leads for 2 hours, 24 hours and 7 days; newest ordering, scope and original dates checked through API and desktop Chrome | Verified on actual collected records |
| Deduplication | Second BBC collection added zero leads and preserved firstSeenAt; official feeds also completed repeat scheduled runs with no new duplicates | Verified for these runs |
| Source verification | Discovered leads remain unverified/reference-only; the accepted image run used retrieved NASA evidence and a shared fact ledger | Verified for the acceptance package; each new story needs its own review |
| Codex image and project template | Real generated image uploaded through normal media/agent APIs, then composed with original logo and exact Gujarati text | Verified |
| Text and image checks | Current run remains ready; copy and image checks passed; separate reviewer reports retained privately; final image hash unchanged | Verified for the acceptance package |
| Chat publication handoff | @Publisher exposes the exact draft and available accounts; only mock accounts exist and no publishing targets exist | Implemented, live acceptance incomplete |
| Real publication and proof | OAuth status reports all apps unconfigured; no live account, approval or provider proof exists for the acceptance draft | Incomplete |
| GitHub delivery | main pushed through the collection and collector fixes; README and research records are tracked | Complete for delivered changes |

The accepted local run is
`agent_post_5a966cac2d159b83bf38d9517dc6c62b6ac6e230`. Its final image SHA-256 is
`0ca56727266270788cda916e0bed0855461ae5361a8d704ab46e0b2c8e575258`.
Private source text, draft images and reviewer records remain under the ignored
`data/codex-image-acceptance/` directory.

The source catalog does not establish exhaustive coverage of every news outlet.
Akashvani's script-dependent page remains disabled after visual inspection failed.
General @Codex routing, named multi-agent group chats and automatic cross-platform
package adaptations remain proposed in the master chat plan. The tested package
creates an Instagram draft; Facebook adaptations and YouTube video preparation
use the full content editor.

## What live publication still needs

The current deployment uses trusted-local `single-user` authentication, localhost
public URLs, mock connectors and `ALLOW_LIVE_PUBLISH=false`. Both Meta and Google
app credentials are absent. Clicking Connect alone cannot finish this setup.

1. Identify the active signed-in owner and the intended HTTPS app/API domains.
   Establish session authentication before enabling official publishing.
2. Configure the chosen Meta or Google application privately and register its
   exact callback URL. Complete the provider permissions for the owned account.
3. If retaining the personal Codex runtime in sessions mode, configure the exact
   owner/workspace IDs and create/test the runtime as that signed-in owner.
   The local bootstrap profile must not silently become another user's runtime.
4. Connect the live account, inspect the exact post, approve it, and execute a
   watched publication. Record the provider result and verify the live post.

See [social setup](../channels.md) and
[personal Codex ownership in sessions mode](../local-codex-bridge.md).
No authentication, credential, provider-audit or editorial-approval gate was
changed to manufacture a successful publication result.
