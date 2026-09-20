# Publishing UX audit

Scope: application navigation, first-use home, installation settings, social authorization and publication handoff. Code and route audit, plus local loading/sign-in inspection. Authenticated visual walkthrough requires owner sign-in; live social publishing was not tested.

## Findings and fixes

| Finding | Change |
| --- | --- |
| Social connections buried under Studio & system | Social accounts in primary navigation; App setup visible to owners in footer |
| Nine primary tools mix core publishing and advanced operations | Seven everyday destinations; advanced tools grouped under More tools, which can now close on an active advanced page |
| Generic Connected badge appears to confirm social readiness | Workspace online explicitly describes app connectivity |
| First-use home says caught up and no action is due | Explain connecting accounts and creating a first draft |
| Installer opens on infrastructure fields | Open on app configuration; server addresses and optional fields secondary |
| Save connection implies OAuth completion | Save app settings, pending activation and next account step separated |
| Navigation can discard setup input | Unsaved-change protection; secret fields remain ephemeral |
| Instagram primary button targets an unavailable direct route | Choose an actually configured direct or Facebook-linked route consistently for badge and action |
| Missing provider setup produces a disabled dead end | Owner setup link; clear owner-required copy for other roles |
| Test accounts and messaging compete with real connections | Advanced/testing controls collapsed |
| Role lookup can use another workspace membership | Require exact current-workspace membership |
| X/Twitter implied by generic provider language | Explicit unsupported state; no fake key form or publish button |

## Actual publishing boundary

Instagram/Facebook and YouTube adapters exist. App credentials configure the integration; users must still authorize the specific account. YouTube needs a video and user OAuth, not an API key alone: [Google authorization](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps).

X/Twitter has no OriginPost OAuth/publishing adapter. Implement user authorization, credential lifecycle, media upload, approved-post delivery, retry safety and publication proof before enabling it. X's official sample uses user-context authorization: [X create-post sample](https://github.com/xdevplatform/samples/blob/main/python/posts/create_post.py).

The UI changes do not enable live publishing, grant new roles, connect social accounts, consume generation credits or remove approval gates. Production HTTPS, public media access and provider approval remain separate requirements.
