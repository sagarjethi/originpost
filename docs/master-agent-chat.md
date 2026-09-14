# Master agent chat plan

Status: updated 2026-09-14. The `/agent` route now implements a durable news-to-image workflow with project templates, logo placement/cropping, uploaded style references, research, copy, image generation, deterministic composition, and an unapproved draft. See [implemented scope and configuration](agent-chat-ui.md). Named multi-agent group chats and publishing directly from chat remain proposed. The local image provider and text runtime still require configuration for live generation.

## Decision

OriginPost should add one top-level **Agent** work surface at `/agent`. The user experience is a familiar conversation, but the underlying Module is a governed orchestrator: it can understand a request, read scoped context, produce a preview, and propose a typed action. It never treats prose as permission and never bypasses an existing OriginPost workflow.

The recommended architecture has one deep Module, `AgentConversation`, with three Interface entry points:

```ts
export interface AgentConversationModule {
  dispatch(command: AgentConversationCommand, actor: Actor): Promise<AgentCommandReceipt>;
  load(query: AgentConversationQuery, actor: Actor): Promise<AgentConversationProjection>;
  observe(query: AgentEventQuery, actor: Actor): AsyncIterable<AgentConversationEvent>;
}
```

`dispatch` accepts a closed command union for starting a conversation, sending a turn, revising or deciding a proposed action, and interrupting a run. The small Interface gives callers high Leverage while the Implementation hides model routing, action planning, policy checks, persistence, idempotency, outbox delivery, and provider reconciliation.

## Product promise

A person can type requests such as:

- “Research this URL and prepare an Instagram carousel.”
- “Add the Mumbai and Luma tags to this Content Item.”
- “Create a task for the Mumbai Board and assign it to the Board agent.”
- “Prepare this approved Reel for the connected Instagram account tomorrow at 9 AM.”

The Agent replies conversationally, shows what it found or generated, and places any state-changing step in an explicit action card. The person can inspect, edit, confirm, or decline the card. Successful work links to its authoritative OriginPost record.

“Deploy to a platform” means prepare or schedule through a supported, healthy Connected Account. It does not mean arbitrary infrastructure deployment, direct provider calls from the model, or publishing an unapproved draft.

## In-product agents and group conversations

This feature lives inside **OriginPost**. Users talk to agents at `/agent`, attach Library images or source links, and ask for complete work. Telegram is an optional future ingress, not the interface or runtime being built here. Each publisher has its own Brand configuration; its logo, language rules, accounts, and runtime setup must not become global OriginPost defaults.

### Named agents, specialists, and runtimes

Keep three concepts separate:

- **Named Agent**: a durable, scoped identity users can select or mention, such as `@Codex`, `@Research`, `@Writer`, or `@Image`. Its display name is configurable; its immutable ID anchors attribution.
- **Specialist**: the versioned role instructions and permitted planning capabilities associated with that identity. Research, writing, image direction, and publishing coordination are distinct responsibilities.
- **Runtime binding**: the server-owned execution configuration that performs the work. A display name does not grant tools, select an arbitrary provider, or establish access to a model.

A user may call their main agent Codex or Hermes. The normal composer shows that identity and capability availability; connection details belong in authorized settings. `@Image` can be a Creative specialist delegated by `@Codex`; there is no requirement for a separately running bot, model named “Codex sub-image,” or second public bot account.

The default is one coordinator. Users can also start a named group with several eligible agents, for example **Content team** with Coordinator, Research, Writer, Image, and Reviewer. Use a proposed initial limit of six participants and three concurrent child runs; these are OriginPost budget choices, not platform guarantees.

### Group and mention behavior

1. New chat selects immutable Workspace/Brand/scope and either one agent or a group. All participants must be eligible for the same scope. A participant from another Board is not eligible.
2. Typing `@` opens a searchable list of eligible participants with name, role, availability, and a short capability description. Choosing a result creates a structured mention token. Arbitrary text resembling a handle does not resolve an agent or confer authority.
3. An unaddressed message goes to the coordinator. A message mentioning one participant routes there. With multiple mentions, the coordinator assigns bounded work and returns one combined result with per-agent attribution.
4. A group uses one visible conversation transcript and scoped artifact list. It does not pool private chats, Board Memory, credentials, runtime histories, or all participant files. Child runs receive an explicit task and the minimum authorized context snapshot.
5. A reply to an agent message can continue that participant's work. Replies and mentions are stored as IDs and validated against conversation membership. The UI always shows who is responding.
6. Participant membership is fixed for v1. Changing members creates a new conversation with explicit, authorized references to selected prior artifacts; it does not silently transfer history. Later membership editing needs its own history-visibility policy.
7. `@Writer` and `@Image` may work concurrently after Research freezes the common fact ledger. Reviewer sees the same ledger and exact candidate versions. An independent reviewer can request corrections but cannot create a human Approval.
8. Internal handoffs carry bounded task IDs, source/asset references, output schema, deadline, and budget. Handoff depth, total children, and total spend are bounded by server policy. Duplicate delegation is deduplicated; agents cannot mention each other into an endless loop.
9. Safe status labels identify work such as “Research checking sources” or “Image preparing artwork.” A collapsed activity panel shows handoffs and outcomes; it never streams hidden reasoning or raw tool calls.
10. Stop cancels queued children and requests cancellation of running children. Completed assets remain linked. A publish request or paid generation already in flight follows its existing reconciliation contract.

**Grok reference:** the companion [primary-source research](research/2026-09-14-grok-bot-agent-architecture.md) documents Grok Bot's named Bots, groups, mentions, shared files, and asynchronous handoffs. These are product patterns we can adapt. OriginPost's action ledger, scope restrictions, and domain workflow remain our design; Grok's private implementation is not known.

### Main journey: “@Codex create an image, write the post, and deploy”

Within a Brand-scoped conversation, the user attaches an image or source URL and selects the intended account, or uses an already selected destination. The coordinator interprets this as one **Post Package** goal: image, headline, caption, sources, disclosure, and delivery status. It asks only for missing information that blocks the package, such as an unspecified destination when several accounts are possible.

1. Research checks the supplied material and produces a versioned fact ledger, source references, and media-rights status. An attached image is context, not automatic evidence or reuse permission.
2. Writer prepares the headline and platform-specific caption. Image prepares a matching visual brief using the same facts and Brand assets. If the user only asks for an image, return the image with suggested post text by default; respect an explicit image-only or caption-only request.
3. The conversation shows the copy preview and an exact generation action card, including format and cost information when available. Existing confirmation policy governs the paid generation. The authorized Creative command produces the asset through the current image-generation, inspection, and Library pipeline.
4. Creative Studio composes exact text, logo, source credit, and safe areas as required by Brand policy. Real documentary pixels retain their provenance; generated foundations retain synthetic lineage. Current one-shot generation must not be presented as image editing: inspect capability first and offer a new generation or supported composition when editing is unavailable.
5. The chat displays **one package card** containing image preview, headline, editable caption, sources, disclosure, destination, and readiness. Editing creates new candidate versions; image, caption, and review hashes stay bound together. Ready copy can be shown while generation is still running.
6. Save and human review use the existing sealed action cards. A workflow panel groups their progress so users can stay in chat; grouping is presentation only and does not imply one approval for unknown future drafts or paid work.
7. “Deploy” means publish now or schedule to a supported Connected Account. Once the exact draft is approved, the Publisher specialist prepares the existing preflight and Publish Target proposal. Its receipt points to the Publish Attempt and ultimately Proof of Publish.
8. A partial failure preserves completed copy and assets and names the failed step. No success message appears until the corresponding durable receipt exists; public delivery requires Proof of Publish. An uncertain external outcome remains uncertain.

Suggested package projection: `packageId`, `version`, `scope`, `sourceLedgerHash`, `headline`, `caption`, `mediaAssetIds`, `creativeRevisionId`, `draftRevisionId`, `disclosure`, `targetAccountId`, `stepStatuses`, `reviewStatus`, and receipt references. This is a conversation projection over authoritative Content/Creative/publishing records, not a second publishing database.

### Runtime implementation decision

Reuse the current OriginPost runtime boundaries:

| Context | Execution path | Required behavior |
| --- | --- | --- |
| General/content planning | Approved runtime behind `AgentPlannerPort` | Returns text, bounded delegations, and typed proposals; no direct domain writes |
| Board work | Existing `BoardRuntimePort` and restricted Hermes Profile | Preserve skill seals, four-tool boundary, Human Release, Review, and handoff |
| Image creation | Existing `ImageGenerationProvider` through Creative commands | Current code uses OpenAI Image API; persist request/asset lineage and paid-call uncertainty |
| Future local Codex planner | Optional isolated adapter, capability-tested before enablement | Map Origin conversation/run IDs to Codex thread/turn IDs; expose only permitted planning tools |
| Social delivery | Existing Content commands and publish workers | Exact approved revision and destination, followed by proof or reconciliation |

Origin's Board worker currently requires `codex_responses` and rejects the `codex_app_server` path. Do not import a publisher-specific Telegram runtime configuration into this product. The evidence is in [the local guide](hermes-local-codex.md), `packages/agents/src/hermes-board-plugin.ts`, and `integrations/hermes/originpost-board-approvals/dashboard/runtime_worker.py`.

Official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) describes durable thread/turn operations and streamed events. A future adapter can map those to Origin's conversation/run records. The app-server command and WebSocket transport are documented as experimental and unsupported for production workloads; the feature must not depend on an unverified production Codex transport. Prototype the optional local adapter separately, prefer local stdio, and keep the existing supported product paths available. Do not assume the desktop image tool or subscription credentials are available to Origin's server.

## Delivery ownership and specialist review

These are the engineering roles responsible for designing and shipping the feature. They are separate from the editorial agents users meet in a Content team.

| Role | Responsibility | Concrete deliverable and acceptance check |
| --- | --- | --- |
| Principal engineer | Module boundaries, runtime choice, delegation policy, failure handling | Architecture decision, adapter contracts, scope/permission review; no child gains broader authority than its parent |
| Product engineer | End-to-end chat-to-package-to-proof workflow | Vertical slice through existing commands; each user-visible state maps to an authoritative result |
| Experience specialist | Conversation flow, mentions, groups, revisions, recoverable errors | Desktop/mobile interaction specification; users can finish the journey without switching to runtime settings |
| Data expert | Conversation membership, immutable messages, task lineage, events, retention | Schema/migration and replay/idempotency plan; reconnect and repeated delivery cannot duplicate work |
| Frontend/UI expert | `/agent`, accessible composer, package/action cards, activity panel | Responsive implementation with keyboard/screen-reader coverage and streamed-event recovery |

Research supplies cited capability findings. Independent security/domain review checks isolation and publishing authority; independent editorial review checks actual generated packages when that workflow ships. The principal engineer resolves disagreements in a recorded decision. These are ownership assignments in this plan, not a claim that five engineering reviews have already occurred.

## Domain vocabulary to add

These terms should be added to `CONTEXT.md` before implementation:

- **Agent Conversation**: A durable, Brand-owned human/agent transcript. It is general or bound to exactly one Board or one Content Item. It is not a social Private Conversation and is not Board Memory.
- **Agent Turn**: One immutable user or assistant message in an Agent Conversation.
- **Agent Run**: One bounded model execution caused by a user turn. It can plan and explain but has no authority to write domain state.
- **Agent Action Proposal**: A typed, versioned preview of one possible OriginPost command, including exact scope, effect, risk, required permission, and expected resource versions.
- **Agent Action Decision**: A human confirmation or rejection of one exact proposal hash. It cannot be inferred from conversation text.
- **Agent Action Receipt**: The durable outcome and authoritative resource references produced after a confirmed action.
- **Named Agent**: A durable scoped identity, with an immutable ID, display name/handle, specialist version, and server-owned runtime binding.
- **Agent Group**: A fixed v1 set of eligible Named Agents inside one conversation scope; membership grants no additional data access.
- **Agent Delegation**: A bounded parent/child work request carrying explicit context references, budget, status, and artifact references; it grants no action authority.
- **Post Package**: A versioned conversational projection joining copy, media, review, and delivery references for one content goal.
- **Agent Specialist**: A server-owned behavior preset such as Research, Writer, Creative, or Publisher. A specialist changes instructions and available read/planning tools, never permissions.

### New invariants

1. Every Agent Conversation belongs to one Workspace and Brand. Its general, Board, or Content Item scope is immutable for its lifetime.
2. General conversations cannot read Board Memory or inherit Board skills. They can propose a Board Task for a chosen Board.
3. Board-bound conversations use only that Board's internal Hermes Plugin, Profile, memory scope, sealed skill policy, and capability epochs.
4. Changing Board or Content Item scope starts a new conversation. Attachments never widen the conversation scope.
5. An Agent Run may read permitted data and generate a chat preview. Any durable write requires an Agent Action Proposal and a separate human decision.
6. A proposal binds the command payload, resource versions, destination account, draft hash, and policy version. Changing any of them invalidates the decision.
7. An Agent Run cannot create an Approval or approve its own Board work. A later human-only review card may record a human's exact decision, without a preselected choice, after current authorization and revision checks.
8. Board Task Execution still requires Human Release and Board Task Review. Chat can only call the existing commands.
9. Board Content Handoff remains manager/owner initiated and creates an unapproved Content Item.
10. Publishing remains Draft Revision → Approval → Publish Target → Publish Attempt → Proof of Publish. Chat never calls a social connector directly.
11. Unknown or uncertain external outcomes are not retried automatically.
12. Transcript content is not Board Memory. Memory writes remain separate, visible, approval-gated Board Plugin operations.
13. A Generated Visual Foundation remains synthetic/illustrative media with lineage and never becomes Source Evidence merely because it was attached in chat.

## Information architecture and default UX

### Navigation

- Add **Agent** to the primary **Work** group, after Home and before Boards.
- Use `/agent?conversation=<opaque-id>` as the canonical, refresh-safe URL.
- Home may show a compact “Ask Origin” composer; submitting navigates to the canonical Agent page.
- Board and Content screens may show an “Ask Agent” action that starts a correctly scoped conversation and navigates to `/agent`.
- Keep **Boards** as its own top-level area. Keep Hermes and its memory/skill controls inside an opened Board. Do not add Hermes or a new plugin entry to top-level navigation.

### Page anatomy

Desktop uses three progressively disclosed regions:

1. A compact conversation rail with New chat, search, recent conversations, and archived conversations.
2. A centered conversation column with a sticky scope header, messages, action cards, and composer.
3. An inspector shown only when a source, generated asset, action, or receipt is selected.

Mobile uses one column. The conversation rail and inspector become sheets, while the composer and pending-confirmation state remain visible.

The sticky header shows immutable scope chips:

- Brand
- General, Board name, or Content Item name
- Auto, Research, Writer, Creative, or Publisher specialist

Changing Brand, Board, or Content Item offers **Start a new chat**; it never silently carries transcript or Board context across the boundary.

### Conversation states

```text
idle → accepting → planning → responding → completed
                         ↘ awaiting_confirmation → executing → completed
                                                     ↘ failed
                                                     ↘ uncertain
planning/responding → interrupted
```

The UI streams concise answer text and safe progress labels. It does not expose hidden instructions, credentials, raw tool payloads, or chain-of-thought.

### Action cards

Every card shows:

- the exact action and why it is proposed;
- Brand, Board or Content Item scope;
- what will be created or changed;
- platform, Connected Account, date/time/timezone, and approved Draft Revision when relevant;
- whether the action is reversible, billable, or externally visible;
- required role and any unmet prerequisite;
- **Confirm** and **Decline** controls, with **Edit details** before confirmation.

After confirmation, the same card becomes progress and then a receipt. Receipt links open the Board Task, Content Item, Creative result, Calendar target, or Proof of Publish.

### Safe default journey for publishing

1. The user asks for content.
2. The Agent researches or writes a preview in chat.
3. **Save as draft** creates a proposal; confirmation creates a Draft Revision.
4. The Agent shows a neutral Review card or links to the detailed Review screen. A permitted human makes the exact decision; the Agent Run does not.
5. The user asks to publish or schedule.
6. The Agent runs read-only channel readiness and schedule preflight, then shows one exact Publish Target proposal.
7. Confirmation creates the Publish Target through the existing Content Module.
8. The worker performs the Publish Attempt. The chat only observes progress.
9. Success displays the Proof of Publish; an uncertain result displays reconciliation guidance and never a retry button.

## Interface

```ts
type AgentConversationScope =
  | { kind: "general"; workspaceId: string; brandId: string }
  | { kind: "board"; workspaceId: string; brandId: string; boardId: string }
  | { kind: "content"; workspaceId: string; brandId: string; contentItemId: string };

type AgentFocus =
  | { kind: "source_url"; url: string }
  | { kind: "media_asset"; mediaAssetId: string };

type AgentConversationCommand =
  | {
      kind: "conversation.start";
      scope: AgentConversationScope;
      specialist?: "auto" | "research" | "writer" | "creative" | "publisher";
      participantAgentIds?: string[]; // Server validates same-scope eligibility; absent = coordinator.
      idempotencyKey: string;
    }
  | {
      kind: "turn.send";
      conversationId: string;
      expectedVersion: number;
      text: string;
      focus?: AgentFocus[];
      mentions?: { agentId: string; start: number; end: number }[]; // UTF-16 offsets; validate against text and membership.
      replyToTurnId?: string; // Same-conversation turn only.
      idempotencyKey: string;
    }
  | {
      kind: "action.revise";
      conversationId: string;
      actionId: string;
      expectedActionVersion: number;
      proposalSha256: string;
      editableValues: Readonly<Record<string, string | number | boolean | null>>;
      idempotencyKey: string;
    }
  | {
      kind: "action.decide";
      conversationId: string;
      actionId: string;
      expectedActionVersion: number;
      proposalSha256: string;
      decision: "confirm" | "decline";
      idempotencyKey: string;
    }
  | {
      kind: "run.interrupt";
      conversationId: string;
      runId: string;
      expectedRunVersion: number;
      idempotencyKey: string;
    };

type AgentConversationQuery =
  | { kind: "conversation.list"; workspaceId: string; brandId: string; cursor?: string }
  | { kind: "conversation.get"; conversationId: string; beforeSequence?: number; limit?: number };

type AgentEventQuery = {
  conversationId: string;
  afterSequence: number;
};
```

The public REST Adapter maps this Interface to:

```text
POST /v1/agent-conversations
GET  /v1/agent-conversations
GET  /v1/agent-conversations/:conversationId
POST /v1/agent-conversations/:conversationId/turns
PATCH /v1/agent-conversations/:conversationId/actions/:actionId
POST /v1/agent-conversations/:conversationId/actions/:actionId/decisions
POST /v1/agent-conversations/:conversationId/runs/:runId/interrupt
GET  /v1/agent-conversations/:conversationId/events
```

All write routes require an idempotency key. Conversation and action mutations require optimistic versions. `action.revise` accepts only fields named in that action descriptor's public edit schema, revalidates the complete action, and creates a new sealed proposal version/hash; it never edits a confirmed proposal. The event route supports `Last-Event-ID`/`afterSequence` replay and returns `text/event-stream` with private, no-store caching.

### Error model

The Module returns stable codes with safe messages:

- `agent_conversation_not_found`
- `agent_scope_mismatch`
- `agent_board_isolation_violation`
- `agent_conversation_version_conflict`
- `agent_run_active`
- `agent_run_interrupted`
- `agent_action_stale`
- `agent_action_expired`
- `agent_action_permission_denied`
- `agent_action_prerequisite_missing`
- `agent_action_uncertain`
- `agent_runtime_unavailable`
- `agent_stream_cursor_expired`

Provider errors, prompts, secrets, and internal stack traces never cross the Seam.

Named-agent configuration is owner-managed through a separate settings interface. The three-operation conversation interface remains small. Mention validation rejects unknown, disabled, duplicate, overlapping, out-of-range, and out-of-scope tokens; literal handles from source documents never route work. Run, turn, and event projections add participant IDs, parent delegation IDs, and safe artifact references.

## Action catalog and confirmation policy

The planner emits only registered action kinds with schema-validated payloads. Free-form tool names or URLs cannot become executable commands.

Two prerequisites are explicit:

- `ContentItem.tags` exists, but the current Content Module has no authoritative tag mutation command. Add a normalized, version-checked, permission-checked, audited command before registering `content.tag`.
- several current content creation/draft commands do not accept a durable idempotency key. Add command-level idempotency or a transactional agent-action command ledger before chat can execute them; proposal status alone cannot prevent a duplicate after a crash between the domain commit and receipt commit.

| Action kind | Effect | Confirmation | Authoritative command |
| --- | --- | --- | --- |
| `content.capture` | Create Content Item | Standard | Content create |
| `content.tag` | Add/remove Content Item tags | Standard | Content edit with expected version |
| `content.source.add` | Attach Source Evidence | Standard | Add source |
| `content.research.start` | Queue research | Standard | Start research |
| `content.draft.save` | Create Draft Revision | Standard | Add draft/agent draft |
| `creative.generate` | Queue image generation | Standard; shows cost label | Image generation create |
| `board.task.create` | Create Board Task | Standard | Board task create |
| `board.task.release` | Release ready task to Board agent | Privileged manager/owner | Existing Board release |
| `board.task.review` | Record a human Review decision on completed agent work | Human-only; no default decision | Existing Board task update |
| `board.content.handoff` | Create unapproved Content Item from reviewed result | Privileged manager/owner | Existing Board handoff |
| `content.review.record` | Record a human decision on one exact Draft Revision | Human-only; exact revision/hash | Existing Content approval |
| `publish.target.create` | Schedule/immediately queue an approved draft | Privileged; exact target snapshot | Schedule preflight then schedule |

Read-only searches, list/get operations, channel health checks, and schedule preflight may run automatically. Assistant text is a preview, not a Draft Revision. Agent-authored Approval, a preselected human decision, arbitrary plugin installation, secret access, direct provider publishing, self-review, and automatic retry of uncertain work are forbidden action kinds.

## Hidden Implementation

`AgentConversation` owns orchestration and policy, but not other domain rules:

```text
HTTP Adapter
  → AgentConversation Module
      → scope/permission policy
      → transcript + action ledger
      → Agent Planner Port
      → typed action registry
          → Content Command Adapter
          → Board Command Adapter
          → Creative Command Adapter
          → Channel Readiness Adapter
      → event/outbox transaction

Agent Planner Port
  → General Runtime Adapter, or
  → Board-scoped Hermes Adapter

Outbox workers
  → existing research/image/publish workers
  → existing social-provider Adapters
```

The planner receives a server-built tool catalog based on the actor, scope, specialist preset, and current resource state. Tool results are untrusted data. The planner can request a proposal but cannot invoke the action registry. Only `action.decide` can cross that Seam, and the Module re-authorizes and revalidates the exact proposal immediately before dispatch.

An agent-generated artifact must retain agent-assistance provenance while the action receipt records the confirming human. Human-only decisions such as Approval, Human Release, Board Content Handoff, and Publish Target confirmation execute only after a current human authorization check. As defense in depth, the existing content Approval command should explicitly reject any `actorType` other than `human`, even though current HTTP authentication already supplies a human actor.

### Dependency strategy

- **In-process:** command schemas, scope policy, confirmation classification, action registry, projection builder. Keep these deterministic and test without infrastructure.
- **Local-substitutable:** `AgentConversationRepository`, encrypted transcript store, event ledger, Outbox repository, and run cancellation. Provide PostgreSQL/Redis Adapters plus in-memory test Adapters.
- **Remote but OriginPost-owned:** Content, Board, Creative, Channel, and Analytics commands. Use injected ports over their application Interfaces; never import repositories or connectors directly into the planner.
- **True external:** Hermes/Codex and social providers. Keep the current runtime/provider Adapters. Contract-test and mock them; do not mock the OriginPost-owned policy Module.

This Seam maximizes Locality: authorization, proposal lifecycle, hashes, and event order stay in one Module; Content and Board invariants stay where they already live.

## Runtime and Board isolation

The general Agent and a Board agent are different runtime contexts behind one conversational UX:

- A general Agent Conversation uses an organization-approved Agent Runtime Profile. It can read Brand context and propose actions but has no Board Memory.
- A Board Agent Conversation calls the existing `BoardRuntimePort` with that Board's opaque binding, configuration epoch, capability epoch, sealed skill manifest, and policy attestation.
- Selecting a specialist changes the prompt/tool subset only. It does not select an arbitrary runtime profile, install a skill, or expand a Board's tools.
- A general Agent delegates work to a Board by proposing a Board Task. It does not copy its transcript into the Board or impersonate a Human Release.
- Board output reaches publishing only through the existing Board Content Handoff and Content workflow.

Token-by-token Hermes streaming is not a phase-one requirement. The API can immediately stream durable status events and emit the final assistant message when the current Board Runtime Adapter completes. A later streaming Adapter may improve latency without changing the Module Interface.

## Persistence, privacy, and event delivery

Recommended PostgreSQL records:

- `agent_conversations`: scope, specialist, status, version, owner, timestamps, last sequence.
- `agent_turns`: immutable sequence, role, encrypted content blocks, content hash, run reference.
- `agent_runs`: status/version, participant ID, parent/delegation ID, runtime, model, token/latency metadata, interrupt state, safe error.
- `agent_identities` and `agent_conversation_participants`: scoped identity/version and immutable conversation membership.
- `agent_delegations`: parent/child run IDs, context reference hashes, output contract version, budget/deadline, status, deduplication key.
- `agent_package_projections`: versioned references to authoritative copy, media, review, and delivery records; no duplicated provider state.
- `agent_action_proposals`: kind, encrypted payload, canonical hash, risk, permission, expected resource versions, status/version, expiry.
- `agent_action_receipts`: action reference, outcome, authoritative resource IDs, hashes, safe summary, timestamps.
- `agent_events`: conversation-local monotonic sequence and safe replay projection.

Raw transcript and proposal payloads should use a dedicated application-level encryption key, not a provider or private-message key. Audit events contain IDs, hashes, action kind, actor, and outcome—not message text or hidden model/tool data. Transcript deletion removes encrypted conversational content after retention policy, while immutable domain audits and action receipts remain.

A transaction stores the user turn, Agent Run, event, and outbox command together. Workers claim runs/actions with leases. Idempotency fingerprints reject reuse with different payloads. SSE resumes from a monotonic event sequence; clients deduplicate by event ID. A completed receipt wins over a late worker response.

Interrupting stops only a still-cancellable model run. It cannot roll back committed OriginPost state or cancel a provider request already in flight. External ambiguity becomes `uncertain`, links to reconciliation, and is never retried automatically.

## Design comparison

Three independent mastermind designs were evaluated:

### 1. Minimum Interface

The minimal design uses `submit`, `read`, and `observe`, immutable general/Content/Board lanes, and server-sealed proposals that the browser confirms only by ID, version, and hash. This offers the best Depth and the safest authority Seam. Its main cost is deliberate friction: every new write requires a private typed action and authoritative command mapping.

### 2. Extension-first

The extensible design uses namespaced, schema-versioned action descriptors and construction-time action Adapters. It offers excellent Leverage when many specialists or providers are added and keeps each action's schema, preview, command mapping, receipt, and reconciliation behavior local. Its Board-only conversation proposal is too restrictive for the requested master experience, and a public plugin SDK would be premature. The useful part is an internal, operator-reviewed registry with no runtime `register()` method.

### 3. Caller-first

The caller-first design makes the assistant the default surface, supports general/Board/Content scope, uses strong prompt defaults, and shows exact action, review, and proof cards. It best serves the requested simple UX. Redirecting the product root away from Home would undermine the existing Home goal of explaining the product, while placing full action payloads in browser confirmation requests would leak too much of the Implementation across the Seam.

### Recommended hybrid

Use the minimal three-operation Module, immutable general/Board/Content scope, an internal versioned action registry, and the caller-first page anatomy. Keep Home as the explanatory default, add `/agent` as a primary Work destination, and let context entry points start a scoped conversation there. The browser confirms a sealed card by ID/version/hash; editable fields are submitted to a server validation endpoint that produces a new sealed card before confirmation. Extension points remain behind the Seam and never expose plugin IDs, runtime profiles, credentials, or workflow state machines to the Chat UI.

## Delivery plan

### Phase 0 — domain contract

- Add the vocabulary and invariants to `CONTEXT.md`.
- Add domain types, deterministic transitions, permission matrix, and in-memory repository.
- Define the closed v1 action registry and forbid direct connector access from the Agent Module.

Exit: domain tests prove scope isolation, decision hashing, actor separation, optimistic concurrency, idempotency, and uncertain-state behavior.

### Phase 1 — useful read/write-safe chat

- Add PostgreSQL persistence, encrypted transcript content, outbox run dispatch, REST routes, and resumable SSE.
- Add `/agent`, conversation rail, composer, scope chips, message rendering, stop control, and action cards.
- Support general conversations and `content.capture`, `content.tag`, `content.source.add`, `content.draft.save`, and `board.task.create`.
- Add Home/Board/Content “Ask Agent” entry points that route to the canonical Agent page.

Exit: a user can research/discuss, save a draft, tag content, and create a Board Task without leaving chat; refresh and reconnect preserve the correct conversation.

### Phase 2 — specialist work and governed execution

- Add named coordinator, Research, Writer, Creative/Image, Reviewer, and Publisher presets.
- Add fixed-membership groups, structured mentions/replies, bounded delegation, and shared scoped artifact projections.
- Deliver image plus post text as one Post Package card with incremental completion and revision binding.
- Add Board-bound chat through the internal Hermes Adapter.
- Add `content.research.start`, `creative.generate`, `board.task.release`, `board.task.review`, and `board.content.handoff`.
- Surface approval prerequisites and deep-link to Review.
- Retire or route the current ephemeral Board Work handoff through the governed conversation/Board Task flow so it cannot look like an alternative to Board Task Review and Board Content Handoff.

Exit: each Board remains isolated in a two-Board canary; no general or other-Board conversation can observe its memory, skills, pending writes, or transcript.

### Phase 3 — connected-platform delivery

- Add read-only connected-account selection and readiness/preflight.
- Add the human-only exact Draft Revision review card, while retaining the detailed Review screen.
- Add the exact `publish.target.create` proposal for approved Draft Revisions.
- Stream Publish Attempt status and show Proof of Publish or reconciliation state.

Exit: Instagram, Facebook, and YouTube contract tests show that an Agent Run never calls a connector or records Approval, human-only review cards cannot act without an exact confirmation, uncertainty is never retried automatically, and no different draft/account/settings snapshot can be published.

### Phase 4 — hardening and expansion

- Conversation search/archive/delete and retention controls.
- Accessibility, localization, attachment scanning, quotas, cost controls, observability, and abuse limits.
- Add action kinds only with an owner, schema version, confirmation tier, authoritative command Adapter, receipt projection, and failure/reconciliation contract.

## Test plan

- Domain transition tables for conversations, runs, proposals, decisions, and receipts.
- Role matrix for viewer, creator, manager, owner, worker, and agent actors.
- Cross-Workspace, cross-Brand, and two-Board isolation tests.
- Prompt-injection tests proving source text and model output cannot emit executable commands.
- Architecture test forbidding Agent planner imports from repositories and social connectors.
- Lost-response/idempotency tests for turns and every action kind.
- Stale conversation, proposal, Content Item, Draft Revision, Board, and Connected Account version tests.
- SSE ordering, replay, deduplication, authorization, disconnect/reconnect, and expired-cursor tests.
- Worker lease expiry, cancellation, late completion, and uncertain external result tests.
- End-to-end journeys for research → draft, tag edit, Board task → Human Release → Review → handoff, and approved draft → schedule → proof.
- Mention spoofing, participant eligibility, private-chat leakage, two-Board group isolation, bounded delegation loops, sibling cancellation, and child budget exhaustion tests.
- Post Package tests for copy-ready/image-failed, unsupported image editing, asset revision invalidating review, and exact package-to-draft-to-proof binding.
- Keyboard-only mention selection, screen-reader speaker/status announcements, mobile package review, reduced-motion, long-transcript, slow-network, and empty/error-state usability tests.

## Definition of done

The feature is ready only when the user can complete the principal journeys from `/agent`, every durable or external effect has a visible proposal and receipt, refresh preserves the exact conversation URL, Board memory/skills remain isolated, and all existing Board/content/publishing invariants pass unchanged.

The expanded feature also requires: one-agent and group-chat journeys, correct `@mention` routing, independently attributable child results, a usable image-plus-caption package, and bounded partial-failure recovery. Optional local Codex integration is a separately gated adapter and does not block delivery through the existing product runtimes.
