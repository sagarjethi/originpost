import { describe, expect, it } from "vitest";
import { createSafeConnectorRegistry, MockFacebookConnector, MockInstagramConnector, MockYouTubeConnector } from "../src/index.js";

const base = {
  contentItemId: "content-1",
  targetId: "target-1",
  accountId: "account-1",
  caption: "A clear and sourced post.",
  media: [{
    id: "media-1",
    type: "image" as const,
    url: "https://example.com/image.jpg",
    mimeType: "image/jpeg",
    sha256: "a".repeat(64),
    sizeBytes: 1024,
    inspectionStatus: "ready" as const,
    widthPixels: 1080,
    heightPixels: 1350,
    altText: "An example image",
  }],
  idempotencyKey: "publish:target-1:v1",
  settings: {},
};

describe("connector contracts", () => {
  it("publishes idempotently", async () => {
    const connector = new MockInstagramConnector();
    const request = { ...base, platform: "instagram" as const, format: "image" as const };
    const first = await connector.publish(request);
    const second = await connector.publish(request);
    expect(second).toEqual(first);
  });

  it("rejects a format the platform does not support", async () => {
    const connector = new MockYouTubeConnector();
    const issues = await connector.validate({
      ...base,
      platform: "youtube",
      format: "image",
    });
    expect(issues.some((issue) => issue.code === "unsupported_format")).toBe(true);
  });

  it("requires one video for a Reel or Short", async () => {
    const instagram = new MockInstagramConnector();
    const youtube = new MockYouTubeConnector();
    const reelIssues = await instagram.validate({ ...base, platform: "instagram", format: "reel" });
    const shortIssues = await youtube.validate({ ...base, platform: "youtube", format: "short" });
    expect(reelIssues.some((issue) => issue.code === "instagram_reel_video_required")).toBe(true);
    expect(shortIssues.some((issue) => issue.code === "youtube_short_video_required")).toBe(true);
  });

  it("supports an inspected, rights-cleared Story in the safe Instagram mock", async () => {
    const connector = new MockInstagramConnector();
    const request = {
      ...base,
      platform: "instagram" as const,
      format: "story" as const,
      media: [{ ...base.media[0]!, widthPixels: 1080, heightPixels: 1920, rights: "owned" as const }],
    };
    expect(await connector.validate(request)).toEqual([]);
    await expect(connector.publish(request)).resolves.toMatchObject({ status: "published" });
  });

  it("validates Facebook Page text, photo, multi-photo, and Reel shapes", async () => {
    const facebook = new MockFacebookConnector();
    expect(await facebook.validate({ ...base, platform: "facebook", format: "text", media: [] })).toEqual([]);
    expect((await facebook.validate({ ...base, platform: "facebook", format: "image" })).some((issue) => issue.severity === "error")).toBe(false);
    expect((await facebook.validate({ ...base, platform: "facebook", format: "carousel" })).some((issue) => issue.code === "unsupported_format")).toBe(true);
    expect((await facebook.validate({ ...base, platform: "facebook", format: "reel" })).some((issue) => issue.code === "unsupported_format")).toBe(true);
  });

  it("registers safe-test engagement adapters for both supported public-comment platforms", () => {
    const registry = createSafeConnectorRegistry();
    expect(registry.getEngagement("instagram").manifest.platform).toBe("instagram");
    expect(registry.getEngagement("facebook").manifest.platform).toBe("facebook");
  });
});
