# Simplifying OriginPost Home and contextual help

**Date:** 2026-09-13  
**Status:** Primary-source UX research and implementation recommendation  
**Scope:** OriginPost Home/dashboard, global navigation, first-run and returning-user guidance, contextual help, and journey orientation.  
**Method:** Read-only product inspection plus primary-source research. No product code was changed.

## Executive recommendation

OriginPost should turn Home from a general inventory page into a **state-driven work start**:

1. show the one most important action the current user can perform;
2. show a short, prioritized queue of other work that needs attention;
3. show the current publishing journey and its next incomplete step;
4. keep upcoming scheduled work and recent proof available but secondary; and
5. replace first-run blankness with a resumable setup-and-first-publish task list.

The product should also add one persistent **Help** entry in the same top-bar position throughout the authenticated application. It should open help for the current module, entity, role, and state, offer search across short task-oriented guides, and provide a route to human/operator help when available. Proactive guidance should appear only when the user has reached the related task, one tip at a time, with clear dismiss and reopen behavior. Do not build a mandatory product tour.

The biggest simplification is information architecture, not visual restyling. The current interface exposes 19 flat primary-navigation choices even though several are actions or alternate labels for the same Home surface. Organize navigation around user outcomes—Home, Boards, Content, Calendar, Engagement, and Analytics—and progressively disclose specialist tools and administration. Preserve `Board` as a top-level product concept, but keep Hermes and provider implementation details inside the relevant Board or settings context.

## Evidence standard and limitations

This report uses:

- **Observed** for behavior verified in the current local OriginPost source.
- **Source guidance** for a recommendation published by the organization that owns the research, standard, or design system.
- **Recommendation** for the proposed OriginPost behavior derived from those observations and sources.

Nielsen Norman Group is treated as the original publisher of its own UX research and heuristics. GOV.UK, W3C/WAI, Apple, and Atlassian sources are their official service manuals, standards, or product-design guidance. This is directional research, not a substitute for usability testing with OriginPost's news, creator, agency, and internal-content audiences.

## What the primary sources say

### 1. Reduce the initial choice set, but do not bury frequent work

Nielsen Norman Group's progressive-disclosure guidance says the initial view should show only a few important options and offer specialized options on request. It also cautions that the split must be correct: frequently needed actions belong up front, while excessive staging adds navigation cost. Its minimalist-design heuristic similarly says each irrelevant or rarely needed unit competes with important information. [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) · [10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)

GOV.UK's service guidance says a good service lets users complete their goal end to end, has no dead ends, and does not unnecessarily expose internal structures. Its guidance for internal services adds an important qualification for professional tools: people may need to repeat or switch between tasks quickly, so simplification must be balanced against efficiency. [Designing good government services](https://www.gov.uk/service-manual/design/introduction-designing-government-services) · [Services for government users](https://www.gov.uk/service-manual/design/services-for-government-users)

**Implication for OriginPost:** reduce global navigation based on task frequency and user role, while keeping a fast path for expert users through search, shortcuts, recently used destinations, or a command palette. Do not merely place all 19 entries one level deeper.

### 2. Make Home answer “what should I do next?”

The GOV.UK “complete multiple tasks” pattern recommends simplifying the transaction first. When a long process genuinely spans multiple tasks or sessions, it recommends grouping related actions, using short verb-led task names, and showing status. It also recommends starting with the smallest useful status vocabulary. [Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/) · [Task list component](https://design-system.service.gov.uk/components/task-list/)

W3C/WAI's cognitive-accessibility pattern says a multi-step process should expose completed, current, and pending steps plus important choices. Clear headings and orientation cues help people resume after distraction. [Make Each Step Clear](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p04-clear-steps/)

**Implication for OriginPost:** Home should prioritize resumable tasks and next actions, not a feature catalog. A new user's Home can show a small setup/first-publish task list; an active user's Home can show the same model as a prioritized work queue. Progress should be derived from real domain state so it remains truthful across sessions and devices.

### 3. Prefer contextual, interactive onboarding over a tour to memorize

Apple's Human Interface Guidelines say onboarding should be fast and optional, teach through interaction, and prefer context-specific tips placed near the relevant interface. Apple also recommends postponing nonessential setup and using reasonable defaults. [Apple HIG: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)

Nielsen Norman Group reports that upfront tutorials interrupt users, are poorly remembered, and do not necessarily improve task performance. Its recommended “pull revelation” appears when the product has a strong signal that help is useful. Such help must be easy to dismiss and easy to retrieve later. [Onboarding Tutorials vs. Contextual Help](https://www.nngroup.com/articles/onboarding-tutorials/)

**Implication for OriginPost:** use the user's active object and state—no channel, no source, research failed, draft ready for approval, manual handoff due—as reliable help triggers. Avoid speculative AI interruption and multi-screen coach-mark tours.

### 4. Provide two layers of help: in-context and consistently findable

Nielsen Norman Group distinguishes proactive guidance from reactive help and recommends that documentation be searchable, concise, focused on the user's task, and made of concrete steps. [Help and Documentation](https://www.nngroup.com/articles/help-and-documentation/) · [10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)

WCAG 2.2 Success Criterion 3.2.6 requires repeated help mechanisms to occur in the same relative order across a set of pages. W3C also recommends contextual help for the current function so users can get assistance without losing track of their task. The contextual-help criterion is AAA, so it is a valuable design target rather than an AA conformance claim. [Understanding Consistent Help](https://www.w3.org/WAI/WCAG22/Understanding/consistent-help) · [Understanding Help](https://www.w3.org/WAI/WCAG22/Understanding/help)

GOV.UK recommends short visible hint text when most users need it and a Details disclosure for optional information that only some users need. It warns not to hide information most users need inside a disclosure. [Text input](https://design-system.service.gov.uk/components/text-input/) · [Details](https://design-system.service.gov.uk/components/details/)

**Implication for OriginPost:** combine a persistent Help entry with local hints and disclosures. A single documentation center without in-product guidance is insufficient; a collection of unsearchable tooltips is also insufficient.

### 5. Empty states are journey states, not decoration

Atlassian's official content guidance distinguishes a true empty state after work is cleared from a blank slate where a feature has never been used. It recommends a scannable title, a brief reason, what to do next, and an imperative CTA when there is an action. [Atlassian Design: Empty state](https://atlassian.design/foundations/content/designing-messages/empty-state)

GOV.UK says users should not be stranded without knowing how to continue. Its notification-banner guidance also says banners should be used sparingly and information directly relevant to the current task should remain in the main content. [Designing good government services](https://www.gov.uk/service-manual/design/introduction-designing-government-services) · [Notification banner](https://design-system.service.gov.uk/components/notification-banner/)

**Implication for OriginPost:** distinguish first use, filtered-no-results, completed/caught-up, permission-blocked, prerequisite-blocked, service-unavailable, and true empty states. Each needs different copy and a different next action.

### 6. Labels must describe the result of activation

W3C requires link purpose to be determinable from its text or programmatic context and repeating functions to be identified consistently. GOV.UK recommends button text in sentence case that describes the action performed. [Understanding Link Purpose](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html) · [Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification) · [GOV.UK Button](https://design-system.service.gov.uk/components/button/)

**Implication for OriginPost:** a label such as “Ask Origin” must open an assistant or question interface; it must not lead to provider configuration. A “Published” summary must show published work, not the unfiltered content queue.

### 7. A help drawer or dialog needs complete keyboard behavior

The WAI-ARIA Authoring Practices modal-dialog pattern requires focus to move into a modal, remain within its tab sequence, close with Escape, and normally return to the invoking control. The dialog needs an accessible name and a visible close control. [WAI-ARIA APG: Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

**Implication for OriginPost:** if contextual help uses a modal drawer, it must implement the complete pattern and work at mobile widths and zoom. A non-modal panel can be considered if users need to read help while operating the page, but its focus order and return path must be equally deliberate.

## Current OriginPost findings

### Strengths to retain

1. **The product already has a coherent journey vocabulary.** The product brief defines Find → Verify → Create → Approve → Publish → Prove. [`docs/product-brief.md`](../product-brief.md)
2. **The selected Content Item exposes journey progress.** Home renders Source → Verify → Create → Approve → Publish → Proof and a “Next action” area, which is a strong seed for cross-session orientation. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L718-L781)
3. **System state is generally visible.** Home shows connection state, content statuses, research state, and publish-handoff recovery. It uses text labels in addition to color for most important states. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L677-L682) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L703-L714)
4. **Some contextual copy is already close to the control.** The new-content dialog explains the optional research action, channel cards explain prerequisites, and media organization includes a short usage hint. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L796-L796) · [`workspace-modules.tsx`](../../apps/web/components/workspace-modules.tsx#L588-L632) · [`workspace-modules.tsx`](../../apps/web/components/workspace-modules.tsx#L954-L969)
5. **Useful accessibility foundations exist.** Primary navigation exposes `aria-current`, content filters expose `aria-pressed`, visible focus styling exists, and the mobile sidebar restores focus to its opener. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L653-L661) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L700-L714) · [`globals.css`](../../apps/web/app/globals.css#L141-L146)
6. **Boards keep internal runtime settings subordinate.** Board Tasks and Work are user-level areas, while Hermes configuration is a sibling settings area inside the Board. This is consistent with the local domain distinction between Board and Board Plugin. [`boards-workspace.tsx`](../../apps/web/components/boards/boards-workspace.tsx#L187-L220) · [`CONTEXT.md`](../../CONTEXT.md#L15-L25)

### Usability risks

#### A. Navigation exposes the implementation map

**Observed.** The sidebar has 19 flat primary choices: Home, Boards, Inbox, Research, Signals, Create, Reuse, Calendar, Engagement, Analytics, Library, Creative Studio, Batches, Proof, Automations, Organizations, Channels, Agent plugins, and Developer API. Settings is a separate disabled item. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L163-L183) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L664-L670)

**Observed.** `Create` is an action that opens a dialog, not a location. `Inbox`, `Research`, and `Proof` all return to the same Home implementation and set the same `all` filter. They can display different active navigation labels over an identical page with the generic “Your publishing workspace” heading. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L238-L259) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L685-L698)

**Risk.** Users must infer which labels are destinations, actions, filters, setup areas, and specialist tools. Different labels can promise different content while producing the same result.

#### B. Home summary cards do not always honor their labels

**Observed.** “New items” counts inbox plus researching items but activates the `all` filter. “Published” activates the `Proof` navigation label, which also resolves to the unfiltered Home queue. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L691-L697) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L257-L259)

**Observed.** Home contains the hero, five summary cards, a content list, a dense selected-item detail, the entire Content Studio, an optional YouTube review area, and connected-tool cards in one long page. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L685-L795)

**Risk.** Summary cards behave partly as statistics, partly as filters, and partly as navigation. The long mixed-purpose page makes the current decision compete with editing and configuration surfaces.

#### C. First-run guidance is too weak for the full journey

**Observed.** When no Content Item matches, the pipeline says “Nothing waiting here” and suggests changing the filter or adding content. With no selected item, the detail and Content Studio disappear. There is no first-publish checklist derived from workspace, Brand, channel, content, evidence, draft, approval, and proof state. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L700-L718) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L783-L793)

**Observed.** Module empty states are usually informative, but several lack a direct in-state action; for example, “No monitors yet” relies on the distant hero action. [`workspace-modules.tsx`](../../apps/web/components/workspace-modules.tsx#L574-L585)

**Risk.** A new user sees individual feature affordances but not the prerequisite order or a clear definition of success.

#### D. Help is neither persistent nor task-addressable

**Observed.** There is no Help destination or top-bar Help control in the authenticated shell. Some modules contain local explanation, but there is no searchable, consistent support surface. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L637-L683)

**Observed.** “Ask Origin” navigates to Agent plugins rather than opening an assistant or help experience. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L688-L690)

**Risk.** Users who become stuck must hunt across modules, documentation outside the application, or provider settings, and the misleading action label erodes predictability.

#### E. Guidance is not consistently role- and capability-aware

**Observed.** The full global navigation is rendered for every authenticated user. Permission checks are applied deeper inside modules, such as channel management and Board task management. [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx#L653-L662) · [`workspace-modules.tsx`](../../apps/web/components/workspace-modules.tsx#L122-L124) · [`boards-workspace.tsx`](../../apps/web/components/boards/boards-workspace.tsx#L274-L278)

**Risk.** A viewer or creator can be guided to a setup task or destination they cannot complete. Disabled actions may explain the immediate prohibition but do not always route the user to the owner or next viable step.

## Target experience

### Global information architecture

Use a small set of stable, outcome-oriented destinations. The exact split must be validated with users, but this is the recommended prototype:

| Primary | Purpose | What moves under it or becomes an action |
|---|---|---|
| **Home** | Resume work, handle exceptions, see next scheduled outcomes | No generic tool catalog |
| **Boards** | Durable Brand-owned work contexts and Board Tasks | Hermes remains inside Board settings |
| **Content** | Find/verify/create/approve/prove Content Items | Inbox, Research, Proof become saved views or filters; Create becomes the primary action |
| **Calendar** | Plan and inspect Publish Targets | Posting queues stay contextual to scheduling/accounts |
| **Engagement** | Handle public and private audience work | Existing Engagement module |
| **Analytics** | Learn from verified published results | Existing Analytics module |

Place specialist workflow tools—Signals, Reuse, Library, Creative Studio, Batches, and Automations—in a collapsible **Tools** group or a searchable launcher. Place Organizations, Channels, Agent plugins, Developer API, and operational settings in **Manage workspace**. Show only destinations that are relevant to the user's role, while preserving a clear explanation and escalation route for unavailable capabilities.

Expert efficiency should come from:

- a command/search launcher that can find destinations and Content Items;
- recent destinations;
- keyboard shortcuts shown only after the standard path exists; and
- deep links with a real URL/state representation, not active-label-only component state.

### Home state model

Render one of four Home modes from server-backed state, not from a manually advanced tour flag.

#### 1. Get ready

For a workspace/Brand that cannot yet complete a publish journey, show **Get ready to publish** with only applicable tasks:

1. **Confirm your Brand** — completed when an active Brand exists.
2. **Connect a publishing account** — completed when at least one usable account exists; owner-only action, with non-owners told who can do it.
3. **Add your first content item** — completed when the Brand has one Content Item.
4. **Check the source evidence** — completed when the chosen item meets the configured evidence rule.
5. **Create a platform draft** — completed when the item has a Draft Revision.
6. **Review the exact draft** — completed when the required human decision exists.
7. **Schedule or complete a manual handoff** — completed when the target reaches the appropriate state.
8. **Confirm proof** — completed when Proof of Publish exists.

Do not show all eight as mandatory setup if the current publishing mode, role, or product configuration makes some irrelevant. Group them into at most three stages—Prepare, Make the post, Publish and prove—and show one primary next task.

#### 2. Work today

For an active workspace, show:

1. **Do this next:** the highest-priority actionable item the user has permission to complete.
2. **Needs attention:** failed, action-required, review-required, expiring-access, and blocked work, sorted by severity and deadline.
3. **Coming up:** the next few scheduled targets in the Brand timezone.
4. **Recently completed:** a compact proof-linked list, secondary to active work.

Counts can remain, but every count must open the exact set it describes and preserve the selected filter in the URL.

#### 3. Caught up

When no action is due, say why the queue is empty, acknowledge that the user is caught up, show the next scheduled event if one exists, and offer one context-appropriate action such as **Add content**. Do not use the same copy as first use or filtered-no-results.

#### 4. Needs recovery

When a prerequisite or service is unavailable, keep the user's saved work visible. Explain:

- what could not be completed;
- whether work is safe;
- the one next action available to this user;
- who can resolve it if the user cannot; and
- when OriginPost will retry automatically, if applicable.

Use a single highest-priority page-level message. Put task-specific recovery beside the affected task.

### Contextual help model

#### Persistent Help

Add a text-and-icon **Help** button to the authenticated top bar in a consistent relative position on every module and viewport. It opens a responsive help surface with:

1. the current context as the heading, for example, “Help with reviewing a draft”;
2. a short “What you can do here” summary;
3. numbered, concrete steps for the current task;
4. “Why is this unavailable?” when the current state is blocked;
5. related guides and a search field;
6. “Contact your workspace owner” or real support details when appropriate; and
7. a visible close action and return to the user's previous focus.

Help context should use stable identifiers such as `module`, `entityType`, `entityStatus`, `role`, `capability`, and `errorCode`. Do not send draft bodies, source text, secrets, credentials, or private message content to help telemetry or a third-party help service.

#### Proactive guidance

Show at most one proactive tip at a time and only after a strong contextual trigger. Examples:

- first arrival on an empty Brand: explain the setup task list;
- first source-free Content Item: explain evidence and point to **Research sources**;
- first Draft Revision: explain that approval binds the exact revision;
- first manual handoff: explain the two-step acknowledge/post/proof flow;
- first blocked provider result: explain “check the platform before retrying.”

Every tip must be dismissible in one action, must not reappear after dismissal unless its material context changed, and must remain retrievable from Help. Persist dismissal per user, help topic, and major topic version—not merely per browser.

#### Inline help

Use this hierarchy:

1. make the label self-explanatory;
2. add one short visible hint when most users need the information;
3. add a native `<details>` disclosure for optional explanation needed by some users;
4. link to the contextual guide for multi-step or troubleshooting content; and
5. expose support/escalation when self-service cannot resolve the block.

Do not put required publishing-risk, approval, rights, or destructive-action information behind a tooltip or closed disclosure.

## Prioritized implementation recommendations

### P0 — correct broken promises before adding onboarding

1. Make Home summary cards filter to the exact counted state.
2. Remove or repair the Inbox, Research, and Proof sidebar destinations so their label, heading, URL, filter, and contents agree.
3. Change “Ask Origin” to **Manage agent providers** if it continues to open Agent plugins; reserve “Ask Origin” for a real question/assistant interface.
4. Give each empty/error/permission state an accurate reason and attainable next action.
5. Add a consistently positioned Help control, even if the first version contains only a small set of hand-authored contextual guides.

### P1 — build the work-start Home and first-publish journey

1. Introduce the four Home modes above.
2. Derive journey tasks from actual workspace, Brand, channel, Content Item, Draft Revision, Approval, Publish Target, and Proof records.
3. Add one primary next action and a short prioritized attention queue.
4. Move full editing and specialist configuration out of the default Home flow; deep-link into the relevant surface with the selected object preserved.
5. Group global navigation and make destination state URL-addressable.

### P2 — mature help using evidence

1. Add help search, related topics, and owner/support escalation.
2. Add contextual tips only for observed drop-off or repeat-error points.
3. Add role-, capability-, and error-code-specific help variants.
4. Feed privacy-safe support themes and zero-result searches back into product improvements.

## Acceptance criteria

### Navigation and labels

- [ ] The default desktop and mobile navigation exposes no more than 7 ungrouped primary destinations.
- [ ] Boards remains a top-level destination; Hermes is not a global destination and is only described as an internal Board capability/settings area where needed.
- [ ] Actions such as **Add content** are rendered as actions, not as current-page navigation items.
- [ ] Inbox, Research, and Proof are either distinct pages or visibly labeled Content views; selecting one updates the page heading, active view, URL, and results together.
- [ ] Every Home count opens exactly the records included in that count; automated tests cover mixed statuses, zero counts, and archived records.
- [ ] “Ask Origin” opens a real question/help interface, or the label is changed to describe provider configuration.
- [ ] The global search label and results scope are explicit on every module; a user never mistakes Content-only search for search of the current module.
- [ ] A viewer sees no primary CTA they cannot perform. When an unavailable setup action is relevant, the UI names the role/person who can complete it and offers an attainable next step.

### Home and user journey

- [ ] Home renders exactly one of: Get ready, Work today, Caught up, or Needs recovery, based on documented domain-state rules.
- [ ] Get ready progress is derived from server-backed records and survives sign-out, browser changes, and another user completing an owner-only prerequisite.
- [ ] The first-publish task list shows completed, current, and pending work and uses at most the minimum status set validated by research.
- [ ] The primary next action is a verb-led, specific action and opens the exact object and step it names.
- [ ] The attention queue prioritizes action-required and failed work ahead of routine scheduled or published work and shows the Brand timezone for deadlines.
- [ ] The caught-up state is distinct from first use and filtered-no-results and includes a direct CTA only when there is a sensible action.
- [ ] A filtered-no-results state preserves the user's data and offers **Clear filters**; it never implies that the workspace has no content.
- [ ] A blocked state explains what happened, whether saved work is safe, who can fix it, and what the current user can do next.
- [ ] No essential next action requires scrolling past Content Studio or workspace-tool promotion cards.

### Contextual onboarding and Help

- [ ] A visible text-and-icon Help control appears in the same relative top-bar order on every authenticated module at desktop and mobile breakpoints.
- [ ] Opening Help uses the current module/entity/status/role to show a task-specific title and concrete steps; closing it returns focus to the invoking control.
- [ ] If Help is modal, Tab and Shift+Tab stay within it, Escape closes it, the surface has an accessible name, and a visible Close button exists, following the WAI-ARIA APG dialog pattern.
- [ ] Help is usable at 320 CSS px width and at 200% zoom without hiding the close control or focused element.
- [ ] Help search returns task-oriented results using user vocabulary, including “connect Instagram,” “research a source,” “approve a draft,” “manual publish,” and “find proof.” A zero-result query offers a support/owner path rather than a dead end.
- [ ] Each proactive tip has a documented state-based trigger, appears only in the related context, and can be dismissed in one action.
- [ ] Dismissed help can be reopened from Help. Dismissal is persisted per user/topic/version and is never used as evidence that the underlying task is complete.
- [ ] No more than one proactive tip or page-level onboarding message is visible at a time.
- [ ] Required risk, rights, approval, and destructive-action information is visible in the task flow and not hidden behind a tooltip or closed disclosure.
- [ ] Repeated help controls have consistent visible labels and accessible names across modules.
- [ ] Help telemetry excludes Content Item bodies, captions, source text, credentials, tokens, private messages, and other customer content.

### Empty, error, and system states

- [ ] Component tests cover first use, true empty, caught up, filtered-no-results, permission blocked, prerequisite blocked, loading, service unavailable, and recoverable error states.
- [ ] Each state has a concise title, a reason, and either one attainable primary next action or an explicit statement that no action is required.
- [ ] Page-level banners are reserved for the highest-priority cross-page or outcome message; task-specific information stays next to the task.
- [ ] Dynamic success, error, and progress changes are announced to assistive technologies without moving focus unexpectedly.
- [ ] Error copy uses plain language, identifies the affected object/action, and offers a concrete recovery path without exposing internal provider/runtime details.

### Validation and measurement

- [ ] Run task-based usability sessions with at least one owner/manager and one creator/viewer from each priority audience segment before finalizing the navigation groups.
- [ ] Test these journeys with realistic data: first connected channel and first publish; resume a researched item; approve the exact draft; recover a manual handoff; find proof; resolve a failed provider result; and switch Brand/Board.
- [ ] Include keyboard-only, screen-reader, 200% zoom, narrow mobile, and interruption/resume testing.
- [ ] Establish baseline and post-change measures for: time to first valid Content Item, time to first verified Draft Revision, time to first Proof of Publish, journey completion, repeated backtracking, navigation mis-selections, help search success, help zero-result rate, and unresolved support themes.
- [ ] Treat lower help usage as success only when task completion and recovery improve; disappearing help clicks alone are not evidence of better usability.

## Recommended first prototype

The smallest useful prototype is not a tour. It is:

1. a grouped sidebar with Home, Boards, Content, Calendar, Engagement, and Analytics;
2. a Home “Do this next” card plus an attention queue;
3. a first-publish task list shown only when the Brand is not yet publish-ready;
4. corrected summary-card filtering and URL state;
5. a persistent Help button with five contextual guides; and
6. distinct blank-slate, caught-up, filtered-empty, blocked, and unavailable components.

Prototype help guides should cover:

- Connect a publishing account
- Add and research a Content Item
- Create and approve a Draft Revision
- Schedule or complete a manual handoff
- Find and verify Proof of Publish

This slice is large enough to test the core information architecture and journey model, but small enough to discard or revise before building a generalized help CMS or assistant.

## Primary sources

- Apple, [Human Interface Guidelines: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- Atlassian Design System, [Empty state](https://atlassian.design/foundations/content/designing-messages/empty-state)
- GOV.UK Design System, [Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)
- GOV.UK Design System, [Task list](https://design-system.service.gov.uk/components/task-list/)
- GOV.UK Design System, [Details](https://design-system.service.gov.uk/components/details/)
- GOV.UK Design System, [Text input / hint text](https://design-system.service.gov.uk/components/text-input/)
- GOV.UK Design System, [Button](https://design-system.service.gov.uk/components/button/)
- GOV.UK Design System, [Notification banner](https://design-system.service.gov.uk/components/notification-banner/)
- GOV.UK Service Manual, [Designing good government services](https://www.gov.uk/service-manual/design/introduction-designing-government-services)
- GOV.UK Service Manual, [Services for government users](https://www.gov.uk/service-manual/design/services-for-government-users)
- Nielsen Norman Group, [10 Usability Heuristics for User Interface Design](https://www.nngroup.com/articles/ten-usability-heuristics/)
- Nielsen Norman Group, [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- Nielsen Norman Group, [Onboarding Tutorials vs. Contextual Help](https://www.nngroup.com/articles/onboarding-tutorials/)
- Nielsen Norman Group, [Help and Documentation](https://www.nngroup.com/articles/help-and-documentation/)
- W3C/WAI, [WCAG 2.2 Understanding SC 3.2.6: Consistent Help](https://www.w3.org/WAI/WCAG22/Understanding/consistent-help)
- W3C/WAI, [WCAG Understanding SC 3.3.5: Help](https://www.w3.org/WAI/WCAG22/Understanding/help)
- W3C/WAI, [Cognitive Accessibility Pattern: Make Each Step Clear](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p04-clear-steps/)
- W3C/WAI, [Understanding SC 2.4.4: Link Purpose (In Context)](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html)
- W3C/WAI, [Understanding SC 3.2.4: Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification)
- W3C/WAI, [ARIA Authoring Practices: Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
