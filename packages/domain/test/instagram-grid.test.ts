import { describe, expect, it } from "vitest";
import { projectInstagramGrid, type ContentItem } from "../src/index.js";

const now = "2026-09-01T10:00:00.000Z";

function item(): ContentItem {
  return {
    id: "grid-content", workspaceId: "workspace", brandId: "brand", version: 4, title: "Mumbai launch", summary: "", status: "scheduled", researchDepth: "quick", riskLevel: "low", tags: [], sources: [], claims: [], researchRuns: [], approvals: [], reviewComments: [], reviewLinks: [], publishAttempts: [], createdBy: "owner", createdAt: now, updatedAt: now,
    drafts: [
      { id: "image-draft", revision: 1, contentSha256: "a".repeat(64), createdBy: "owner", createdAt: now, platform: "instagram", format: "image", title: "Image", caption: "Image caption", mediaIds: ["image-media"] },
      { id: "reel-draft", revision: 1, contentSha256: "b".repeat(64), createdBy: "owner", createdAt: now, platform: "instagram", format: "reel", title: "Reel", caption: "Reel caption", mediaIds: ["video-media"] },
      { id: "story-draft", revision: 1, contentSha256: "c".repeat(64), createdBy: "owner", createdAt: now, platform: "instagram", format: "story", title: "Story", caption: "Internal", mediaIds: ["story-media"] },
    ],
    targets: [
      { id: "image-target", platform: "instagram", accountId: "instagram-account", draftId: "image-draft", scheduledFor: "2026-09-03T10:00:00.000Z", deliveryMode: "auto_publish", status: "queued" },
      { id: "reel-target", platform: "instagram", accountId: "instagram-account", draftId: "reel-draft", scheduledFor: "2026-09-04T10:00:00.000Z", deliveryMode: "auto_publish", status: "queued", settings: { collaborators: [], shareToFeed: false, approvedSettingsSha256: "d".repeat(64) } },
      { id: "story-target", platform: "instagram", accountId: "instagram-account", draftId: "story-draft", scheduledFor: "2026-09-05T10:00:00.000Z", deliveryMode: "auto_publish", status: "queued" },
    ],
    proofs: [],
  };
}

describe("Instagram grid projection", () => {
  it("projects only profile-visible OriginPost targets", () => {
    expect(projectInstagramGrid([item()], "instagram-account")).toEqual([
      expect.objectContaining({ targetId: "image-target", format: "image", previewMediaId: "image-media", proofState: "not_yet_published" }),
    ]);
  });

  it("uses exact custom Reel cover evidence and verified publication time", () => {
    const base = item();
    const reel = base.targets[1]!;
    reel.status = "published";
    reel.settings = { collaborators: [], shareToFeed: true, reelCover: { mode: "custom_image", mediaId: "cover-media", mediaSha256: "e".repeat(64) }, approvedSettingsSha256: "f".repeat(64) };
    base.proofs.push({ id: "proof", contentItemId: base.id, draftId: "reel-draft", draftSha256: "b".repeat(64), platform: "instagram", accountId: "instagram-account", externalPostId: "post", liveUrl: "https://www.instagram.com/reel/example/", publishedAt: "2026-09-02T12:00:00.000Z", captionSha256: "1".repeat(64), mediaSha256: [], connectorResponseSha256: "2".repeat(64), approvedBy: "owner", sourceIds: [], disclosure: "none" });
    const result = projectInstagramGrid([base], "instagram-account");
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: "reel-target", previewMediaId: "cover-media", proofId: "proof", proofState: "verified", effectiveAt: "2026-09-02T12:00:00.000Z" })]));
  });
});

