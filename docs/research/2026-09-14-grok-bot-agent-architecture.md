# Grok Bot architecture research for OriginPost

Researched: 2026-09-14. Scope: public first-party product/API documentation. This describes documented behavior, not a reverse-engineered internal implementation. No services were deployed or accounts connected during this research.

## Which Grok product matches the request?

**Grok Bot is the closest match to “different agents in different groups.”** Its official documentation describes persistent named teammates, group conversations and asynchronous handoffs. This is distinct from the **Grok multi-agent research API**, which runs a team inside one model request. There is no need to reinterpret the user's reference as OpenClaw: the Grok Bot documentation directly supports the requested interaction pattern. “Super bot” is treated here as the user's description, not a verified product name. [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [multi-agent API](https://docs.x.ai/developers/model-capabilities/text/multi-agent).

## Documented product behavior

| Area | What official documentation establishes |
| --- | --- |
| Persistent specialists | Bots have a name, job, conversation and evolving working context. Separate Bots suit distinct ownership, tools, schedules or decision boundaries. Profile descriptions hold durable rules; chat messages supply task instructions. Duplicating a Bot copies configuration but not conversation history or learned memory. [Create and manage Bots](https://docs.x.ai/grok-bot/bots) |
| Groups and routing | Groups contain 2–6 Bots. Users may address one or several with `@`; ordinary messages let participants decide who responds. A Bot can asynchronously message another Bot, which wakes and replies later. Groups expose handoffs; the docs recommend one owner per stage. Group handoffs are currently text-only, so images requiring inspection should go directly to the receiving Bot. [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration) |
| Conversation control | Users can reply to particular messages, attach inputs, and redirect ongoing work. Direct user messages take priority over background work. The transcript includes tool activity, files, questions and approvals. [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration) |
| Execution and context | The account has a persistent shared cloud computer with files, browser sessions and logins. Bots retain separate conversations and learned context. Bots can work concurrently; each has a screen with one computer-use task at a time. [Grok Bot overview](https://docs.x.ai/grok-bot/overview) |
| Artifacts | Images and files appear as conversation cards. Bots can use files in a shared workspace; a final result should remain discoverable in the conversation. Evidence can include sources, timestamps, filenames and action logs. [Files and results](https://docs.x.ai/grok-bot/files-and-results) |
| Reusable work | Skills describe how work is done; routines determine when a Bot runs it. Documentation includes schedules, supported event triggers, recent run inspection and explicit stale/missing-data handling. [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) |

## API architecture is a separate layer

The research API documents a leader synthesizing parallel specialists' findings, configurations of 4 or 16 agents, and server-side search/code/collection tools. It returns leader tool calls and final output; sub-agent state is encrypted when requested. The page says this variant does **not** support client-side/custom tools or Chat Completions; it supports built-in tools and remote MCP. Thus it is not evidence of a public API for creating durable Grok Bot groups. [Multi-agent API](https://docs.x.ai/developers/model-capabilities/text/multi-agent).

The separate image-generation tool lets a conversational model write a prompt, select an aspect ratio, generate/edit through Imagine, and return image plus text. It can combine research and image calls within one request. This directly supports the *design pattern* of an orchestrator calling an image capability; it does not mean OriginPost needs to switch image vendors. [Image-generation tool](https://docs.x.ai/developers/tools/image-generation).

## Unknowns and limits

- The cited product pages do not disclose Grok Bot's queue implementation, database schema, retry protocol, exact model-selection logic or internal agent prompts. Do not present proposed implementation details as Grok internals.
- No public Bot-group management API was established by this research.
- The first-party pages contain Cursor infrastructure/billing references alongside Grok branding. Reported features are based on the pages as retrieved; this note makes no independent claim about corporate ownership, account eligibility or availability for this user.
- An `@Bot` inside Grok Bot's own composer is documented. That does not prove that tagging `@Codex` in OriginPost or arbitrary external chats invokes an agent. OriginPost must implement and test its own mention resolution.
- This research does not establish a built-in Grok Bot workflow for publishing an image-and-caption package to OriginPost Connected Accounts.

## Proposed OriginPost mapping, not claims about Grok

This proposal extends `docs/master-agent-chat.md`. OriginPost's existing scope, review and publication invariants remain authoritative. Grok's shared-computer model is not a reason to weaken Brand or Board isolation.

1. Keep one `/agent` work surface. Let a user mention `@Codex`, `@Research`, `@Writer` or `@Image` as a server-resolved specialist selection inside an Agent Conversation. The name selects behavior and tools, never additional permissions.
2. Add groups as scoped conversation participants with a single current owner. Every participant inherits the same immutable Workspace/Brand/Board/Content scope. Changing membership cannot widen access.
3. Model a handoff as a durable event connecting the originating turn, owning run, receiving specialist, requested output and artifact references. Make handoff failures visible and deduplicate redelivery. Do not pretend text-only summaries give an image reviewer access to the pixels.
4. Treat image generation as a tool-backed capability behind a provider adapter. `Codex Image` is a proposed user-facing alias, not a claim that OpenAI exposes a model by that name. Verify actual provider/model availability before implementation.
5. Return an image and its accompanying post copy as one linked draft package with versioned assets and source lineage. Follow-up edits should update the same package lineage. Generated visuals remain illustrative media, not Source Evidence.
6. Keep the existing typed Agent Action Proposal → human decision → authoritative domain command design. Publishing follows Draft Revision → Approval → Publish Target → Publish Attempt → Proof of Publish; specialists never call social connectors directly.
7. Show artifact previews, current stage/owner, explicit action cards and receipt links. Progress labels should expose useful activity without hidden reasoning or raw tool payloads. Keep uncertain publication outcomes in reconciliation rather than retrying automatically.
8. Treat principal engineer, product engineer, experience expert, data expert and frontend/UI expert as the implementation planning team. Runtime specialists should reflect actual product jobs: research, writing, image creation, review and publishing. A simple request should invoke only the specialists it needs.
9. Extend the existing conversation module and event projection rather than introducing a second chat, a Telegram bot, or a separate workflow engine. Resolve provider identity, specialist identity and durable conversation ownership as separate concerns.

These are design proposals, not implemented capabilities. The current OriginPost module boundaries, data model, access rules and provider integrations must be inspected before implementation estimates are committed.
