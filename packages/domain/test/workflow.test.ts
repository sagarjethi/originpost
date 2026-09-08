import { describe, expect, it } from "vitest";
import {
  addReviewComment,
  addExternalReviewComment,
  acknowledgeManualHandoff,
  addSource,
  addDraft,
  attachProof,
  createContentItem,
  createReviewLink,
  completeResearch,
  completeAutomaticPublication,
  confirmManualPublication,
  confirmProviderPublication,
  finishPublishAttempt,
  markResearchRunning,
  markTargetStatus,
  recordApproval,
  rescheduleTarget,
  cancelTarget,
  revokeReviewLink,
  scheduleTarget,
  startPublishAttempt,
  startResearch,
  transition,
  type Actor,
} from "../src/index.js";

const owner: Actor = { id: "owner-1", name: "Owner", role: "owner" };
const creator: Actor = { id: "creator-1", name: "Creator", role: "creator" };
const beforeScheduledPublish = "2026-08-29T09:00:00.000Z";

describe("OriginPost workflow", () => {
  it("moves a sourced item through approval, scheduling, and proof", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "A verified update", actor: creator });
    ({ item } = addSource(item, {
      kind: "url",
      title: "Official announcement",
      url: "https://example.com/source",
      publisher: "Example",
      rights: "reference-only",
      confidence: 95,
    }, creator));
    const drafted = addDraft(item, {
      platform: "instagram",
      format: "image",
      title: "A verified update",
      caption: "Verified caption",
      mediaIds: [],
    }, creator);
    item = drafted.item;
    const approvedDraft = item.drafts.at(-1)!;
    ({ item } = transition(item, "review", creator));
    ({ item } = recordApproval(item, owner, "approved", "Sources checked", approvedDraft.id));
    ({ item } = scheduleTarget(item, owner, {
      platform: "instagram",
      accountId: "ig-1",
      draftId: approvedDraft.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
    }, beforeScheduledPublish));
    ({ item } = attachProof(item, {
      draftId: approvedDraft.id,
      draftSha256: approvedDraft.contentSha256,
      platform: "instagram",
      accountId: "ig-1",
      externalPostId: "mock-123",
      liveUrl: "https://example.com/mock-123",
      publishedAt: "2026-09-01T09:00:01.000Z",
      captionSha256: "a".repeat(64),
      mediaSha256: ["b".repeat(64)],
      connectorResponseSha256: "c".repeat(64),
      approvedBy: owner.id,
      sourceIds: item.sources.map((source) => source.id),
      disclosure: "none",
    }, owner));

    expect(item.status).toBe("published");
    expect(item.proofs).toHaveLength(1);
    expect(item.version).toBe(7);
  });

  it("reschedules a waiting target without mutating its historical record", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Calendar move", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/calendar", rights: "reference-only", confidence: 90 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Calendar move", caption: "Caption", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", undefined, draft.id));
    ({ item } = scheduleTarget(item, owner, { platform: "instagram", accountId: "ig-1", draftId: draft.id, scheduledFor: "2026-09-01T09:00:00.000Z", timezone: "Asia/Kolkata" }, "2026-08-29T09:00:00.000Z"));
    const original = item.targets.at(-1)!;
    const moved = rescheduleTarget(item, original.id, { scheduledFor: "2026-09-02T10:30:00.000Z", timezone: "Europe/London" }, owner, "2026-08-29T09:01:00.000Z");

    expect(moved.target.id).not.toBe(original.id);
    expect(moved.item.targets.find((target) => target.id === original.id)?.status).toBe("cancelled");
    expect(moved.target).toMatchObject({ status: "queued", scheduledFor: "2026-09-02T10:30:00.000Z", timezone: "Europe/London" });
    expect(moved.event.action).toBe("publish.rescheduled");
  });

  it("cancels a waiting target and returns the item to approved", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Cancel post", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/cancel", rights: "reference-only", confidence: 90 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Cancel post", caption: "Caption", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", undefined, draft.id));
    ({ item } = scheduleTarget(item, owner, { platform: "instagram", accountId: "ig-1", draftId: draft.id, scheduledFor: "2026-09-01T09:00:00.000Z" }, "2026-08-29T09:00:00.000Z"));
    const cancelled = cancelTarget(item, item.targets.at(-1)!.id, owner, "2026-08-29T09:01:00.000Z");

    expect(cancelled.item.status).toBe("approved");
    expect(cancelled.item.targets.at(-1)?.status).toBe("cancelled");
  });

  it("increments the content version for every state change", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Version counter", actor: owner });
    expect(item.version).toBe(1);
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/version-counter", rights: "reference-only", confidence: 90 }, owner));
    expect(item.version).toBe(2);
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Version counter", caption: "Caption", mediaIds: [] }, owner));
    expect(item.version).toBe(3);
  });

  it("blocks approval when no source exists", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Unsourced", actor: owner });
    ({ item } = transition(item, "drafting", owner));
    ({ item } = transition(item, "review", owner));
    expect(() => transition(item, "approved", owner)).toThrow("At least one source");
  });

  it("does not allow a creator to approve", () => {
    const { item } = createContentItem({ workspaceId: "ws-1", title: "Draft", actor: creator });
    expect(() => recordApproval(item, creator, "approved")).toThrow("cannot review");
  });

  it("binds approval to one immutable draft revision", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Versioned post", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/versioned", rights: "reference-only", confidence: 90 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "V1", caption: "First", mediaIds: [] }, owner));
    const first = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "V1 approved", first.id));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "V2", caption: "Changed", mediaIds: [] }, owner));
    const second = item.drafts.at(-1)!;

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.contentSha256).not.toBe(second.contentSha256);
    expect(() => scheduleTarget(item, owner, {
      platform: "instagram",
      accountId: "ig-1",
      draftId: second.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
    })).toThrow("must be approved");
  });

  it("stores a traceable sourcing run with sources and supported claims", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Local transport update", actor: creator });
    const queued = startResearch(item, {
      depth: "standard",
      languages: ["English", "Gujarati"],
      region: "Gujarat",
      sourceLimit: 5,
    }, creator, "2026-08-28T10:00:00.000Z");
    item = queued.item;
    ({ item } = markResearchRunning(item, queued.run.id, owner, "2026-08-28T10:00:01.000Z"));
    ({ item } = completeResearch(item, queued.run.id, {
      summary: "The official notice confirms a route change.",
      sources: [{
        kind: "url",
        title: "Official transport notice",
        url: "https://example.com/transport-notice",
        publisher: "Transport Department",
        rights: "reference-only",
        confidence: 96,
        excerpt: "The route changes on Monday.",
        retrievedAt: "2026-08-28T10:00:02.000Z",
      }],
      claims: [{
        text: "The route changes on Monday.",
        status: "supported",
        sourceUrls: ["https://example.com/transport-notice"],
      }],
      provider: "hermes",
      model: "hermes-agent",
      responseId: "resp-1",
      toolsUsed: ["web_search", "web_extract"],
    }, owner, "2026-08-28T10:00:03.000Z"));

    expect(item.researchRuns[0]?.status).toBe("completed");
    expect(item.sources).toHaveLength(1);
    expect(item.claims[0]?.sourceIds).toEqual([item.sources[0]?.id]);
  });

  it("keeps a numbered publish attempt ledger", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Attempt history", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/attempt", rights: "reference-only", confidence: 90 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Post", caption: "Caption", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", undefined, draft.id));
    ({ item } = scheduleTarget(item, owner, { platform: "instagram", accountId: "ig-1", draftId: draft.id, scheduledFor: "2026-09-01T09:00:00.000Z" }, beforeScheduledPublish));
    const target = item.targets.at(-1)!;
    const started = startPublishAttempt(item, target.id, `publish:${target.id}:v1`, owner, "job-1");
    item = started.item;
    ({ item } = finishPublishAttempt(item, started.attempt.id, { status: "failed", error: "Temporary provider error" }, owner));
    const retried = startPublishAttempt(item, target.id, `publish:${target.id}:v1`, owner, "job-2");

    expect(retried.attempt.attemptNo).toBe(2);
    expect(retried.item.publishAttempts.map((attempt) => attempt.status)).toEqual(["failed", "started"]);
  });

  it("commits attempt, target, and immutable proof in one automatic-publication version", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Atomic provider completion", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/atomic", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Atomic provider completion", caption: "Caption", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", undefined, draft.id));
    ({ item } = scheduleTarget(item, owner, { platform: "instagram", accountId: "ig-1", draftId: draft.id, scheduledFor: "2026-09-01T09:00:00.000Z", deliveryMode: "auto_publish" }, beforeScheduledPublish));
    const target = item.targets.at(-1)!;
    const started = startPublishAttempt(item, target.id, `publish:${target.id}:v1`, owner, "job-atomic");
    const beforeVersion = started.item.version;
    const completed = completeAutomaticPublication(started.item, started.attempt.id, target.id, {
      draftId: draft.id, draftSha256: draft.contentSha256, platform: "instagram", accountId: target.accountId,
      externalPostId: "ig-atomic-1", liveUrl: "https://www.instagram.com/p/atomic/", publishedAt: "2026-09-01T09:00:01.000Z",
      captionSha256: "a".repeat(64), mediaSha256: ["b".repeat(64)], connectorResponseSha256: "c".repeat(64),
      approvedBy: owner.id, sourceIds: started.item.sources.map((source) => source.id), disclosure: "none",
    }, owner, "2026-09-01T09:00:02.000Z");

    expect(completed.item.version).toBe(beforeVersion + 1);
    expect(completed.item.publishAttempts.at(-1)).toMatchObject({ status: "published", externalPostId: "ig-atomic-1" });
    expect(completed.item.targets.at(-1)).toMatchObject({ status: "published" });
    expect(completed.item.proofs.at(-1)).toMatchObject({ externalPostId: "ig-atomic-1", draftId: draft.id });
    expect(completed.event.action).toBe("publish.completed");
  });

  it("binds review comments to the exact draft revision and audience", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Review history", actor: creator });
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Review history", caption: "Version one", mediaIds: [] }, creator));
    const draft = item.drafts.at(-1)!;
    const result = addReviewComment(item, owner, { draftId: draft.id, audience: "internal", body: "Check the final number before approval." }, "2026-08-28T10:00:00.000Z");

    expect(result.item.reviewComments[0]).toMatchObject({ draftId: draft.id, draftSha256: draft.contentSha256, audience: "internal", authorId: owner.id });
    expect(result.event).toMatchObject({ action: "review.comment-added", detail: { draftId: draft.id, draftSha256: draft.contentSha256, audience: "internal" } });
  });

  it("delivers and confirms a manual handoff with immutable proof", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Native Instagram post", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/manual", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "reel", title: "Native Instagram post", caption: "Publish this in the native app.", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Ready", draft.id));
    ({ item } = scheduleTarget(item, owner, { platform: "instagram", accountId: "ig-1", draftId: draft.id, scheduledFor: "2026-09-01T09:00:00.000Z", deliveryMode: "manual_handoff", notifyDestinationId: "chat-1" }, beforeScheduledPublish));
    const target = item.targets.at(-1)!;
    ({ item } = markTargetStatus(item, target.id, "action_required", owner));
    ({ item } = acknowledgeManualHandoff(item, target.id, owner));
    ({ item } = confirmManualPublication(item, target.id, { externalPostId: "ig-post-1", liveUrl: "https://www.instagram.com/p/example/", publishedAt: "2026-09-01T09:05:00.000Z", mediaSha256: [], disclosure: "none" }, owner));

    expect(item).toMatchObject({ status: "published" });
    expect(item.targets.at(-1)).toMatchObject({ deliveryMode: "manual_handoff", status: "published", acknowledgedBy: owner.id });
    expect(item.publishAttempts.at(-1)).toMatchObject({ status: "published", idempotencyKey: `manual:${target.id}:v1` });
    expect(item.proofs.at(-1)).toMatchObject({ externalPostId: "ig-post-1", draftId: draft.id, approvedBy: owner.id });
  });

  it("reconciles an uncertain automatic publish without creating a second provider attempt", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Recover provider proof", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/provider", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "Recover provider proof", caption: "Approved caption", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Ready", draft.id));
    ({ item } = scheduleTarget(item, owner, { platform: "instagram", accountId: "ig-1", draftId: draft.id, scheduledFor: "2026-09-01T09:00:00.000Z", deliveryMode: "auto_publish" }, beforeScheduledPublish));
    const target = item.targets.at(-1)!;
    const started = startPublishAttempt(item, target.id, `publish:${target.id}:v1`, owner, "job-1");
    item = started.item;
    ({ item } = markTargetStatus(item, target.id, "action_required", owner));
    ({ item } = confirmProviderPublication(item, target.id, { providerOperationId: "provider-operation-1", externalPostId: "ig-post-2", liveUrl: "https://www.instagram.com/p/recovered/", publishedAt: "2026-09-01T09:05:00.000Z", mediaSha256: [], disclosure: "none" }, owner));

    expect(item.targets.at(-1)).toMatchObject({ deliveryMode: "auto_publish", status: "published" });
    expect(item.publishAttempts).toHaveLength(1);
    expect(item.publishAttempts[0]).toMatchObject({ id: started.attempt.id, status: "published", externalPostId: "ig-post-2" });
    expect(item.proofs.at(-1)).toMatchObject({ externalPostId: "ig-post-2", liveUrl: "https://www.instagram.com/p/recovered/" });
  });

  it("creates, uses, and revokes a review link for one draft hash", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "External review", actor: owner });
    ({ item } = addDraft(item, { platform: "instagram", format: "image", title: "External review", caption: "Exact revision", mediaIds: [] }, owner));
    const draft = item.drafts.at(-1)!;
    const created = createReviewLink(item, owner, { draftId: draft.id, expiresAt: "2026-09-05T10:00:00.000Z", allowComment: true }, "2026-09-01T10:00:00.000Z");
    item = created.item;
    ({ item } = addExternalReviewComment(item, { id: `external:${created.link.id}`, name: "Reviewer", role: "viewer" }, { draftId: draft.id, draftSha256: draft.contentSha256, body: "Please shorten the first line." }, "2026-09-01T10:05:00.000Z"));
    ({ item } = revokeReviewLink(item, owner, created.link.id, "2026-09-01T10:06:00.000Z"));

    expect(created.link).toMatchObject({ draftId: draft.id, draftSha256: draft.contentSha256, allowComment: true });
    expect(item.reviewComments.at(-1)).toMatchObject({ audience: "reviewer", authorName: "Reviewer", draftSha256: draft.contentSha256 });
    expect(item.reviewLinks.at(-1)?.revokedAt).toBe("2026-09-01T10:06:00.000Z");
  });
});
