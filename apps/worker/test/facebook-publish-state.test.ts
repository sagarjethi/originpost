import type { ProviderPublishOperation } from "@originpost/domain";
import { describe, expect, it } from "vitest";
import { facebookIntentMarker, facebookPublishNextStep, isVerifiedFacebookPermalink } from "../src/facebook-publish-state.js";

const operation = (overrides: Partial<ProviderPublishOperation> = {}): ProviderPublishOperation => ({
  id: "operation-1",
  workspaceId: "workspace-1",
  contentItemId: "content-1",
  targetId: "target-1",
  attemptId: "attempt-1",
  platform: "facebook",
  status: "ready",
  containerId: facebookIntentMarker("target-1"),
  childContainerIds: [],
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  ...overrides,
});

describe("Facebook publish recovery state", () => {
  it("creates a durable intent before allowing the provider POST", () => {
    expect(facebookPublishNextStep(null)).toBe("create-intent");
    expect(facebookPublishNextStep(operation())).toBe("create-post");
  });

  it("never repeats a finalizing POST when its response was lost", () => {
    expect(facebookPublishNextStep(operation({ status: "finalizing" }))).toBe("action-required");
    expect(facebookPublishNextStep(operation({ status: "uncertain" }))).toBe("action-required");
  });

  it("uses the saved external ID for read-only verification", () => {
    expect(facebookPublishNextStep(operation({ status: "finalizing", externalPostId: "123_456" }))).toBe("verify-post");
  });

  it("reuses only a complete published result with a verified Facebook permalink", () => {
    expect(facebookPublishNextStep(operation({ status: "published", externalPostId: "123_456", liveUrl: "https://www.facebook.com/123/posts/456" }))).toBe("finish-proof");
    expect(facebookPublishNextStep(operation({ status: "published", externalPostId: "123_456", liveUrl: "https://example.com/not-facebook" }))).toBe("action-required");
  });

  it("accepts Facebook HTTPS hosts and rejects lookalikes", () => {
    expect(isVerifiedFacebookPermalink("https://facebook.com/123/posts/456")).toBe(true);
    expect(isVerifiedFacebookPermalink("https://m.facebook.com/story.php?story_fbid=456&id=123")).toBe(true);
    expect(isVerifiedFacebookPermalink("http://www.facebook.com/123/posts/456")).toBe(false);
    expect(isVerifiedFacebookPermalink("https://facebook.com.example.test/123")).toBe(false);
  });
});
