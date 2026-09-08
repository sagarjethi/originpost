import { describe, expect, it } from "vitest";
import { can, engagementBodySha256, engagementPlatforms, InMemoryEngagementRepository, reviseEngagementAction, transitionEngagementAction, type AuditEvent, type EngagementAction, type EngagementComment, type EngagementThread, type EngagementWebhookReceipt } from "../src/index.js";

const scope = { workspaceId: "workspace-1", brandId: "brand-1" };
const now = "2026-08-29T12:00:00.000Z";
const thread: EngagementThread = {
  id: "thread-1", ...scope, contentItemId: "content-1", proofId: "proof-1", accountId: "account-1", platform: "instagram", externalMediaId: "media-1", state: "resolved", lastActivityAt: now, resolvedAt: now, version: 1,
};
const comment = (id: string, body: string, at: string): EngagementComment => ({
  id, ...scope, threadId: thread.id, accountId: thread.accountId, externalMediaId: thread.externalMediaId, externalCommentId: `external-${id}`, authorScopedId: `author-${id}`, authorUsername: `reader_${id}`, body, bodySha256: engagementBodySha256(body), direction: "incoming", visibility: "visible", providerCreatedAt: at, firstSeenAt: at, lastSeenAt: at, source: "reconcile",
});
const event: AuditEvent = { id: "event-1", workspaceId: scope.workspaceId, actorId: "system", actorType: "system", action: "engagement.synced", detail: {}, createdAt: now };
const action: EngagementAction = {
  id: "action-1", ...scope, threadId: thread.id, commentId: "comment-1", type: "reply", body: "Thanks", bodySha256: engagementBodySha256("Thanks"), status: "pending_approval", idempotencyKey: "engagement:reply:action-1:v1", requestedBy: "creator-1", approvedBy: "old-manager", createdAt: now, updatedAt: now, version: 1,
};

describe("engagement domain", () => {
  it("supports public comment threads and webhook receipts for Instagram and Facebook Pages", () => {
    expect(engagementPlatforms).toEqual(["instagram", "facebook"]);
    const facebookThread: EngagementThread = { ...thread, id: "thread-facebook", platform: "facebook", externalMediaId: "page-1_42" };
    const receipt: EngagementWebhookReceipt = {
      id: "receipt-facebook",
      provider: "facebook",
      ...scope,
      accountId: "facebook-page-1",
      payloadSha256: "a".repeat(64),
      normalizedEvent: { field: "feed", item: "comment" },
      status: "pending",
      attempts: 0,
      availableAt: now,
      createdAt: now,
    };

    expect(facebookThread.platform).toBe("facebook");
    expect(receipt.provider).toBe("facebook");
  });

  it("keeps reply sending human-controlled by role", () => {
    expect(can("creator", "engagement:draft")).toBe(true);
    expect(can("creator", "engagement:send")).toBe(false);
    expect(can("manager", "engagement:send")).toBe(true);
    expect(can("viewer", "engagement:read")).toBe(true);
    expect(can("viewer", "engagement:draft")).toBe(false);
  });

  it("invalidates approval and the idempotency key when the exact reply changes", () => {
    const revised = reviseEngagementAction(action, "  Thank you!  ", "creator-2", "2026-08-29T12:01:00.000Z");
    expect(revised).toMatchObject({ body: "Thank you!", status: "draft", requestedBy: "creator-2", approvedBy: undefined, version: 2 });
    expect(revised.bodySha256).not.toBe(action.bodySha256);
    expect(revised.idempotencyKey).toContain(revised.bodySha256);
  });

  it("enforces approval, allowed transitions, and optimistic versions", () => {
    expect(() => transitionEngagementAction(action, { actionId: action.id, expectedVersion: 1, to: "queued", actorId: "manager", at: now })).toThrow("must approve");
    expect(transitionEngagementAction(action, { actionId: action.id, expectedVersion: 1, to: "queued", actorId: "manager", approvedBy: "manager", at: now })).toMatchObject({ status: "queued", approvedBy: "manager", version: 2 });
    expect(() => transitionEngagementAction(action, { actionId: action.id, expectedVersion: 0, to: "cancelled", actorId: "creator", at: now })).toThrow("changed");
    expect(() => transitionEngagementAction({ ...action, status: "succeeded" }, { actionId: action.id, expectedVersion: 1, to: "queued", actorId: "manager", approvedBy: "manager", at: now })).toThrow("cannot move");
  });

  it("clears stale terminal and provider fields before retrying a failed reply", () => {
    const failed: EngagementAction = {
      ...action,
      status: "failed",
      approvedBy: "manager",
      providerReplyId: "stale-provider-id",
      providerResponseSha256: "a".repeat(64),
      errorCode: "provider_failed",
      errorSummary: "Old failure",
      completedAt: "2026-08-29T12:02:00.000Z",
    };
    expect(transitionEngagementAction(failed, { actionId: failed.id, expectedVersion: 1, to: "queued", actorId: "manager-2", approvedBy: "manager-2", at: "2026-08-29T12:03:00.000Z" })).toMatchObject({
      status: "queued",
      approvedBy: "manager-2",
      providerReplyId: undefined,
      providerResponseSha256: undefined,
      errorCode: undefined,
      errorSummary: undefined,
      completedAt: undefined,
      version: 2,
    });
  });

  it("reopens a resolved thread on a new incoming comment without losing assignment", async () => {
    const repository = new InMemoryEngagementRepository();
    const first = comment("comment-1", "First", "2026-08-29T12:00:00.000Z");
    const assigned = { ...thread, assignedTo: "manager-1" };
    await repository.ingest(scope, { thread: assigned, comments: [first], syncedAt: now }, event);
    const second = comment("comment-2", "New question", "2026-08-29T12:05:00.000Z");
    const result = await repository.ingest(scope, { thread: assigned, comments: [first, second], syncedAt: "2026-08-29T12:06:00.000Z" }, { ...event, id: "event-2" });
    expect(result).toMatchObject({ inserted: 1, updated: 1, reopened: true, thread: { state: "open", assignedTo: "manager-1", resolvedAt: undefined, version: 2 } });
  });

  it("keeps inbox reads isolated per person and rejects cross-brand access", async () => {
    const repository = new InMemoryEngagementRepository();
    const first = comment("comment-1", "Hello", now);
    await repository.ingest(scope, { thread: { ...thread, state: "open", resolvedAt: undefined }, comments: [first], syncedAt: now }, event);
    expect((await repository.listThreads(scope, { viewerId: "viewer-1" })).items[0]?.unreadCount).toBe(1);
    await repository.markRead(scope, thread.id, "viewer-1", { lastReadAt: now, lastReadCommentId: first.id });
    expect((await repository.listThreads(scope, { viewerId: "viewer-1" })).items[0]?.unreadCount).toBe(0);
    expect((await repository.listThreads(scope, { viewerId: "viewer-2" })).items[0]?.unreadCount).toBe(1);
    expect(await repository.getThread({ ...scope, brandId: "brand-2" }, thread.id)).toBeNull();
  });
});
