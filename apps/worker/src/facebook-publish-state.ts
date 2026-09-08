import type { ProviderPublishOperation } from "@originpost/domain";

export type FacebookPublishNextStep =
  | "create-intent"
  | "create-post"
  | "verify-post"
  | "finish-proof"
  | "action-required"
  | "failed";

/**
 * Facebook's feed/photos calls can create a live post before the HTTP response
 * reaches OriginPost. A finalizing operation without a saved post ID must
 * therefore stop for reconciliation instead of sending the POST again.
 */
export function facebookPublishNextStep(operation: ProviderPublishOperation | null): FacebookPublishNextStep {
  if (!operation) return "create-intent";
  if (operation.status === "failed") return "failed";
  if (operation.status === "uncertain" || operation.status === "processing") return "action-required";
  if (operation.status === "published") {
    return operation.externalPostId && isVerifiedFacebookPermalink(operation.liveUrl) ? "finish-proof" : "action-required";
  }
  if (operation.status === "finalizing") return operation.externalPostId ? "verify-post" : "action-required";
  return "create-post";
}

export function isVerifiedFacebookPermalink(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"));
  } catch {
    return false;
  }
}

export function facebookIntentMarker(targetId: string): string {
  return `facebook-intent:${targetId}`;
}
