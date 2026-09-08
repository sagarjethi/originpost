import { DomainError } from "./errors.js";

/** Exact account-type values returned by Meta for professional accounts. */
export type InstagramAccountType = "BUSINESS" | "MEDIA_CREATOR";

export interface InstagramStoryCapabilityContext {
  /** Must be resolved from Meta by the server; never trust a browser assertion. */
  accountType?: InstagramAccountType | undefined;
}

export type InstagramStoryCapability =
  | {
      state: "supported";
      accountType: "BUSINESS";
      autoPublish: true;
      mediaTypes: readonly ["image", "video"];
      interactiveFeatures: false;
    }
  | {
      state: "unsupported";
      accountType?: InstagramAccountType | undefined;
      reason: "account_type_unavailable" | "business_account_required";
      autoPublish: false;
      interactiveFeatures: false;
    };

/**
 * One fail-closed interface for the Meta account limitation. Meta allows
 * official Story publishing only for Instagram Business accounts.
 */
export function instagramStoryCapability(
  context: InstagramStoryCapabilityContext | InstagramAccountType | undefined,
): InstagramStoryCapability {
  const accountType = typeof context === "string" ? context : context?.accountType;
  if (accountType === "BUSINESS") {
    return {
      state: "supported",
      accountType,
      autoPublish: true,
      mediaTypes: ["image", "video"],
      interactiveFeatures: false,
    };
  }
  return {
    state: "unsupported",
    ...(accountType ? { accountType } : {}),
    reason: accountType === "MEDIA_CREATOR" ? "business_account_required" : "account_type_unavailable",
    autoPublish: false,
    interactiveFeatures: false,
  };
}

export function assertInstagramStoryAutoPublish(
  context: InstagramStoryCapabilityContext | InstagramAccountType | undefined,
): asserts context is InstagramStoryCapabilityContext & { accountType: "BUSINESS" } | "BUSINESS" {
  const capability = instagramStoryCapability(context);
  if (capability.state === "supported") return;
  if (capability.reason === "account_type_unavailable") {
    throw new DomainError(
      "Reconnect Instagram so OriginPost can verify that this is a Business account before publishing a Story.",
      "instagram_story_account_type_unavailable",
      409,
    );
  }
  throw new DomainError(
    "Official Instagram Story publishing is available only to Business accounts, not Creator accounts.",
    "instagram_story_business_account_required",
    409,
  );
}

/**
 * Meta's documented Story container accepts a baked image or video and the
 * native AI self-disclosure flag. Reject every other setting rather than
 * silently leaking feed/Reel or invented interactive parameters.
 */
export function assertInstagramStorySettings(settings: Record<string, unknown>): void {
  if (Object.keys(settings).length === 0) return;
  const allowed = new Set(["collaborators", "shareToFeed", "isAiGenerated", "approvedSettingsSha256", "approvalBinding"]);
  const collaborators = settings.collaborators;
  const semanticallyStorySafe = Object.keys(settings).every((key) => allowed.has(key))
    && Array.isArray(collaborators)
    && collaborators.length === 0
    && settings.shareToFeed !== false
    && (settings.isAiGenerated === true || settings.isAiGenerated === false)
    && typeof settings.approvedSettingsSha256 === "string";
  if (semanticallyStorySafe) return;
  throw new DomainError(
    "Official Story auto-publishing accepts one baked image or video plus an approved native AI info choice. Link, sticker, music, poll, location, collaborator, caption, and Reel settings are not supported.",
    "instagram_story_settings_unsupported",
    409,
  );
}
