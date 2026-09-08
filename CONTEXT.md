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

**Board Plugin**:
A first-party internal module rendered inside a Board. The initial module is `org.originpost.hermes-boards`; it is separate from the discovery-only third-party plugin catalog.
_Avoid_: Global plugin, catalog entry

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
