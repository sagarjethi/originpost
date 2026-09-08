import type { ContentItem, EngagementAction, EngagementThreadView, EngagementWebhookReceipt } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { executeEngagementReply, findEngagementProof, findReceiptProof, type EngagementWorkerDependencies } from "../src/engagement-worker.js";

const item = {
  id: "content-1",
  proofs: [
    { id: "proof-instagram", platform: "instagram", accountId: "instagram-account", externalPostId: "instagram-media" },
    { id: "proof-facebook", platform: "facebook", accountId: "facebook-account", externalPostId: "facebook-post" },
    { id: "proof-youtube", platform: "youtube", accountId: "youtube-account", externalPostId: "youtube-video" },
  ],
} as ContentItem;

describe("engagement worker platform routing", () => {
  it("routes reconciliation only for Instagram and Facebook proofs", () => {
    expect(findEngagementProof(item, "proof-instagram")?.platform).toBe("instagram");
    expect(findEngagementProof(item, "proof-facebook")?.platform).toBe("facebook");
    expect(findEngagementProof(item, "proof-youtube")).toBeUndefined();
  });

  it("matches a webhook receipt to the exact provider, account, and post", () => {
    const receipt = { provider: "facebook", accountId: "facebook-account" } as Pick<EngagementWebhookReceipt, "provider" | "accountId">;
    expect(findReceiptProof(item, receipt, "facebook-post")?.id).toBe("proof-facebook");
    expect(findReceiptProof(item, receipt, "instagram-media")).toBeUndefined();
    expect(findReceiptProof(item, { provider: "facebook", accountId: "other-account" }, "facebook-post")).toBeUndefined();
  });
});

describe("engagement reply crash windows", () => {
  it("marks provider success with an unpersisted result uncertain and never failed", async () => {
    const action: EngagementAction = {
      id: "action-1", workspaceId: "workspace-1", brandId: "brand-1", threadId: "thread-1", commentId: "comment-1",
      type: "reply", body: "Thanks", bodySha256: "a".repeat(64), status: "queued", idempotencyKey: "reply-1", requestedBy: "creator-1",
      createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", version: 1,
    };
    const processing = { ...action, status: "processing" as const, version: 2 };
    const uncertain = { ...processing, status: "uncertain" as const, version: 3 };
    const view: EngagementThreadView = {
      thread: { id: "thread-1", workspaceId: "workspace-1", brandId: "brand-1", contentItemId: "content-1", proofId: "proof-1", accountId: "account-1", platform: "facebook", externalMediaId: "post-1", state: "open", lastActivityAt: action.createdAt, version: 1 },
      comments: [], actions: [action],
    };
    const transitionAction = vi.fn()
      .mockResolvedValueOnce(processing)
      .mockRejectedValueOnce(new Error("database unavailable after provider success"))
      .mockResolvedValueOnce(uncertain);
    const dependencies = {
      engagementRepository: {
        getAction: vi.fn().mockResolvedValueOnce(action).mockResolvedValueOnce(processing),
        getComment: vi.fn(async () => ({ id: "comment-1", externalCommentId: "external-comment-1" })),
        getThread: vi.fn(async () => view), transitionAction,
      },
      connectedAccountRepository: { get: vi.fn(async () => ({ id: "account-1", brandId: "brand-1", platform: "facebook", externalAccountId: "page-1", capabilities: ["comment_reply"] })) },
      connectors: { getEngagement: vi.fn(() => ({ replyToComment: vi.fn(async () => ({ externalReplyId: "reply-provider-1", createdAt: "2026-08-29T10:02:00.000Z", rawResponse: { id: "reply-provider-1" } })) })) },
    } as unknown as EngagementWorkerDependencies;
    const notify = vi.fn(async () => undefined);

    await expect(executeEngagementReply(dependencies, { name: "execute-action", workspaceId: "workspace-1", brandId: "brand-1", actionId: "action-1" }, notify))
      .resolves.toMatchObject({ status: "uncertain" });
    expect(transitionAction.mock.calls.map(([, command]) => command.to)).toEqual(["processing", "succeeded", "uncertain"]);
    expect(transitionAction.mock.calls.some(([, command]) => command.to === "failed")).toBe(false);
  });
});
