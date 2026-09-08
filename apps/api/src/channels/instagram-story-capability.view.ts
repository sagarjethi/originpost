import { instagramStoryCapability, type InstagramStoryCapability } from "@originpost/domain";

type InstagramCredentialIdentity = {
  provider?: unknown;
  externalAccountId?: unknown;
  accountType?: unknown;
};

/**
 * Projects only the non-secret account-type fact needed by the Channels UI.
 * A credential for another provider/account fails closed instead of leaking or
 * trusting unrelated vault contents.
 */
export function instagramStoryCapabilityView(
  externalAccountId: string,
  credentialPayload: unknown,
): InstagramStoryCapability {
  if (!credentialPayload || typeof credentialPayload !== "object") {
    return instagramStoryCapability(undefined);
  }

  const identity = credentialPayload as InstagramCredentialIdentity;
  const matchesAccount = identity.provider === "instagram" && identity.externalAccountId === externalAccountId;
  if (!matchesAccount) return instagramStoryCapability(undefined);

  return instagramStoryCapability(
    identity.accountType === "BUSINESS" || identity.accountType === "MEDIA_CREATOR"
      ? identity.accountType
      : undefined,
  );
}
