import { describe, expect, it } from "vitest";
import {
  assertInstagramStoryAutoPublish,
  assertInstagramStorySettings,
  addDraftSchema,
  instagramStoryCapability,
} from "../src/index.js";

describe("Instagram Story contract", () => {
  it("accepts Story as a first-class immutable draft format", () => {
    expect(addDraftSchema.parse({
      platform: "instagram",
      format: "story",
      title: "Mumbai event Story",
      caption: "Internal publishing note",
      mediaIds: ["media-story-1"],
    })).toMatchObject({ platform: "instagram", format: "story", mediaIds: ["media-story-1"] });
  });

  it("supports only a server-derived BUSINESS account", () => {
    expect(instagramStoryCapability("BUSINESS")).toEqual({
      state: "supported",
      accountType: "BUSINESS",
      autoPublish: true,
      mediaTypes: ["image", "video"],
      interactiveFeatures: false,
    });
    expect(instagramStoryCapability("MEDIA_CREATOR")).toMatchObject({
      state: "unsupported",
      accountType: "MEDIA_CREATOR",
      reason: "business_account_required",
    });
    expect(instagramStoryCapability(undefined)).toMatchObject({
      state: "unsupported",
      reason: "account_type_unavailable",
    });
  });

  it("fails closed for Creator and legacy credentials", () => {
    expect(() => assertInstagramStoryAutoPublish("MEDIA_CREATOR")).toThrowError(expect.objectContaining({
      code: "instagram_story_business_account_required",
    }));
    expect(() => assertInstagramStoryAutoPublish(undefined)).toThrowError(expect.objectContaining({
      code: "instagram_story_account_type_unavailable",
    }));
  });

  it.each(["link", "linkUrl", "sticker", "music", "poll", "location", "collaborators", "shareToFeed", "reelCover"])(
    "rejects the unsupported %s setting instead of silently accepting it",
    (field) => {
      expect(() => assertInstagramStorySettings({ [field]: "untrusted" })).toThrowError(expect.objectContaining({
        code: "instagram_story_settings_unsupported",
      }));
    },
  );

  it("accepts an empty Story settings object", () => {
    expect(() => assertInstagramStorySettings({})).not.toThrow();
  });
});
