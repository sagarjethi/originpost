# Admin onboarding and social publishing requirements

Research date: 2026-09-20. This is an implementation acceptance checklist, not a claim that setup or publication has been completed. No credentials, paid generations or provider-account calls were used.

## Product decision

An administrator should install the server once, claim the installation, and configure service credentials inside OriginPost. Ordinary creators should only select a project and create drafts. Account authorization must happen on the social provider's login page; OriginPost must never collect social-account passwords.

Application settings can move out of environment variables. The installer still needs infrastructure before a web page can run: database connectivity, storage and an encryption root. Generate these automatically into a protected persistent secret mount or managed secret store. Do not store the sole decryption root beside encrypted database records, expose it in browser state, or promise recovery after losing both secrets and backups. This paragraph is an architectural recommendation.

## Configuration fields and provider distinctions

| Connection | Admin enters once | User connects per project | Publishing baseline |
| --- | --- | --- | --- |
| Instagram directly | Instagram App ID and Instagram App Secret from Instagram API setup | Professional Instagram account through Instagram login | `instagram_business_basic`, `instagram_business_content_publish` |
| Instagram through Facebook | Meta/Facebook App ID and App Secret | Facebook login, then linked Page and professional Instagram account | `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` |
| Facebook Page | Meta/Facebook App ID and App Secret | Facebook login, then permitted Page | Page discovery and publication permissions; validate the Page's create-content task |
| YouTube | Google OAuth web-client ID and secret; enable YouTube Data API | Google consent and channel identity confirmation | `youtube.upload`; add channel-read scope if the channel selector requires it |

Direct Instagram login does not require a linked Facebook Page. Its scopes differ from the Facebook login family; obsolete `business_*` names must not be used. Comments and messaging are separate permissions. [Meta's official Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login).

The Facebook route requires a professional Instagram account linked to a Page. The collection lists read, publish and comment scopes together; OriginPost should request comment access only for enabled comment features. Meta documents Stories as business-account-only for this route. [Meta's official Facebook Login collection](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00).

Postiz confirms that the two Instagram routes use different credential fields even when housed in one Meta app: its standalone route uses credentials from Instagram API setup, while its Facebook route uses the main App ID/Secret. Its documentation also separates tester-role setup from approved advanced permissions. OriginPost should offer the same distinction inside its admin UI instead of reproducing Postiz's environment-file steps. [Postiz Instagram setup](https://docs.postiz.com/self-host/providers/instagram).

For Facebook, Postiz's full-feature setup requests `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`, `business_management` and `read_insights`. Treat that as its full feature bundle, not proof every permission is needed for a basic photo post. OriginPost should separate publishing, engagement and analytics capabilities and verify each supported endpoint. [Postiz Facebook setup](https://docs.postiz.com/self-host/providers/facebook). Direct Meta Pages documentation returned HTTP 429 during this research, so a narrower endpoint-specific Facebook scope claim is intentionally not presented as newly verified.

## Callbacks and launch readiness

Generate copy buttons for these existing API routes using the validated public API origin (and deployed prefix):

- `/v1/channels/oauth/instagram/callback`
- `/v1/channels/oauth/instagram-facebook/callback`
- `/v1/channels/oauth/facebook/callback`
- `/v1/channels/oauth/youtube/callback`

These paths are from `apps/api/src/channels/channel-oauth.controller.ts`, not Postiz's routes. Production should require a stable HTTPS domain. The displayed URL must match actual proxy routing and the provider's registered callback exactly. Google's documented comparison includes scheme, case and trailing slash. Use server-side code exchange, session-bound unpredictable state, and offline access where background publishing requires refresh tokens. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Never equate a saved client secret with public publishing readiness. The UI must show separate states: **Not configured → App configured → Account connected → Ready**, with **Test access**, **Reconnect required** or a concrete blocking reason where appropriate. External Google OAuth apps in Testing receive refresh tokens with a seven-day lifetime for these scopes. Request optional access incrementally. [Google OAuth overview](https://developers.google.com/identity/protocols/oauth2).

YouTube accepts video uploads, not image-plus-caption posts. The upload endpoint supports `youtube.upload`, privacy selection, scheduled publication, made-for-kids and synthetic-media metadata. Videos uploaded by unverified API projects created after 2020-07-28 remain private until the required audit is passed. OAuth consent verification and this upload audit must be represented separately. Do not hardcode old quota figures into onboarding. [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert).

## UX reference to adopt

Buffer's flow starts at Channels, distinguishes personal from professional Instagram, offers direct Instagram versus Facebook-linked authorization, and provides reconnection help. A personal username supports notification/manual publishing, not automatic publishing. Adopt the explicit account-type and connection-choice guidance, followed by confirmation of the actual account and project; never silently connect whichever browser account happens to be active. [Buffer connection guide](https://support.buffer.com/en-us/articles/connecting-your-instagram-account-to-buffer-n9Ad6veXsu).

Use short labels: **Create admin account**, **Set up services**, **Create project**, **Connect accounts**, **Check setup**. Keep developer instructions behind **Setup guide**. Show a single next action for each missing prerequisite. Let optional voice, analytics and messaging be skipped without blocking basic draft creation.

## Acceptance checklist

- [ ] First-run claim is protected against an arbitrary internet visitor becoming owner; only one owner claim can win concurrent requests; setup endpoints close after completion.
- [ ] Separate user sessions work before sharing. Creator cannot read/change service credentials, authorize channels, approve, queue or publish through any API. Define the publishing role explicitly.
- [ ] Owner-only settings encrypt credentials, return presence metadata rather than secret values, support replace/remove, redact errors and audit changes without secret content.
- [ ] Saved provider settings reach API and workers consistently after restart, with a versioned credential reference so an in-flight OAuth callback cannot use a different app's secret.
- [ ] Setup separates local validation from provider verification; it never labels a key valid merely because its format is plausible.
- [ ] Connect and reconnect preserve project ownership, granted permissions and expiry; a missing optional permission disables only that feature.
- [ ] Publication checks account identity, content format, accessible media, approval, permissions, provider processing and retry safety. Completion shows provider post ID/link and actual visibility.
- [ ] Image, Reel and Story options are enabled only for the selected connector's tested capabilities; YouTube requires a rendered video. A reference image is not automatically a publishable asset.
- [ ] Agent names dispatch real server work and show progress/error/retry; saved project references, exact-logo placement, source review and caption review remain attached to the draft.
- [ ] A complete new-install browser test reaches a draft and mocked publishing proof without editing an environment file. Test live publishing separately with the owner's reviewed account and an explicitly approved post.

Current code inspection found Facebook consent always includes engagement access and YouTube consent bundles upload, readonly, force-ssl and analytics. Reducing those bundles requires updating consent generation, granted-scope validation and feature capability checks together; changing UI labels alone is insufficient. See `apps/api/src/channels/channel-oauth.service.ts`.
