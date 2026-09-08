import { describe, expect, it } from "vitest";
import { instagramStoryCapabilityCopy } from "./instagram-story-capability";

describe("Instagram Story channel capability copy", () => {
  it("identifies an eligible Business account and the basic-only scope", () => {
    expect(instagramStoryCapabilityCopy({
      state: "supported",
      accountType: "BUSINESS",
      autoPublish: true,
      mediaTypes: ["image", "video"],
      interactiveFeatures: false,
    })).toEqual({
      status: "pass",
      label: "Instagram Stories",
      detail: "Business account · basic image and video Stories are eligible for auto publish.",
    });
  });

  it("directs Creator accounts to the manual Story handoff", () => {
    expect(instagramStoryCapabilityCopy({
      state: "unsupported",
      accountType: "MEDIA_CREATOR",
      reason: "business_account_required",
      autoPublish: false,
      interactiveFeatures: false,
    })).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("manual Story handoff"),
    });
  });

  it("asks for reconnection when account type is unavailable", () => {
    expect(instagramStoryCapabilityCopy()).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("Account type not verified"),
    });
  });
});
