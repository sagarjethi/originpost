import { describe, expect, it } from "vitest";
import type { ProviderPublishOperation } from "@originpost/domain";
import { hasCompletePublishProof, officialPublishNextStep } from "../src/provider-publish-state.js";

function operation(status: ProviderPublishOperation["status"]): ProviderPublishOperation {
  return { id: "operation-1", workspaceId: "workspace-1", contentItemId: "content-1", targetId: "target-1", attemptId: "attempt-1", platform: "instagram", status, containerId: "container-1", childContainerIds: [], createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
}

describe("official publish recovery state", () => {
  it("creates only when no provider operation exists", () => {
    expect(officialPublishNextStep(null)).toBe("create");
    expect(officialPublishNextStep(operation("processing"))).toBe("wait");
    expect(officialPublishNextStep(operation("ready"))).toBe("finalize");
  });

  it.each(["finalizing", "uncertain"] as const)("never auto-repeats media_publish from %s", (status) => {
    expect(officialPublishNextStep(operation(status))).toBe("manual-reconcile");
  });

  it("never repeats an ambiguous container create intent", () => {
    expect(officialPublishNextStep(operation("creating"))).toBe("manual-reconcile");
  });

  it("finishes local proof work from a saved published result", () => {
    expect(officialPublishNextStep(operation("published"))).toBe("complete");
    expect(officialPublishNextStep(operation("failed"))).toBe("failed");
  });

  it("does not call a target finished until immutable proof exists", () => {
    const target = { id: "target-1", platform: "instagram" as const, accountId: "account-1", draftId: "draft-1", scheduledFor: "2026-08-29T00:00:00.000Z", deliveryMode: "auto_publish" as const, status: "published" as const };
    const draft = { id: "draft-1", revision: 1, contentSha256: "draft-hash", createdBy: "owner-1", createdAt: "2026-08-29T00:00:00.000Z", platform: "instagram" as const, format: "image" as const, title: "Title", caption: "Caption", mediaIds: [] };
    const item = { drafts: [draft], targets: [target], publishAttempts: [{ id: "attempt-1", targetId: target.id, attemptNo: 1, idempotencyKey: "publish:target-1:v1", status: "published" as const, externalPostId: "media-1", startedAt: "2026-08-29T00:00:00.000Z", completedAt: "2026-08-29T00:00:01.000Z" }], proofs: [] } as unknown as import("@originpost/domain").ContentItem;
    expect(hasCompletePublishProof(item, target, draft)).toBe(false);
    item.proofs.push({ id: "proof-1", contentItemId: "content-1", draftId: draft.id, draftSha256: draft.contentSha256, platform: "instagram", accountId: target.accountId, externalPostId: "media-1", liveUrl: "https://www.instagram.com/p/test/", publishedAt: "2026-08-29T00:00:01.000Z", captionSha256: "caption-hash", mediaSha256: [], connectorResponseSha256: "response-hash", approvedBy: "owner-1", sourceIds: [], disclosure: "none" });
    expect(hasCompletePublishProof(item, target, draft)).toBe(true);
  });
});
