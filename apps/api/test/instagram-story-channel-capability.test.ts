import { describe, expect, it } from "vitest";
import { instagramStoryCapabilityView } from "../src/channels/instagram-story-capability.view.js";

describe("Instagram Story channel capability view", () => {
  it("exposes Business Story eligibility without projecting credential secrets", () => {
    const credential = {
      provider: "instagram",
      externalAccountId: "ig-1",
      accountType: "BUSINESS",
      accessToken: "must-not-leak",
      scope: "must-not-leak-either",
    };

    const view = instagramStoryCapabilityView("ig-1", credential);

    expect(view).toEqual({
      state: "supported",
      accountType: "BUSINESS",
      autoPublish: true,
      mediaTypes: ["image", "video"],
      interactiveFeatures: false,
    });
    expect(JSON.stringify(view)).not.toContain("must-not-leak");
    expect(view).not.toHaveProperty("scope");
  });

  it("shows Creator accounts as ineligible for official Story publishing", () => {
    expect(instagramStoryCapabilityView("ig-1", {
      provider: "instagram",
      externalAccountId: "ig-1",
      accountType: "MEDIA_CREATOR",
    })).toEqual({
      state: "unsupported",
      accountType: "MEDIA_CREATOR",
      reason: "business_account_required",
      autoPublish: false,
      interactiveFeatures: false,
    });
  });

  it("fails closed when the protected identity is missing or belongs to another account", () => {
    expect(instagramStoryCapabilityView("ig-1", undefined)).toMatchObject({
      state: "unsupported",
      reason: "account_type_unavailable",
    });
    expect(instagramStoryCapabilityView("ig-1", {
      provider: "instagram",
      externalAccountId: "ig-2",
      accountType: "BUSINESS",
    })).toMatchObject({
      state: "unsupported",
      reason: "account_type_unavailable",
    });
  });
});
