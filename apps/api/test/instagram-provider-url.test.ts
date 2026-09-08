import { describe, expect, it } from "vitest";
import { assertInstagramProviderUrl } from "../src/content/instagram-provider-url.js";

describe("Instagram provider proof URLs", () => {
  it("accepts only the canonical route family for each draft format", () => {
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/p/AbC_123/", "image", "provider-id")).not.toThrow();
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/p/AbC_123/", "carousel", "provider-id")).not.toThrow();
    expect(() => assertInstagramProviderUrl("https://instagram.com/reel/Reel-123", "reel", "provider-id")).not.toThrow();
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/stories/samplepublisher/987654321/", "story", "987654321")).not.toThrow();
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/stories/samplepublisher/987654321/", "image", "provider-id")).toThrowError(expect.objectContaining({ code: "invalid_provider_url" }));
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/reel/Reel-123", "image", "provider-id")).toThrowError(expect.objectContaining({ code: "invalid_provider_url" }));
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/p/AbC_123/", "reel", "provider-id")).toThrowError(expect.objectContaining({ code: "invalid_provider_url" }));
  });

  it.each([
    "https://user@www.instagram.com/p/abc/",
    "https://www.instagram.com:444/p/abc/",
    "https://www.instagram.com/explore/",
    "https://www.instagram.com/p/abc/comments/",
    "https://www.instagram.com//p/abc/",
  ])("rejects a non-canonical or authority-confused URL: %s", (url) => {
    expect(() => assertInstagramProviderUrl(url, "image", "provider-id")).toThrowError(expect.objectContaining({ code: "invalid_provider_url" }));
  });

  it("binds Story proof to the decoded final provider ID", () => {
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/stories/samplepublisher/story-123/", "story", "story-123")).not.toThrow();
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/stories/samplepublisher/another-story/", "story", "story-123")).toThrowError(expect.objectContaining({ code: "invalid_provider_url" }));
    expect(() => assertInstagramProviderUrl("https://www.instagram.com/p/story-123/", "story", "story-123")).toThrowError(expect.objectContaining({ code: "invalid_provider_url" }));
  });
});
