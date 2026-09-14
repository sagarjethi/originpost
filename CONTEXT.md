# OriginPost Domain

OriginPost keeps the language for turning source material into approved social content with a permanent publication record.

## Language

**Workspace**:
A private area for one team and its brands, people, connected accounts, policies, and content.
_Avoid_: Tenant, organization

**Brand**:
A publishing identity inside a Workspace with its own voice, accounts, rules, and memory.
_Avoid_: Customer, channel

**Board**:
A top-level, Brand-owned working area for one durable agent context. A Board is not a Workspace, Brand, Content Item, or generic project.
_Avoid_: Profile, bot, global memory

**Board Task**:
A durable work card owned by exactly one Board. OriginPost owns its lifecycle, dependencies, comments, permissions, and audit record; an internal runtime may execute approved work but never owns the task.
_Avoid_: Hermes task, plugin task, Content Item

**Board Task Execution**:
One durable attempt to perform a human-released Board Task against its current approved Board context. Its result can enter Board Task Review but cannot approve, publish, or become a Content Item by itself.
_Avoid_: Retry, autonomous job, publish attempt

**Human Release**:
A manager or owner decision that authorizes one Board Task Execution against the Board's current approved context.
_Avoid_: Auto-run, assignment, approval

**Board Execution Receipt**:
The durable evidence for one Board Task Execution, including its outcome and either reviewable output or a safe failure reason. It is not a Proof of Publish.
_Avoid_: Approval, publication proof, agent decision

**Board Task Review**:
The human-only state in which a successful Board-agent result is inspected before a manager or owner may mark the Board Task done.
_Avoid_: Agent approval, automatic completion

**Board Content Handoff**:
A manager- or owner-initiated copy of the current successful Board Task Review result into one normal, unapproved Content Inbox item, with durable task, execution, and result-hash provenance. It creates no Draft Revision, Approval, Publish Target, Publish Attempt, or Proof of Publish.
_Avoid_: Automatic content creation, approval, publish action

**Board Plugin**:
A first-party internal module rendered inside a Board. The initial module is `org.originpost.hermes-boards`; it is separate from the discovery-only third-party plugin catalog.
_Avoid_: Global plugin, catalog entry

**Board Kanban Binding**:
The private one-to-one association between a Board and its agent work queue. It is isolated per Board and is never shared or global.
_Avoid_: Shared queue, global Kanban, user-facing Board ID

**Board Memory**:
Working context isolated to one Board's dedicated runtime profile. It may guide future work but is never Source Evidence or publication authority.
_Avoid_: Brand guidance, source, fact

**Board Skill Grant**:
An owner-approved desired capability selected from operator-reviewed, preinstalled skills for one Board. Applied state is observed separately through reconciliation.
_Avoid_: Skill install, prompt permission

**Organization Context**:
The active Workspace and Brand used for every content, media, monitoring, channel, scheduling, and reporting action.
_Avoid_: Tenant selector, UI filter

**Workspace Invitation**:
An owner-created, expiring, one-time grant bound to one Workspace, normalized email address, and role. The raw link is manually delivered and is not a Review Link.
_Avoid_: Member record, email delivery, public signup

**Content Item**:
The complete record that connects an idea or signal to its sources, claims, drafts, decisions, publishing results, and proof.
_Avoid_: Post, job, task

**Source Evidence**:
Material captured to support research or a claim, together with its origin, date, confidence, rights state, and integrity data.
_Avoid_: Attachment, reference

**Claim**:
A statement considered for publication whose support or dispute is linked to Source Evidence.
_Avoid_: Fact

**Draft Revision**:
An immutable version of platform-ready text and media prepared from a Content Item.
_Avoid_: Copy, post draft

**Generated Visual Foundation**:
A one-shot, clearly creative image produced inside Creative Studio for deterministic finishing. It is a Library asset with immutable AI lineage, not Source Evidence or documentary proof.
_Avoid_: AI evidence, finished post, generated fact

**Synthetic Media Lineage**:
The non-optional generation identity, model, prompt hash, time, linked source IDs, and disclosure requirement carried from a Generated Visual Foundation through Creative Studio output, Draft Revision, and Proof of Publish.
_Avoid_: User checkbox, visual note, optional metadata

**Approval**:
A recorded human decision about one exact Draft Revision.
_Avoid_: Review status, sign-off

**Review Link**:
An expiring, revocable invitation that exposes one exact Draft Revision and its permitted reviewer comments.
_Avoid_: Public draft, shared workspace

**Publish Target**:
The instruction to publish one Draft Revision to one connected account at a chosen time.
_Avoid_: Scheduled post

**Manual Handoff**:
A Publish Target delivery mode that pauses when due so a permitted operator can post in the platform's native app and return the live result.
_Avoid_: Manual job, untracked post

**Publish Attempt**:
One connector request and its result for a Publish Target.
_Avoid_: Retry, job

**Proof of Publish**:
The permanent record connecting the approved revision, sources, platform result, hashes, time, account, and live location.
_Avoid_: Receipt, screenshot

**Signal**:
A monitored item that may become a Content Item after a person or rule accepts it.
_Avoid_: News, suggestion

**Memory**:
Approved Brand knowledge used to guide future research and creation without changing historical Content Items.
_Avoid_: Training data, notes
