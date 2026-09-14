# OriginPost premium sidebar: primary-source research and direction

**Date:** 2026-09-14  
**Status:** Implemented in the authenticated shell; deeper information-architecture follow-up remains optional  
**Scope:** Authenticated desktop and mobile navigation, active states, information architecture, icon system, density, motion, accessibility, and React/Next.js implementation.

## Executive recommendation

OriginPost should replace the conventional white dashboard sidebar with an **editorial folio**: a warm, matte, floating navigation surface with a narrow **proof notch** marking the current destination. The visual metaphor comes from OriginPost's actual product promise—moving work from source to proof—not from generic AI motifs such as sparkles, glowing gradients, robot glyphs, or a dark rounded rectangle behind every selected row.

The new shell should:

1. keep the seven frequent destinations visible and organize them into short, named groups;
2. place specialist tools behind one disclosure and workspace administration behind a separate management entry;
3. use real URL links and one unambiguous current-page state;
4. use one distinctive icon family only in the shell;
5. express the selected destination with a left-edge proof notch, a quiet paper-colored inset, stronger type, and a slightly heavier icon—not another full-color pill; and
6. use fast, restrained state transitions with a no-motion equivalent.

The best icon choice for this iteration is **Hugeicons Stroke Rounded**, not a new dependency. OriginPost already includes `@hugeicons/react` and `@hugeicons/core-free-icons`, while the sidebar still renders Lucide icons. Hugeicons gives the shell a less familiar silhouette and enough domain-specific icons to replace generic dashboard metaphors. The official React documentation explicitly supports React and Next.js, named imports, `currentColor`, configurable stroke width, and an application-level wrapper for consistent defaults. [Hugeicons React overview](https://hugeicons.com/docs/integrations/react/overview) · [Hugeicons React best practices](https://hugeicons.com/docs/integrations/react/best-practices)

Do not purchase a Pro icon package for the first version. The installed free rounded-stroke family is sufficient to test the new identity. If usability testing shows that weight-changing active icons materially improve recognition, Phosphor is the best fallback because its official React package supplies thin, regular, bold, fill, and duotone weights plus an SSR import for React Server Components. [Phosphor React](https://github.com/phosphor-icons/react)

## What made the previous sidebar feel generic

These are repository observations rather than external claims:

- The prior shell used Lucide outline icons for every navigation destination. The implementation now reserves Hugeicons for the global shell while retaining existing icons inside page content. [`apps/web/package.json`](../../apps/web/package.json) · [`originpost-app.tsx`](../../apps/web/components/originpost-app.tsx)
- The primary navigation is seven flat destinations—Home, Boards, Content, Calendar, Engagement, Analytics, and Library—followed by an 11-item “More tools” disclosure. Help and Manage workspace are separate rows at the bottom. The number of destinations is defensible, but the grouping is weak.
- Every destination used the same 40 px rounded-row grammar; the active state became a full charcoal rounded rectangle with white text. This was a familiar template treatment that visually overstated selection.
- Navigation destinations were rendered as buttons and navigation was performed imperatively. The implemented shell now exposes real `href` values while preserving the existing client-side transitions.
- The safety notice is a full card near the bottom. Together with the workspace switcher, help, management, and user row, it makes the rail feel like stacked dashboard cards rather than one designed navigation system.
- The shell palette and Manrope typography are already restrained and usable. A successful revision should evolve those assets rather than add neon gradients, glass everywhere, or ornamental animation.

## What official design systems consistently recommend

### 1. A sidebar is appropriate, but its hierarchy should stay shallow

Carbon recommends a left panel when there are more than five secondary destinations or users switch between them frequently, but explicitly says the panel does not support three tiers and deeper content should move into the page. [Carbon UI shell left panel](https://v10.carbondesignsystem.com/components/UI-shell-left-panel/usage/)

Apple describes a sidebar as a broad, flat view of peer areas, recommends disclosure controls when content is extensive, allows user customization, recommends a hide/show control, and advises no more than two levels of hierarchy. It also treats modern navigation as a functional layer that floats above content. [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) · [Apple HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)

Fluent similarly keeps high-level navigation to one nesting level, recommends short plain-language labels, and says search or pinning cannot substitute for coherent information architecture. It also recommends minimizing secondary actions on navigation rows. [Fluent 2 React Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)

**OriginPost implication:** retain a sidebar on desktop, but cap it at two levels. Do not expose Boards → plugin → skill → memory as nested global navigation. Board-specific settings stay inside a Board. Tools can expand once; deeper structure belongs inside each destination.

### 2. Grouping and order matter more than adding another visual effect

Primer recommends reducing the number of navigation choices while retaining essential ones, using logical groups, and applying leading visuals consistently to all or none. Its `NavList` guidance distinguishes navigation links from action lists and says activating a navigation item should change the URL. [Primer navigation patterns](https://primer.style/product/ui-patterns/navigation/) · [Primer NavList](https://primer.style/product/components/nav-list/)

Fluent says navigation should be brief, plain, easy to scan, oriented to users' goals, and ordered by importance. It also recommends keeping high-level navigation clean rather than attaching many edit actions to rows. [Fluent 2 React Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)

**OriginPost implication:** the rail should provide a readable product map, not a catalog of every internal capability. Use small section labels to make the hierarchy explicit:

| Group | Always visible | Rationale |
|---|---|---|
| **Work** | Home, Boards, Content | Resume work and manage the core source-to-proof objects. |
| **Plan** | Calendar, Engagement | Time-bound publishing and audience work. |
| **Measure** | Analytics, Library | Outcomes and owned/cleared assets. |
| **Tools** | One disclosure | Research, Signals, Reuse, Creative Studio, Batches, Proof, and Automations. |
| **Workspace** | One management entry | Organizations, Channels, Agent plugins, and Developer API stay out of daily navigation. |

This is a recommendation to prototype, not a claim that the labels are final. Validate the grouping with task-based usability sessions. Preserve stable routes for every destination even when the entry is progressively disclosed.

### 3. Premium can come from restrained layering, not “AI glass”

Apple's current layout guidance treats navigation as a separate control layer that can float above content; it also warns that legibility must be maintained when material or transparency is used. [Apple HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout) · [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

Atlassian's motion system states that motion should clarify what changed, not decorate; high-frequency hover and press interactions should be subtle and near-instant, with 50–150 ms interactions and longer transitions reserved for larger panels. [Atlassian Design: Motion](https://atlassian.design/foundations/motion)

**OriginPost implication:** make the rail feel premium through proportion, surface, type, and fit-and-finish:

- inset it 12 px from the viewport on desktop and give it an 18–20 px outer radius;
- use a deep warm graphite matte surface, a one-pixel light edge, and one soft shadow;
- use section labels and negative space instead of a card around every cluster;
- keep the workspace switcher integrated into the top of the folio rather than styled as a form field;
- reduce the safety card to a single compact status row with a dot and label;
- use an active **proof notch**—a 3 px sand/copper marker at the leading edge—plus a subtle warm paper inset; and
- avoid blur when it reduces contrast. The design can be floating without being translucent.

Suggested initial tokens for prototyping:

```css
--rail-bg: #181d1b;
--rail-surface: #212724;
--rail-line: rgba(255, 255, 255, 0.09);
--rail-text: #f7f2e8;
--rail-muted: #aeb8b2;
--rail-active: #f1eadf;
--rail-active-ink: #202724;
--rail-notch: #d1ad87;
--rail-status: #91b095;
```

These are starting values; all combinations still require automated and visual contrast checks.

### 4. Selection needs one strong signal, not several loud ones

Fluent says the selection indicator must make the active page clear at a glance. Primer requires one selected navigation item to expose `aria-current="page"`, and its accessibility guidance says only one item in a navigation list should carry the active `aria-current` value. Material 3's current navigation rail likewise separates destination content from an active indicator rather than relying only on a color change. [Fluent 2 React Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage) · [Primer NavList accessibility](https://primer.style/product/components/nav-list/accessibility/) · [Material 3 navigation rail](https://m3.material.io/components/navigation-rail/)

**OriginPost implication:** use four coordinated but restrained changes for the active item:

1. proof notch at the leading edge;
2. warm inset background with no drop shadow;
3. label weight changes from about 560 to 700; and
4. icon stroke changes from 1.5 to 1.9 and adopts the active ink color.

Do not animate the notch continuously, use a glow, or swap to a sparkle. The icon and the text remain supplementary to the page label; neither should be the only cue.

### 5. Use links for locations and disclosure buttons for disclosure

The WAI-ARIA Authoring Practices navigation example explicitly warns that ordinary site navigation does not need the `menu` role and recommends semantic HTML. Its disclosure pattern uses a button with an expanded state to show nested links. [WAI-ARIA APG disclosure navigation](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/)

Primer's NavList renders destinations as links, expects `href`, and uses `aria-current` for the current page. Its responsive guidance also says URL-changing navigation must stay distinguishable from filters or actions. [Primer NavList](https://primer.style/product/components/nav-list/) · [Primer navigation patterns](https://primer.style/product/ui-patterns/navigation/)

Next.js documents that `<Link>` provides client-side transitions and automatically prefetches routes when appropriate. [Next.js linking and navigating](https://nextjs.org/docs/app/getting-started/linking-and-navigating)

**OriginPost implication:** render every destination as `<Link href={workspaceHref(...)}>` and reserve `<button>` for “More tools,” workspace switching, collapse/close, sign out, and other actions. Keep `aria-current="page"` on exactly one destination. Retain the existing stable page URLs and Back/Forward behavior.

### 6. Responsive behavior should preserve the product map

Apple recommends allowing people to hide a sidebar and adapting navigation when space is limited. Primer shows the sidebar persistently at wide widths and moves it to a separate accessible surface on narrow widths. [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) · [Primer navigation patterns](https://primer.style/product/ui-patterns/navigation/)

**OriginPost implication:** do not default to a desktop icon-only rail. The labels carry too much of the product model, and Fluent's React Nav deliberately does not support an icon-only presentation. At narrow widths, keep the existing modal drawer model, but give it the same folio styling and an explicit close control. At intermediate widths, collapse the entire rail behind the top-bar control rather than showing ambiguous icons without labels. A user-selected compact mode can be evaluated later with persistent tooltips and accessible names.

## Icon library decision

| Option | Official capability | OriginPost fit | Decision |
|---|---|---|---|
| **Hugeicons** | React/Next.js support, free rounded-stroke set, named imports, `currentColor`, adjustable stroke width, application wrapper. [Docs](https://hugeicons.com/docs/integrations/react/overview) | Already installed; noticeably different from the current Lucide look; broad domain vocabulary. | **Use for the shell now.** |
| **Phosphor** | Six weights including fill and duotone; SSR/RSC import; current-color SVG props. [Official repository](https://github.com/phosphor-icons/react) | Strong active/inactive weight changes and expressive shapes, but adds another dependency. | Keep as fallback after prototype testing. |
| **Iconoir** | 1,600+ 24×24 icons with an official React package and MIT license. [Official repository](https://github.com/iconoir-icons/iconoir) | Elegant but another thin outline family may not create enough differentiation from Lucide. | Do not add for this revision. |
| **Radix Icons** | Crisp 15×15 React icons, MIT. [Official docs](https://www.radix-ui.com/icons) | Excellent for dense controls, but too small and neutral to own the main product navigation. | Reserve for compact controls only if ever needed. |

Recommended Hugeicons shell mapping, using names verified in the installed free package:

| Destination | Icon | Why |
|---|---|---|
| Home | `DashboardSquare02Icon` | “Today/workspace” rather than a generic house. |
| Boards | `KanbanIcon` | Directly names the Board workspace. |
| Content | `InboxCheckIcon` | Connects intake with reviewed work. |
| Calendar | `Calendar02Icon` | Familiar scheduling landmark. |
| Engagement | `MessageMultiple02Icon` | Multiple audience conversations. |
| Analytics | `Analytics02Icon` | Outcome measurement without an AI glyph. |
| Library | `LibraryBigIcon` | A distinctive repository metaphor. |
| Research | `SearchVisualIcon` | Evidence-oriented inspection rather than plain search. |
| Signals | `Radar02Icon` | Discovery and monitoring. |
| Reuse | `RotateLeft01Icon` | Re-entry into a workflow. |
| Creative Studio | `PaintBoardIcon` | Editorial creation, not magic/sparkles. |
| Batches | `Files01Icon` | Multiple content objects. |
| Proof | `Shield02Icon` | Verified safety/proof. |
| Automations | `ZapIcon` | Use only here; not as a generic AI accent. |
| Organizations | `Building03Icon` | Workspace structure. |
| Channels | `LinkSquare01Icon` | Connected destinations. |
| Agent plugins | `Plug03Icon` | Plugin capability without a robot. |
| Developer API | `ApiGatewayIcon` | Explicit developer meaning. |
| Help | `HelpCircleIcon` | Familiar and unambiguous. |

Create a local `NavigationIcon` wrapper with defaults of `size={19}`, `color="currentColor"`, and `strokeWidth={1.5}`; allow only the active item to raise stroke width. Hugeicons itself recommends an application-level wrapper and targeted named imports for consistency, accessibility, and tree shaking. [Hugeicons React best practices](https://hugeicons.com/docs/integrations/react/best-practices)

Icons in labeled navigation should be decorative (`aria-hidden`) because the adjacent label provides the accessible name. Do not use icon-only destinations, and do not depend on icon color to communicate state.

## Interaction, motion, and accessibility requirements

### Density

- Use 44 px navigation rows with 8 px between groups. This comfortably exceeds WCAG 2.2's 24×24 CSS px minimum target while remaining appropriate for a professional desktop tool. [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- Use 12–13 px labels and 10 px uppercase group labels with deliberate letter spacing.
- Keep unread counts as trailing metadata; do not add counts to every row.
- Keep only one optional row action and expose it outside hover as well. Fluent notes that hover-only actions must remain available to assistive technology and alternative input. [Fluent 2 React Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)

### Focus and keyboard

- Keep a visible 2–3 px focus perimeter with at least 3:1 change of contrast; the current global 3 px ring is a sound baseline. [WCAG 2.2 focus appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance)
- DOM order must match visual order.
- “More tools” exposes `aria-expanded` and `aria-controls`; Escape closes it and returns focus to the trigger when used as an overlay.
- The mobile drawer moves focus to a meaningful first control, closes with Escape, prevents background interaction, and returns focus to the opener.
- Use one labeled `<nav>` landmark. If a separate workspace-management nav is added, give each navigation landmark a unique accessible name. [WAI navigation landmark](https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/navigation.html)

### Motion

- Color, opacity, and active-background changes: 80–120 ms.
- Drawer entrance: 180–220 ms; exit should be slightly faster.
- No scale-on-hover, bouncing icons, ambient pulse, parallax, or moving gradients in frequent navigation.
- Under `@media (prefers-reduced-motion: reduce)`, remove transforms and make panel/state changes immediate. WCAG says interaction-triggered nonessential motion must be disableable; Atlassian recommends verifying the interface with all motion disabled. [WCAG animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions) · [Atlassian Design: Motion](https://atlassian.design/foundations/motion)

## Concrete implementation sequence

### Phase 1 — shell-only visual and semantic change

1. Add a typed navigation configuration containing group, label, route, Hugeicons icon, permission rule, and optional badge source.
2. Add a local `NavigationIcon` wrapper and replace Lucide only in the global shell. Do not mix icon families within one navigation region.
3. Replace destination buttons with Next.js `<Link>` components; retain buttons for disclosures and actions.
4. Implement the floating folio surface, section labels, proof notch, compact safety status, and active row tokens.
5. Preserve current routes, workspace switching, unread badge behavior, mobile focus management, and permissions.

### Phase 2 — information architecture

1. Move Research, Signals, Reuse, Creative Studio, Batches, Proof, and Automations under Tools.
2. Make Manage workspace a single entry that owns Organizations, Channels, Agent plugins, and Developer API as page-local tabs or sub-navigation.
3. Store Tools disclosure state locally, but automatically expose it when a child route is current.
4. Measure destination use before adding pinning or personalization. Apple permits sidebar customization, but Fluent cautions that pinning cannot repair unclear taxonomy.

### Phase 3 — validation

Run task-based sessions at desktop, 200% zoom, tablet width, and mobile for:

- finding a Board;
- reviewing a Content Item;
- checking the Calendar;
- opening Engagement;
- locating Library media;
- connecting a Channel; and
- returning to the prior page with Back.

## Acceptance criteria

- The sidebar looks recognizably OriginPost even if the wordmark is covered: matte folio surface, sand proof notch, editorial grouping, and Hugeicons are consistent.
- No top-level navigation icon uses a sparkle, robot, magic wand, or generic “AI” glyph.
- Every destination has a stable `href`, can be opened in a new tab, survives refresh, and works with Back/Forward.
- Exactly one destination exposes `aria-current="page"`.
- Navigation has no more than two hierarchy levels.
- Labels remain visible at the default desktop width; the intermediate layout uses the drawer rather than an unlabeled icon rail.
- Every target is at least 44 px high in the sidebar prototype.
- Keyboard focus is visible on inactive and active rows; the focused state remains distinguishable from the current-page state.
- The layout remains usable at 200% zoom and at 320 CSS px width.
- With reduced motion enabled, the sidebar retains all state information with no translating, scaling, pulsing, or sweeping animation.
- The production build contains only the named Hugeicons imports actually used by the shell.

## Primary sources

- [Apple Human Interface Guidelines: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple Human Interface Guidelines: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Atlassian Design System: Motion](https://atlassian.design/foundations/motion)
- [Carbon Design System: UI shell left panel](https://v10.carbondesignsystem.com/components/UI-shell-left-panel/usage/)
- [Fluent 2: React Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)
- [Material 3: Navigation rail](https://m3.material.io/components/navigation-rail/)
- [Primer: Navigation patterns](https://primer.style/product/ui-patterns/navigation/)
- [Primer: NavList](https://primer.style/product/components/nav-list/)
- [Primer: NavList accessibility](https://primer.style/product/components/nav-list/accessibility/)
- [WAI-ARIA APG: Disclosure navigation](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/)
- [WAI-ARIA APG: Navigation landmark](https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/navigation.html)
- [WCAG 2.2: Focus appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance)
- [WCAG 2.2: Target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- [WCAG 2.2: Animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)
- [Next.js: Linking and navigating](https://nextjs.org/docs/app/getting-started/linking-and-navigating)
- [Hugeicons: React overview](https://hugeicons.com/docs/integrations/react/overview)
- [Hugeicons: React best practices](https://hugeicons.com/docs/integrations/react/best-practices)
- [Phosphor Icons for React](https://github.com/phosphor-icons/react)
- [Iconoir](https://github.com/iconoir-icons/iconoir)
- [Radix Icons](https://www.radix-ui.com/icons)
