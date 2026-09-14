# Hermes/OriginPost demand and gap audit

**Date:** 2026-09-13  
**Status:** Primary-source research and implementation decision  
**Current Hermes release inspected:** `v2026.9.11` / Hermes `0.21.2`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`  
**OriginPost baseline:** pre-implementation worktree inspected on 2026-09-13

## Implementation outcome

The release blocker and highest-priority feature identified in this audit were implemented after the research was completed. The decision analysis and comparison tables below intentionally preserve the inspected pre-implementation baseline:

- OriginPost now pins and re-attests Hermes `0.21.2` at commit `939e45c91d751fadd94dcd1b873ac3cb44846213`.
- Every Board has an opaque, immutable Kanban binding in addition to its dedicated Profile, memory boundary, and approved skill policy.
- A manager or owner can release an exact ready Board-agent task version into a durable, single-attempt execution. PostgreSQL remains the source of truth; the worker and hidden Hermes extension fence the Board, task, policy epochs, tool/skill digests, and execution receipt.
- A confirmed result returns the task to independent human review. Failure or ambiguous completion blocks it for inspection; neither condition is retried automatically.
- From Review, a manager or owner can deliberately create one normal, unapproved Content Inbox item. The atomic, idempotent handoff records the exact task, execution, result hash, and Content Item identity without creating any draft, approval, schedule, publish attempt, or proof.
- The execution path has no authority to approve content, schedule, publish, manage accounts, or approve memory/skill changes.

The remaining native-Hermes Kanban synchronization idea was audited against the pinned source and intentionally not enabled. Hermes 0.21.2 has no passive externally-owned card state, has process-global path overrides that can supersede an explicit Board path, and its normal states can trigger dispatch, decomposition, review work, or orphan recovery. OriginPost therefore keeps its PostgreSQL task ledger and Profile-local receipt authoritative until the upstream adapter contract documented in [Boards](../boards.md#hermes-0212-native-kanban-audit) exists.

## Decision

At the audit baseline, the single highest-value feature missing from OriginPost was **governed automatic Board-task execution with durable per-attempt receipts**.

OriginPost already had a top-level Board, Board-scoped memory and skills, an internal Hermes plugin, durable human tasks, source monitoring, publish approvals/proofs, and a one-shot ChatGPT image-foundation workflow. At that baseline, choosing `assignee = "board-agent"` was rejected as “planned but not available yet,” so a task could not move from a human release through an agent run and back to independent review. The implementation outcome above records how that gap was closed.

The target loop should be:

```text
Board task draft
  -> human release of an exact version and capability envelope
  -> durable execution command
  -> server-pinned Board/Profile worker attempt
  -> fenced result + evidence receipt
  -> independent human review
  -> optional deliberate handoff to the Content Inbox
```

This is not permission for an agent to publish. Agent execution ends at a reviewable Board result. OriginPost's existing content approval, scheduling, provider execution, and Proof of Publish remain separate authorities.

Hermes already has substantial Kanban execution receipts—attempt rows, summaries, structured metadata, attachments, review transitions, terminal events, and run inspection. The missing work is the **OriginPost control-plane bridge** that releases an exact OriginPost task, projects it into that execution substrate, imports a fenced receipt, and keeps provider publication proof separate. Do not rebuild the Hermes run kernel or treat its `done` flag as an OriginPost approval. [Kanban guide at 0.21.2](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/features/kanban.md), [Hermes verification subsystem PR #80686](https://github.com/NousResearch/hermes-agent/pull/80686)

## Evidence method

The supplied [Reddit post](https://www.reddit.com/r/AISEOInsider/comments/1w613ei/hermes_agent_latest_version_0210_is_actually/) is treated only as secondary demand context. Its useful themes are specialized agents with separate roles/memory/skills, agent-to-agent handoffs, scheduled continuity, browser work, and human safety controls. Product and implementation claims below are traced to official Hermes releases, tagged source/documentation, the official repository's issue tracker, or provider documentation.

Evidence labels:

- **Verified:** confirmed in a tagged official release, tagged repository documentation/source, provider documentation, or the OriginPost worktree.
- **Reported:** an open or closed issue in the official Hermes repository; the report shows demand or risk, not necessarily a reproduced upstream defect.
- **Inference:** a product or architectural conclusion drawn from verified facts.
- **Recommendation:** work proposed for OriginPost.

GitHub Discussions are not enabled for `NousResearch/hermes-agent` as of the research date, so the official issue tracker, pull requests, tagged documentation, and releases are the relevant first-party GitHub surfaces.

## Audit baseline: do not build the next slice on 0.21.1

**Verified at the audit baseline.** OriginPost pinned Hermes `0.21.1` / `v2026.9.7` at commit `2237be355906fbe6065ce1815711eee52b2d646e`. The then-current upstream release was `0.21.2` / `v2026.9.11`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`. [OriginPost Board policy](../boards.md#first-release-policy), [Hermes 0.21.1 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.7), [Hermes 0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11)

**Verified.** The 0.21.2 release is directly relevant to one-Profile-per-Board deployments. It fixes concurrent `state.db` writers, wrong-profile database binding/search, inherited default-profile allow-lists, cross-profile credential/tool routing, cross-profile `MEDIA:` file delivery, and sibling credential memo leakage. It also fixes Kanban dependency promotion and reviewer-profile validation and adds a curated SHA-pinned plugin catalog. [Hermes 0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11)

**Recommendation — release blocker.** Re-pin, re-vendor, and re-attest the hidden OriginPost extension against exactly `v2026.9.11` before enabling automated Board work. Repeat the existing clean-tree/source-hash checks and two-Board isolation canary. This is a prerequisite, not the missing user-facing feature itself.

## Demand themes and OriginPost coverage

| Theme | Primary-source signal | OriginPost status | Decision |
|---|---|---|---|
| Separate agents with durable context | Hermes 0.21.0 introduced Bot Mode, durable peer handoffs, and cron continuity. Tagged Profiles documentation says each Profile owns config, API keys, memory, sessions, skills, cron, and state. [0.21.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31), [Profiles guide at 0.21.2](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/profiles.md) | Implemented as one opaque dedicated Profile per OriginPost Board. | Keep Board as the top-level product object; Hermes stays internal. |
| Board-scoped task execution | Hermes Kanban is a durable multi-Profile work queue with task dependencies, atomic claims, worker runs, comments, review, heartbeats, retries, attachments, and Board-pinned workers. [Kanban guide at 0.21.2](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/features/kanban.md) | Human task storage, transitions, dependencies, comments, and distinct completion review exist. The Board-agent assignee is deliberately rejected. | **Highest missing feature:** add the controlled execution/receipt bridge. |
| Memory/skill isolation | Tagged Profiles docs call `HERMES_HOME` the state boundary but explicitly warn that a Profile is not an OS/filesystem sandbox. 0.21.2 fixes several cross-profile runtime leaks. [Profiles guide](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/profiles.md), [0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11) | Dedicated Profile, empty process home, source/tool/skill attestation, no external skill discovery, and Board-local policy are implemented. | Preserve this boundary and upgrade to 0.21.2; never rely on Profile naming alone as authority. |
| Safe memory/skill writes | Hermes 0.21.0 made protected instruction files approval-gated. Issue #70488 records demand for a memory pre-write classification gate; issue #105759 reports a Desktop routing gap that can strand skill approvals. [0.21.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31), [#70488](https://github.com/NousResearch/hermes-agent/issues/70488), [#105759](https://github.com/NousResearch/hermes-agent/issues/105759) | Exact pending-write preview/approve/reject is implemented inside the Board owner surface. | Do not proxy the upstream Desktop UI. Keep approval as an OriginPost-owned internal-plugin flow. |
| Skill use during delegated/scheduled work | Cron attaches explicit skills and validates them before dispatch. Open issue #18963 asks for equivalent explicit skills on `delegate_task`; #66508 asks for a required memory/skill prelude. [Cron guide](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/features/cron.md), [#18963](https://github.com/NousResearch/hermes-agent/issues/18963), [#66508](https://github.com/NousResearch/hermes-agent/issues/66508) | Board skill manifests are owner-approved and attested, but there is no task execution to consume them. | Bind the exact enabled-skill digest into every released task attempt; do not inherit an ambient or mutable set. |
| Durable skill learning after workers | Open issue #109375 reports that short-lived Kanban workers can reset background-review eligibility and may exit before a detached skill review settles. [#109375](https://github.com/NousResearch/hermes-agent/issues/109375) | Pending memory/skill governance exists, but task execution does not. | An execution receipt must not claim that background learning completed. Track any memory/skill proposal as a separate, observable outcome. |
| Plugin boundary and management | Hermes 0.21.2 adds a curated SHA-pinned plugin index. The official contribution rules say third-party product integrations should be standalone plugins and should not modify core; new capability should prefer CLI/skill/plugin seams before a new core tool. Agent-plugin state is Profile-routed while a desktop plugin half remains app-level. [0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11), [tagged `AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/AGENTS.md), [plugin-management PR #107314](https://github.com/NousResearch/hermes-agent/pull/107314) | Hermes is a reserved first-party internal Board module, not a top-level catalog item. | Current placement is correct. Keep one internal integration package with explicit per-Board/Profile grants; do not model each Board as installing a desktop plugin. |
| Scheduled discovery without repetition | Hermes 0.21.0 added persistent-memory cron and continuity. Tagged cron docs persist attempts before dispatch, expose immutable terminal states, use continuity for dedupe, and distinguish queued delivery from completed delivery. [0.21.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31), [Cron guide](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/features/cron.md) | OriginPost monitors have PostgreSQL truth, deduped source fingerprints, recoverable scheduling, Source Signal review, and the bounded Luma Mumbai adapter. | Product behavior is present. More live source coverage is provider/configuration work, not a reason to bypass the inbox review boundary. |
| Proof-backed execution | Open issue #91230 proposes that work is complete only when the requested state is verified on the exact authoritative object. Open issue #82591 asks for zero-authority Kanban workers and durable publication; #95362 warns against treating agent-authored task context as authority. [#91230](https://github.com/NousResearch/hermes-agent/issues/91230), [#82591](https://github.com/NousResearch/hermes-agent/issues/82591), [#95362](https://github.com/NousResearch/hermes-agent/issues/95362) | Social publishing already has immutable approval, attempt, reconciliation, and proof records. Board tasks currently accept a human result summary but have no agent attempt receipt. | Reuse the same proof vocabulary for Board execution; agent prose alone is not completion proof. |
| Social publishing reliability | Google documents resumable YouTube uploads, server status queries, `308 Resume Incomplete`, and exact returned video IDs. Meta publishes the supported Instagram publishing contract through its official API collection. [YouTube resumable upload](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [YouTube processing status](https://developers.google.com/youtube/v3/guides/implementation/videos), [Meta Instagram API collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login) | Durable provider operations, uncertain-state pause, exact read-back proof, and manual handoff already exist. Real provider credentials/review/canaries remain deployment gates. | Do not delegate provider writes to a Board agent. No repo feature can substitute for owned-account certification. |
| Creative/image workflow | Hermes 0.21.2 includes GPT Image 2.5 via OpenAI/FAL; open issue #13798 asks for generic OpenAI-compatible image endpoints. OpenAI says the Image API is best for one image from one prompt, while the Responses API is for conversational editing, and warns that exact text placement, clarity, consistency, and composition can still fail. [0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11), [Hermes PR #105988](https://github.com/NousResearch/hermes-agent/pull/105988), [Hermes issue #13798](https://github.com/NousResearch/hermes-agent/issues/13798), [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) | One-shot generation, durable paid-call state, prompt hash, synthetic lineage, deterministic exact-text finish, and disclosure checks are implemented. Conversational editing is truthfully excluded. | Current slice matches the official one-shot API. Iterative editing is a later enhancement, below Board execution in priority. |

## Why Board execution wins the priority comparison

### It closes an actual broken product journey

The Board Help journey promises task creation, triage, work, review, and continuation, but its Work step says a team member performs the task today and automatic Hermes execution is planned. The domain accepts `board-agent` in the type while rejecting it at creation and update. This is stronger evidence of a missing feature than an unavailable deployment credential or a future image-editing mode.

### It uses architecture already paid for

OriginPost already has:

- Board/Brand/Workspace scoping and role checks;
- immutable Board/Profile binding and capability epochs;
- owner-approved skill policy and pending-write review;
- live pre-run and post-run tool/skill/source attestation;
- a killable one-shot Hermes process;
- a hash-only Board run ledger;
- PostgreSQL audit/outbox and BullMQ recovery patterns;
- durable Board tasks with optimistic locking, dependencies, comments, and distinct human completion review; and
- a deliberate Board-result-to-Content-Inbox handoff.

The next feature is therefore a deep seam between two existing modules, not a new top-level product area.

### It is the common dependency for several reported requests

A governed attempt record can also answer per-task cost/usage demand ([#107744](https://github.com/NousResearch/hermes-agent/issues/107744)), lifecycle observability demand ([#67798](https://github.com/NousResearch/hermes-agent/issues/67798)), exact-object completion demand ([#91230](https://github.com/NousResearch/hermes-agent/issues/91230)), and explicit task skill binding demand ([#18963](https://github.com/NousResearch/hermes-agent/issues/18963)). Building isolated UI controls for those issues before a real attempt lifecycle would create disconnected metadata rather than a working loop.

## Required feature shape

### Product command

Add an explicit **Release to Board agent** command; do not start an agent because a card was dragged to `ready` or because `assignee` changed.

The command must require:

1. a human actor with the existing content-create permission;
2. exact task `version` / `If-Match`;
3. `status = ready`, `assignee = board-agent`, and completed dependencies;
4. a ready, non-archived Board with current configuration and capability epochs;
5. an exact release snapshot hash over task specification, Board purpose, approved skill manifest, tool manifest, model/provider policy, source references, and completion contract; and
6. an idempotency key unique within the Board task.

### Durable records

Introduce a Board-owned `AgentBoardTaskAttempt` rather than overloading the generic Board chat ledger. Minimum fields:

- OriginPost attempt ID, task ID, Board ID, Brand ID, Workspace ID;
- task version and release-snapshot SHA-256;
- configuration/capability epochs and sealed skill/tool manifest hashes;
- attempt number, idempotency hash, state, lease owner/expiry, and retry count;
- requested/start/heartbeat/settled timestamps;
- normalized outcome: `review`, `needs_input`, `failed`, `uncertain`, or `cancelled`;
- result/evidence digest, bounded sanitized summary, declared deliverables, and verification status;
- model/provider identity plus input/output token and cost measurements when supplied; and
- sanitized remote receipt identifiers, never raw Profile names, filesystem paths, prompts, credentials, or provider bodies.

Persist the attempt and a new task-execution outbox message atomically. Redis is delivery state, not truth.

### Execution boundary

The worker must derive Profile, Board, model, skills, tools, and task identity only from current server records. Queue payloads and agent-authored comments cannot widen authority.

Before inference it must re-check:

- task version/state/assignee/dependencies;
- Board archive state and both epochs;
- current Profile binding/credential and Hermes source pin;
- exact skill tree, tool registry, handler provenance, and runtime health; and
- the release-snapshot hash.

Claim with compare-and-set, create one attempt, and pass the task specification as an untrusted work order under a server-authored system envelope. Issue #95362 is particularly relevant: task identity/lifecycle facts may be authoritative, while parent summaries, comments, and other agent-authored text are context, not permission.

### Settlement and recovery

An agent cannot mark its own work `done`. A successful worker result moves the task to `review` and records the implementer as the agent attempt, not as the later approver. Only a distinct authorized manager/owner can accept the exact result version.

Settlement must be fenced against task, Board, configuration, capability, and lease generations. A stale result is retained as a historical attempt but cannot become the current result. Timeouts or ambiguous worker loss become `uncertain`/`needs_input`; they are inspected before a new attempt is authorized. The worker must never blindly replay a task that could have caused an external effect.

For the first automated slice, exclude provider publishing, account management, memory/skill approval, arbitrary plugin installation, and direct Content approval. A reviewed Board result may be deliberately copied into a new unapproved Content Item through the existing handoff.

### Observable evidence

The Board task detail should show:

- who released the exact task version and when;
- skill/tool/model envelope names plus hashes;
- attempt state, duration, token/cost data, and bounded progress;
- result summary and declared evidence/deliverables;
- whether evidence was verified against its authoritative target;
- why an attempt failed or became uncertain; and
- the distinct reviewer decision.

Do not display raw Hermes Profile names, subprocess IDs, absolute paths, claims, prompts, responses, or provider credentials.

### Upstream caveats that must become tests

1. **Profile is not a filesystem sandbox.** Run the task in the existing empty-home/killable-process boundary and keep unsafe tools denied unless a separately reviewed capability is necessary. [Profiles guide](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/profiles.md)
2. **Upgrade first.** Verify no Board can inherit another/default Profile's allow-list, state database, connector host, credential, or media path under 0.21.2. [0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11)
3. **Board selection is hard authority.** Every task command and event cursor must be server-pinned to one opaque Board; do not accept a Hermes Board slug from the browser. [Kanban guide](https://github.com/NousResearch/hermes-agent/blob/v2026.9.11/website/docs/user-guide/features/kanban.md)
4. **Completion is exact-object verification.** Prove the claimed file/source/content state, not merely that a process returned success. [#91230](https://github.com/NousResearch/hermes-agent/issues/91230)
5. **Agent text is not authority.** Parent results, comments, previous summaries, and task-body additions cannot grant capabilities or redefine the approval policy. [#95362](https://github.com/NousResearch/hermes-agent/issues/95362)
6. **Background learning is separately settled.** Task success cannot imply that a detached memory/skill review completed. [#109375](https://github.com/NousResearch/hermes-agent/issues/109375)
7. **Cost belongs to the attempt.** Aggregate usage by task/attempt/Profile without exposing raw provider state. [#107744](https://github.com/NousResearch/hermes-agent/issues/107744)

## Prioritized backlog after this feature

1. **Required prerequisite:** re-pin and re-attest Hermes 0.21.2, then run cross-Board isolation and crash/recovery canaries.
2. **Highest product feature:** governed Board-agent task execution and durable receipts as specified above.
3. **Same feature's second increment:** bounded agent planning/decomposition that creates task proposals only; a human must accept/release them.
4. **Same feature's third increment:** task-level token/cost budgets, stop/steer, heartbeat, evidence attachments, and resumable progress.
5. **Deployment certification:** watched owned-account social publishing and reconciliation canaries; this is operator/provider work, not safe to simulate as complete.
6. **Source breadth:** add official or contract-tested public source adapters through the existing Source Signal queue.
7. **Creative enhancement:** conversational image editing through the Responses API, preserving the same source lineage, paid-call idempotency, deterministic brand finish, and disclosure gates.

## Explicit non-recommendations

- Do not add Hermes as a new top-level navigation item.
- Do not make Board a plugin; Board remains the top-level user-owned object.
- Do not expose the Hermes dashboard, Profile identifiers, raw memory/skill files, arbitrary plugin catalog, browser, terminal, MCP, cron, or social account tools to the web client.
- Do not equate a Hermes/Kanban `done` state with OriginPost approval or Proof of Publish.
- Do not allow agents to approve memory/skill changes, their own task result, a Content draft, or a social post.
- Do not enable official social publishing merely because code paths and mock tests pass.
- Do not report a generated visual as documentary evidence or rely on generated text/logo fidelity when deterministic composition is available.

## Bottom line

The community demand is not for another settings page. It is for specialized agents that remember, use the right skills, perform scheduled or delegated work, hand results to each other, and remain governable. OriginPost has already built most of the governance and content pipeline. The next aligned implementation is the missing **Release → Agent attempt → Receipt → Independent review** loop inside each Board, preceded by an exact upgrade and re-attestation to Hermes 0.21.2.
