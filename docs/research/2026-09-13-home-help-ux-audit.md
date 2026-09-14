# OriginPost Home and Help UX audit

Date: 2026-09-13  
Scope: authenticated OriginPost web experience at `http://127.0.0.1:3000/`, with emphasis on Home, global information architecture, and Help.  
Method: principal-level heuristic review of the running desktop UI and the current product/code contracts. This is an expert audit, not a substitute for usability testing with OriginPost users.

## Executive decision

OriginPost should stop treating Home as the place where the whole product runs. Home should be a compact **today dashboard** that answers, in order:

1. **What is OriginPost?** “Turn a note, link, file, or signal into a verified, approved social post with publish proof.”
2. **What should I do now?** Show one prioritized next action and a short, ranked work queue.
3. **Where does everything live?** Use a small, task-based primary navigation and move setup/advanced tools into Settings.

The full Content Item inspector, Content Studio, scheduling controls, first-comment workflow, and workspace tools should not be rendered below Home. They belong on dedicated, deep-linkable pages. Help should be a persistent global destination with task-oriented journey guides, including an honest “Create an image with ChatGPT” guide that only presents the flow as available when the corresponding generation capability exists.

This is a structural redesign, not a spacing exercise. The current composition creates excessive document length because it combines several complete workspaces in one route.

## Evidence from the current product

### Current strengths to preserve

- The product promise is strong and concise: a source can become researched, approved content with a permanent evidence trail. The six-stage model—Find, Verify, Create, Approve, Publish, Prove—is a good mental model and should remain the backbone of both navigation and Help ([product brief](../product-brief.md)).
- The current Home hero already exposes operational states (“Needs review”, “Needs action”, “Scheduled”, “Published”) and gives safe-mode visibility. Those are valuable trust signals.
- A selected Content Item already has a useful six-step progress indicator and a contextual next action.
- Board is correctly defined as a top-level product area while Hermes memory/skills are internal to an opened Board ([Boards contract](../boards.md)). The IA must preserve that boundary.

### Critical usability problems

| Finding | Evidence | User impact | Severity |
|---|---|---|---|
| Home is multiple products stacked vertically | The Home branch renders hero/metrics, the complete pipeline and item detail, then `ContentStudio`, YouTube review, first-comment controls, and workspace tools in one document ([`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx)). | Users must scroll through unrelated work and lose their place. Home does not feel like an overview. | Critical |
| Primary navigation is too broad and mixes destinations with actions and filters | The sidebar exposes 19 items. `Create` opens a modal; `Inbox`, `Research`, and `Proof` are Home/filter states; other entries are full modules. | Users cannot form a stable rule for what a nav item does. Similar-looking items have different interaction models. | Critical |
| Several navigation labels do not produce distinct information spaces | `Inbox`, `Research`, and `Proof` clear to the same Home content/filter branch; “Research” also shows a hard-coded count of 3. | The label promises a page that does not exist, so confidence and wayfinding erode. | High |
| Home scales directly with the content inventory | `visible.map(...)` renders every matching non-archived Content Item, and `.content-list` has no page-size or viewport-height boundary. The audited workspace exposed roughly forty rows before the complete Content Studio. | Page length worsens as the user succeeds and accumulates content. | Critical |
| Selected-item work is split across distant regions | Summary and “Open Content Studio” are in the right panel, while the editor appears farther down the page and the action scrolls to an anchor. | The user must remember context across a long jump and then navigate back manually. | High |
| “Connected tools and settings” appears at the end of day-to-day Home | Plugin and organization setup cards are appended after operational work. | Administrative concepts compete with today’s publishing decisions. | Medium |
| There is no global Help destination | Settings is disabled and no Help item is present. Repository help is implementation documentation, not an in-product task guide. | New and interrupted users cannot answer “how do I complete this?” in context. | High |
| Routing is largely view state, not product location | `activeNav` and `activeModule` drive most authenticated views; only some modules use a query parameter. | Refresh, back/forward, sharing a location, and returning to a work item are inconsistent. | High |
| Compact desktop typography and controls are close to accessibility minimums | Several tabs/status labels use 7–10 px text and small padded hit areas in `globals.css`. The accessibility tree also presents many pressed buttons as checkbox-like controls. | Scanability, touch accuracy, and semantic predictability suffer, especially under zoom or motor/cognitive load. | High |

The scale problem was visible at 1280×720: the first viewport contained the dashboard and only the beginning of the content/detail pair, while the accessibility tree continued through hundreds of nodes into the full editor and workspace tools.

## Design principles for this redesign

1. **Home prioritizes; destination pages execute.** A dashboard should point to work, not contain every work surface.
2. **One page, one primary job.** Content list finds work; Content Item advances one item; Calendar plans time; Help teaches a task.
3. **Navigation follows user tasks, not implementation modules.** Research on task-oriented IA finds it easier to learn and warns that too many overlapping top-level choices make selection harder. In a study of 77 information architectures, the median was seven top-level categories ([NN/g, Intranet IA Trends](https://www.nngroup.com/articles/intranet-information-architecture-ia/)).
4. **Progressive disclosure protects power without sacrificing simplicity.** Put advanced or infrequent options on secondary screens and reveal them when requested ([NN/g, Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)).
5. **Prefer recognition over recall.** Show the next action and relevant context together; do not ask users to remember an item while scrolling to another workspace ([NN/g, Ten Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)).
6. **Complex-product UX must model the work, not merely reduce visible controls.** OriginPost supports nonlinear, high-impact, multi-role work; information must be organized around that domain workflow ([NN/g, UX Strategies for Complex-Application Design](https://www.nngroup.com/articles/strategies-complex-application-design/)).
7. **Help is both contextual and searchable.** Concise proactive help should appear at the moment of need, backed by reactive task guides ([NN/g, Help and Documentation](https://www.nngroup.com/articles/help-and-documentation/)).
8. **Truthful capability states are part of UX.** Planned, setup-required, unavailable, test, and ready are visibly different. Help never instructs users to use a capability that the UI/runtime cannot provide.

## Proposed information architecture

### Desktop global navigation

Keep no more than seven primary destinations visible. “New content” remains a persistent action in the top bar; it is not navigation.

| Primary destination | What belongs there | Current items absorbed |
|---|---|---|
| **Home** | Today summary, one best next action, short queue, recent work | Home |
| **Boards** | Board list; within a Board: Tasks, Work, Activity, then Board Settings for internal memory/skills | Boards; Hermes remains internal |
| **Content** | Searchable content index and saved views | Inbox, Research, Create workflow, Batches, Proof, relevant Reuse entry points |
| **Calendar** | Scheduled work, grid planning, queue timing | Calendar |
| **Engagement** | Comments and private conversations | Engagement |
| **Insights** | Performance, learning, evergreen opportunities | Analytics, Reuse summary |
| **Library** | Source/evidence/creative media and Creative Studio entry points | Library, Creative Studio |

Persistent utilities at the bottom of the sidebar:

- **Help** — global, always in the same relative location.
- **Settings** — a real destination with Organization, Brands, Channels, Automations, Integrations, and Developer API.
- User/workspace switcher and safe-mode status.

“Signals” can initially be a clearly labeled saved view under Content (“Discovered signals”) and linked from Home. If later evidence shows discovery is a dominant daily job, test it as an eighth primary destination; do not assume that now.

### Route model

Use real, deep-linkable locations so browser navigation, reload, sharing, and notifications work predictably:

```text
/home
/boards
/boards/:boardId/tasks
/boards/:boardId/work
/boards/:boardId/activity
/boards/:boardId/settings        # internal plugin status, memory, skills

/content?view=inbox|research|review|approved|published|signals
/content/:contentItemId/overview
/content/:contentItemId/evidence
/content/:contentItemId/create
/content/:contentItemId/review
/content/:contentItemId/publish
/content/:contentItemId/proof

/calendar
/engagement
/insights
/library

/settings/organization
/settings/channels
/settings/automations
/settings/integrations
/settings/developer

/help
/help/journeys/:slug
/help/concepts/:slug
/help/troubleshooting/:slug
```

These may be implemented incrementally behind the existing app shell, but the visible URL and back/forward behavior should be correct from the first migrated slice.

### Content architecture

The Content index owns search, filters, saved views, pagination/virtualization, and bulk mode. Selecting a row opens a dedicated Content Item route rather than expanding the entire production suite below the list.

The Content Item route keeps the six-stage model visible and uses local tabs/steps:

1. Overview
2. Evidence
3. Create
4. Review
5. Publish
6. Proof

Each tab shows one primary action. The item header, status, selected revision, unsaved state, and next-step CTA remain visible. On desktop, a bounded inspector can coexist with the current tab; on mobile, list and detail are sequential screens with a visible Back to content action.

## Home redesign

### Content hierarchy

Returning-user Home should contain only four product-content regions:

1. **Purpose + context** — active brand, one-sentence promise, safe/live state.
2. **Next up** — the highest-priority actionable item with one explicit CTA.
3. **Today** — compact counts for Needs attention, Needs review, Scheduled today, and Published today; each opens the matching destination.
4. **Work queue** — at most five ranked items plus “View all content”. Optional recent activity is a compact secondary list, not another full workspace.

First-run Home may replace the work queue with a dismissible/collapsible setup path. Once meaningful content exists, “How OriginPost works” moves to Help and is available from a small “See the workflow” link; it should not occupy every return visit.

### Priority model for “Next up”

Use a deterministic, explainable ordering:

1. Uncertain publish result or failed item that risks duplication/data loss.
2. Manual publish handoff overdue or due now.
3. Review waiting on the current user.
4. Scheduled item requiring a prerequisite within 24 hours.
5. Research/source problem blocking a draft.
6. Most recently updated normal work.

Show why it is first (“Manual Facebook handoff was due 3h ago”) and where the CTA goes (“Complete handoff”). Do not merely label it “Continue”.

### Desktop wireframe (1280×720 target)

```text
┌───────────────┬──────────────────────────────────────────────────────────────┐
│ OriginPost    │ Search…                Safe test     Help   + New content   │
│ Workspace     ├──────────────────────────────────────────────────────────────┤
│ Brand         │ Good morning, Sagar                MAIN BRAND · TEST MODE   │
│               │ Turn a source into a verified post with publish proof.      │
│ Home          ├──────────────────────────────┬───────────────────────────────┤
│ Boards        │ NEXT UP                      │ TODAY                         │
│ Content       │ Manual FB handoff is overdue │ Attention 4 · Review 3       │
│ Calendar      │ [Complete handoff]           │ Scheduled 8 · Published 2    │
│ Engagement    ├──────────────────────────────┴───────────────────────────────┤
│ Insights      │ YOUR QUEUE                                      View all → │
│ Library       │ 1  Queue duplicate second     Action required     Open →   │
│               │ 2  Sensitive launch           Needs approval      Review → │
│               │ 3  Mumbai event update        Needs sources       Research→│
│               │ 4  Mumbai story               Scheduled 10:30     View →   │
│ Help          │ 5  Field image                 Drafting             Open →   │
│ Settings      │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Desktop Home should not include a selected-item detail panel, full editor, provider scheduler, first-comment composer, or settings cards. Those are one click away at stable locations.

### Mobile model

- Keep four frequent destinations visible in a bottom bar: Home, Content, Boards, Calendar. Put Engagement, Insights, Library, Settings, and Help in “More”; also expose Help consistently at the top of that sheet.
- Keep “New content” as a distinct action, not one of the destinations.
- First viewport: purpose line, next action, and status summary.
- Queue: maximum five cards; each card has one primary action and the whole card is not overloaded with nested controls.
- Content list → Content detail is route-based. Do not put a full inspector under every list.
- Never require horizontal scrolling for filters or stage navigation at 320 CSS px. Use a compact section menu/step selector where six tabs do not fit.

## Help area

### Help landing-page hierarchy

```text
Help
├── Search help (“How do I publish an Instagram Story?”)
├── Start here
│   ├── What OriginPost does
│   ├── Six-stage Source → Proof workflow
│   └── Safe mode vs live publishing
├── Common journeys
├── Concepts
│   ├── Workspace, Brand, Board, Content Item
│   ├── Draft revision, approval, target, proof
│   └── Agent plugin vs Board-internal intelligence
├── Feature guides
├── Safety and publishing
└── Troubleshooting
```

Every guide uses the same compact template:

- Outcome (“At the end, you will have…”)
- Before you start (role, connected account, rights, feature readiness)
- 4–8 numbered steps with exact UI labels
- “What happens next”
- Safety/proof note where relevant
- Common blockers and direct recovery links
- Related journeys

Help search should return guides by task wording and synonyms, not only internal nouns. Example: “post later” finds scheduling; “make AI image” finds ChatGPT image creation; “where did it publish?” finds Proof.

### Required journey guides

Ship these in priority order:

1. **From an idea or link to a published post** — the canonical six-stage journey.
2. **Review what needs my attention today** — Home → filtered Content → next action.
3. **Create an image with ChatGPT** — generation, disclosure, review, and attachment flow described below.
4. **Turn a discovered signal into content** — Signals → promote → Evidence.
5. **Verify sources and claims** — Evidence rules and uncertainty.
6. **Ask a teammate or client to review an exact revision** — share link, feedback, immutable revision.
7. **Schedule or manually hand off a post** — what OriginPost does and what the person does.
8. **Recover a failed or uncertain publish** — check provider first; prevent duplicate posts; save proof.
9. **Plan and run work inside a Board** — Tasks/Work, and why memory/skills stay inside that Board.
10. **Reuse successful content safely** — age, rights, facts, and new approval.
11. **Connect and diagnose a publishing channel** — Settings → Channels.
12. **Find and export publish proof** — Content → Published → Proof.

### “Create an image with ChatGPT” journey

The current product contract says Creative Studio performs deterministic composition from a rights-cleared Library image and explicitly lists synthetic image generation as a future module ([Creative Studio contract](../creative-studio.md)). Therefore, Help must not claim that ChatGPT generation is available until the product exposes and verifies it. The guide and UI need a capability badge: **Available**, **Setup required**, or **Planned**.

When implemented, the journey should be:

```text
Content Item
  → Create
  → Create visual
  → Generate with ChatGPT
  → Describe the visual + choose format
  → Generate visual-only candidates
  → Review authenticity, rights, and AI disclosure
  → Add exact text/brand treatment in deterministic composition when needed
  → Save generated asset + prompt/model/hash lineage to Library
  → Attach as a new immutable draft revision
  → Human review
  → Schedule/publish
  → Store publish proof
```

UX requirements for this flow:

- Generate a visual layer, not fake documentary evidence. Editorial/current-event flows must explain that a synthetic scene cannot prove an incident.
- Show generation state and expected waiting behavior; allow users to leave and return without losing the job.
- Save provider/model, prompt hash, generation timestamp, source references, user edits, disclosure choice, and resulting asset hash as lineage. Do not expose hidden credentials.
- Make “Try another” create a separate candidate, never overwrite an approved asset.
- Require alt text before attachment and expose crop-safe previews for each target format.
- If exact Gujarati or other brand text matters, recommend visual-only generation followed by deterministic text/logo composition rather than asking the image model to render final copy.
- The review screen must visibly label materially AI-generated/edited media and carry the disclosure into the publish workflow.
- Use clear failure recovery: provider unavailable, safety refusal, generation timeout, and unsupported format each have a next step.

### Help visual system

Use two complementary types of visual:

1. **UI-native journey diagrams** (HTML/SVG) are the primary instructional source. They are responsive, localizable, keyboard/screen-reader compatible, and can indicate the user’s current step.
2. **ChatGPT-generated illustrations** can make Help welcoming, but must be decorative or supplementary. Do not bake instructional text into generated pixels. Give informative images real alt text; use empty alt text for decorative images.

Recommended first Help visualization: a horizontal desktop/vertical mobile “Source → Verify → Create → Approve → Publish → Proof” river. Each stage links to its guide and shows one artifact below it (source, evidence, draft, decision, target, proof). A second journey graphic shows “Idea/Signal” and “Board output” converging into the same governed Content Item flow; it makes clear that no agent output bypasses human review.

## Accessibility and interaction criteria

- Conform to WCAG 2.2 AA for the redesigned shell and pages.
- Help appears in the same relative place throughout the product, matching WCAG 2.2 Consistent Help ([W3C SC 3.2.6](https://www.w3.org/WAI/WCAG22/Understanding/consistent-help)).
- Provide multiple ways to find a guide: global Help, contextual links, and Help search ([W3C SC 2.4.5](https://www.w3.org/WAI/WCAG22/Understanding/multiple-ways)).
- Use descriptive page headings and labels that explain purpose, not implementation ownership ([W3C SC 2.4.6](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels)).
- Navigation destinations use links with real URLs; commands use buttons. Filter views use links/query state or a correctly implemented tab pattern.
- On route change, move focus to the page `h1` or announce the new view; DOM and focus order follow the visible workflow ([W3C SC 2.4.3](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)).
- Every pointer target is at least 24×24 CSS px with adequate spacing; aim for 44×44 for frequent mobile and consequential actions ([W3C SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), [SC 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced)).
- No essential UI text below 12 CSS px on desktop or 14 CSS px on mobile; use status styling in addition to readable text, never color alone.
- Reflow at 320 CSS px without two-dimensional scrolling. At 200% zoom, sticky bars must not obscure focused controls.
- All drag interactions (Board tasks, grid ordering, media organization) have a click/keyboard alternative.
- Loading, success, queued, failed, setup-required, test, and unavailable states are textually announced through appropriate live regions without repeatedly stealing focus.
- Respect `prefers-reduced-motion`; scrolling to anchors is never the only way to reach a workflow.

## Prioritized implementation plan

### P0 — fix the mental model and scroll problem

1. Introduce a route-backed app shell and the seven-destination navigation.
2. Extract a compact `HomeDashboard`; cap the queue at five and remove item details, Content Studio, and workspace tools from Home.
3. Create `/content` and `/content/:id/:stage`; migrate the existing list, detail, editor, review, schedule, first-comment, and proof sections into the corresponding stages.
4. Move Organization, Channels, Automations, Agent plugins/Integrations, and Developer API under Settings.
5. Add persistent Help and ship the landing page plus the first six journey guides.

### P1 — make complex work efficient

1. Add explainable Next-up prioritization and user-specific review/action queues.
2. Add saved Content views, pagination/virtualization, and stable deep links from notifications.
3. Add contextual Help links to empty, blocked, error, and setup-required states.
4. Implement the UI-native six-stage visualization and Board-to-Content governance diagram.
5. Run tree testing on the proposed IA and task-based moderated tests on the five highest-value journeys.

### P2 — personalize without obscuring the core

1. Let users pin two or three frequent destinations or saved views without changing the default vocabulary.
2. Add recently viewed items and resumable generation/render jobs.
3. Add role-aware Home variants only after analytics/user research show material differences.

## Measurable acceptance criteria

### Home and navigation

- At 1280×720 and 100% zoom, Home shows the product-purpose line, one Next-up action, all Today counts, and five queue rows without requiring browser-page scrolling. At 200% zoom, content may scroll but remains operable and unobscured.
- Home renders no more than five Content Item rows and never mounts the full Content Studio, schedule form, first-comment workflow, or workspace setup cards.
- Desktop primary navigation contains no more than seven destinations; Help and Settings are stable utilities.
- `Create` is visibly and semantically an action, not a navigation destination.
- Every primary destination and Content Item stage has a stable URL; reload and browser Back restore the same workspace, brand, item, stage, and non-sensitive filter state.
- No hard-coded navigation counts. Every badge is live, scoped, and links to the exact items counted.
- On a 390×844 device, Home’s purpose, Next up, and status summary fit in the first viewport; the entire Home is no more than two normal screenfuls before browser zoom/text scaling.

### Findability and task success

Before broad rollout, test with at least five representative users across creator/editor/owner roles. For each of these prompts, at least 80% choose the correct first destination and 90% complete without facilitator rescue:

1. “Create a post from this idea.”
2. “Find a post that may already have published and verify the result.”
3. “Connect an Instagram account.”
4. “Change the skills available to one Board.”
5. “Create an image using ChatGPT and prepare it for review.”

Median returning-user time from Home to the highest-priority actionable control should be under 10 seconds. Median time to find a published proof should be under 30 seconds.

### Help

- Help is reachable from every authenticated page in the same relative location and via keyboard.
- Help search and category browsing both reach every guide.
- Every journey guide includes outcome, prerequisites, concrete steps, next result, safety/recovery, and related guides.
- The canonical six-stage visualization has an equivalent text sequence and screen-reader-friendly stage names.
- “Create an image with ChatGPT” cannot display **Available** unless the runtime capability check is ready. The guide does not claim synthetic generation in the current deterministic Creative Studio.
- Every AI-generated Help illustration has an editorial record (prompt/model/date) and correct alt treatment; instructional meaning never exists only inside the pixels.

### Accessibility and quality

- Automated accessibility checks have no serious/critical violations on Home, Content index, each Content stage, Boards, Settings, and Help.
- Keyboard-only regression tests cover global navigation, mobile menu, content filters, stage navigation, dialogs, and Help search.
- There is no horizontal page scroll at 320 CSS px and no hidden focused element behind sticky navigation at 200% zoom.
- All frequent/consequential mobile actions use 44×44 CSS px targets; all other custom controls meet WCAG 2.2 AA target-size/spacing requirements.

## What not to do

- Do not solve this by merely collapsing today’s long sections into accordions on Home. That preserves the wrong ownership and makes the page harder to scan.
- Do not hide all navigation in a hamburger on desktop. Hidden navigation reduces discoverability and increases task time ([NN/g, Hamburger Menus and Hidden Navigation Hurt UX Metrics](https://www.nngroup.com/articles/hamburger-menus/)).
- Do not add a generic “Tools” catch-all. Labels must be specific and mutually distinguishable.
- Do not make “Ask Origin” the only way to find capabilities; expert shortcuts should supplement, not replace, visible routes.
- Do not move Board memory/skills into global Integrations. They remain inside the selected Board.
- Do not describe ChatGPT image creation as live until the underlying generation, lineage, disclosure, and review path is implemented and verified.

## Recommended validation study

After implementing the P0 skeleton, run a lightweight IA and workflow study:

1. **Tree test** the five findability prompts above against the proposed route tree. Tree testing is specifically intended to assess whether labels and categories lead users to the right resource ([NN/g, Tree Testing](https://www.nngroup.com/articles/tree-testing/)).
2. **First-click test** the Home wireframe to confirm that users choose Next up, the appropriate Today count, or New content.
3. **Moderated task test** with realistic content states, including a provider uncertainty and an unavailable ChatGPT generation capability.
4. **Accessibility review** with keyboard, screen reader, 200% zoom, reduced motion, and a 320 CSS px viewport.
5. Compare task completion, first-click accuracy, time, navigation reversals, scroll distance, and subjective confidence against the current Home baseline.

The redesign succeeds when users can explain OriginPost in one sentence, identify their next action immediately, and predict where a capability lives without scanning a 19-item navigation or scrolling through other workspaces.
