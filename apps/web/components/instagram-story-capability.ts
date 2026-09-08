export type InstagramStoryCapabilityView =
  | {
      state: "supported";
      accountType: "BUSINESS";
      autoPublish: true;
      mediaTypes: readonly ["image", "video"];
      interactiveFeatures: false;
    }
  | {
      state: "unsupported";
      accountType?: "BUSINESS" | "MEDIA_CREATOR";
      reason: "account_type_unavailable" | "business_account_required";
      autoPublish: false;
      interactiveFeatures: false;
    };

export function instagramStoryCapabilityCopy(capability?: InstagramStoryCapabilityView) {
  if (capability?.state === "supported") {
    return {
      status: "pass" as const,
      label: "Instagram Stories",
      detail: "Business account · basic image and video Stories are eligible for auto publish.",
    };
  }
  if (capability?.accountType === "MEDIA_CREATOR") {
    return {
      status: "warn" as const,
      label: "Instagram Stories",
      detail: "Creator account · use manual Story handoff; official Story auto publish requires a Business account.",
    };
  }
  return {
    status: "warn" as const,
    label: "Instagram Stories",
    detail: "Account type not verified · reconnect Instagram before using Story auto publish.",
  };
}
