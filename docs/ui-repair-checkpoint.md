# UI repair checkpoint — 2026-09-15

The next crawler, viral-card, and one-click distribution expansion is deferred until the existing UI checkpoint is pushed. No new crawler or publishing shortcut is included in this pass.

## Repairs

- Shared text below 11px is raised to an 11px minimum across the existing stylesheets; form text, mobile input sizes, focus outlines, reduced motion, and primary touch targets are standardized.
- The global header shows the current module instead of a content search that has no effect there. Content search works on the content surfaces; Enter opens its results and Command/Ctrl-K opens and focuses Content search from another module.
- The hardcoded “Safe test mode / real publishing is switched off” label is replaced with a link to actual publishing-channel settings. The header distinguishes Connected, Offline, and Connecting.
- Save failures keep the add-content dialog and user input intact. Failed research after a successful save retains the server item and explains the partial result. No fake local success or demo record is manufactured.
- Add-content submission blocks duplicate clicks. Dialog and mobile navigation contain keyboard focus, close with Escape, restore focus, and lock background scrolling. Normal modified link clicks retain browser behavior.
- Research and Proof filter by their real research/source and published-proof records. Filtered detail panes do not show unrelated hidden items.
- Mobile headers retain an accessible, unclipped create action; Board task controls stack at narrow widths. A skip link is available on the application shell.

## Verification

The core and secondary workspace routes were navigated through the browser: Home, Content, Calendar, Engagement, Analytics, Boards, Library, Research, Signals, Reuse, Creative Studio, Batches, Proof, Automations, Organizations, Channels, Agent plugins, Developer API, Help, and Agent. Add-content focus/Escape behavior and mobile Content/Boards were checked at 390×844; desktop uses 1280×900. This checks existing interfaces; it does not claim that disconnected external services are live.

Repository-wide TypeScript checks, JavaScript/TypeScript test tasks, and builds passed. The web suite includes regression coverage for save failure, uncertain saves, partial research failure, and Research/Proof filtering. Environment-dependent tests remain skipped when their integration services are not supplied. The optional Hermes Python security suite requires its separately provisioned approved Hermes environment; the system Python lacks FastAPI.

## Next feature, after push

The requested next workflow is: select a project template or existing agent project, select a discovered story or paste news, produce the appropriate media and caption, review the destination-specific result, then submit one action to supported connected platforms. Reuse the existing approval, delivery, idempotency, and publication-receipt services. A static image does not satisfy a video destination; show the available format clearly.

Source discovery needs a project-scoped source catalog: publisher RSS/Atom feeds, official press-release sites, supported news/search APIs, and explicitly configured public websites browsed on the server. A user can add a source URL from a browser; the server needs its own access and cannot assume it has the user's browser session. Deduplicate stories, preserve source links and timestamps, show freshness and failed fetches, and let the user select a story for the existing creation flow. The source catalog and crawler are not implemented in this UI checkpoint.

At this checkpoint, the local repository has no Git remote configured. A repository URL is required before pushing. Local browser verification is not a production deployment receipt.
