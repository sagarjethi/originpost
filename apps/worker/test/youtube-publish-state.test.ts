import { describe, expect, it } from "vitest";
import type { ProviderPublishOperation, PublishTarget } from "@originpost/domain";
import {
  advanceYouTubeProcessingPoll,
  proofDisclosureForTarget,
  YOUTUBE_PROCESSING_MAX_CHECKS,
  YOUTUBE_PROCESSING_TIMEOUT_MS,
  youtubePrivacyMatches,
  youtubePublishNextStep,
} from "../src/youtube-publish-state.js";

function operation(overrides: Partial<ProviderPublishOperation> = {}): ProviderPublishOperation {
  return {
    id: "operation-1",
    workspaceId: "workspace-1",
    contentItemId: "content-1",
    targetId: "target-1",
    attemptId: "attempt-1",
    platform: "youtube",
    status: "ready",
    containerId: "sealed-session",
    childContainerIds: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function target(containsSyntheticMedia = false, privacyStatus: "private" | "unlisted" | "public" = "private"): PublishTarget {
  return {
    id: "target-1",
    platform: "youtube",
    accountId: "youtube-1",
    draftId: "draft-1",
    scheduledFor: "2026-08-29T00:00:00.000Z",
    deliveryMode: "auto_publish",
    status: "publishing",
    settings: {
      title: "Checked Short",
      description: "Checked description",
      privacyStatus,
      madeForKids: false,
      containsSyntheticMedia,
      notifySubscribers: false,
    },
  };
}

describe("YouTube durable publish state", () => {
  it("selects restart-safe steps without reopening a session after a video ID is known", () => {
    expect(youtubePublishNextStep(null)).toBe("create-session");
    expect(youtubePublishNextStep(operation({ status: "finalizing" }))).toBe("query-session");
    expect(youtubePublishNextStep(operation({ status: "ready", uploadedBytes: 10 }))).toBe("upload");
    expect(youtubePublishNextStep(operation({ status: "processing", externalPostId: "video-1" }))).toBe("check-processing");
    expect(youtubePublishNextStep(operation({ status: "published", externalPostId: "video-1" }))).toBe("finish-proof");
    expect(youtubePublishNextStep(operation({ status: "uncertain" }))).toBe("action-required");
  });

  it("persists a bounded processing count and deadline", () => {
    const now = Date.parse("2026-08-29T00:00:00.000Z");
    const first = advanceYouTubeProcessingPoll(operation({ status: "processing", externalPostId: "video-1" }), now);
    expect(first).toMatchObject({ action: "poll", operation: { status: "processing", processingChecks: 1 } });
    expect(first.operation.processingDeadlineAt).toBe(new Date(now + YOUTUBE_PROCESSING_TIMEOUT_MS).toISOString());

    const final = advanceYouTubeProcessingPoll({ ...first.operation, processingChecks: YOUTUBE_PROCESSING_MAX_CHECKS - 1 }, now + 1_000);
    expect(final).toMatchObject({ action: "action-required", operation: { status: "uncertain", processingChecks: YOUTUBE_PROCESSING_MAX_CHECKS } });
    expect(final.operation.lastError).toContain("safety window");
  });

  it("stops polling when the durable deadline expires after a restart", () => {
    const deadline = "2026-08-29T00:30:00.000Z";
    const result = advanceYouTubeProcessingPoll(operation({ status: "processing", externalPostId: "video-1", processingChecks: 4, processingDeadlineAt: deadline }), Date.parse(deadline));
    expect(result).toMatchObject({ action: "action-required", operation: { status: "uncertain", processingChecks: 5, processingDeadlineAt: deadline } });
  });

  it("requires the provider privacy result to match the approved target", () => {
    expect(youtubePrivacyMatches(target(false, "unlisted"), "unlisted")).toBe(true);
    expect(youtubePrivacyMatches(target(false, "unlisted"), "private")).toBe(false);
    expect(youtubePrivacyMatches(target(false, "private"), undefined)).toBe(false);
  });

  it("derives immutable proof disclosure from the approved YouTube declaration", () => {
    expect(proofDisclosureForTarget(target(true))).toBe("synthetic-media");
    expect(proofDisclosureForTarget(target(false))).toBe("none");
    expect(proofDisclosureForTarget({ ...target(false), platform: "instagram", settings: undefined })).toBe("none");
    expect(proofDisclosureForTarget({ ...target(false), platform: "instagram", settings: { collaborators: [], shareToFeed: true, isAiGenerated: true, approvedSettingsSha256: "a".repeat(64) } })).toBe("ai-assisted");
  });
});
