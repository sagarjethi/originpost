import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";

export const instagramCollaboratorLimit = 3 as const;
export const instagramCollaboratorRequiredScopes = ["instagram_basic", "instagram_content_publish", "pages_read_engagement"] as const;

export type InstagramConnectionMode = "instagram_login" | "facebook_login";
export type InstagramCollaboratorEndpointFamily = "instagram_api_with_facebook_login" | "instagram_api_with_instagram_login";
export type InstagramCollaboratorProviderStatus = "pending" | "accepted";
export type InstagramCollaboratorSnapshotStatus = InstagramCollaboratorProviderStatus | "not_returned" | "unavailable";

export interface InstagramPublishApprovalBinding {
  platform: "instagram";
  accountId: string;
  draftSha256: string;
  approvedSettingsSha256: string;
  canonicalSha256: string;
}

export type InstagramReelCoverSelection =
  | { mode: "custom_image"; mediaId: string; mediaSha256: string }
  | { mode: "video_frame"; offsetMs: number }
  | { mode: "instagram_default" };

export interface InstagramPublishSettings extends Record<string, unknown> {
  collaborators: readonly string[];
  shareToFeed?: boolean | undefined;
  reelCover?: InstagramReelCoverSelection | undefined;
  /** Exact opt-in for Meta's native Instagram "AI info" label. */
  isAiGenerated?: boolean | undefined;
  approvedSettingsSha256: string;
  approvalBinding?: InstagramPublishApprovalBinding | undefined;
}

export interface InstagramCollaboratorCapabilityContext {
  connectionMode?: InstagramConnectionMode | undefined;
  scopes?: readonly string[] | undefined;
  endpointFamily?: InstagramCollaboratorEndpointFamily | undefined;
  endpointProbe?: { state: "verified" | "failed" | "not_run"; apiVersion?: string | undefined } | undefined;
}

export type InstagramCollaboratorCapability =
  | {
      state: "unsupported";
      connectionMode: InstagramConnectionMode;
      reason: "facebook_login_required" | "required_scopes_missing" | "endpoint_family_unsupported" | "endpoint_probe_required";
      requiredScopes: typeof instagramCollaboratorRequiredScopes;
      maxCollaborators: typeof instagramCollaboratorLimit;
    }
  | {
      state: "supported";
      connectionMode: "facebook_login";
      publish: true;
      statusRead: true;
      requiredScopes: typeof instagramCollaboratorRequiredScopes;
      endpointFamily: "instagram_api_with_facebook_login";
      providerVersion: string;
      maxCollaborators: typeof instagramCollaboratorLimit;
    };

export type CollaboratorInviteProof =
  | {
      requestedUsernames: readonly [];
      requestedUsernamesSha256: string;
      requestState: "not_requested";
      providerConnectionMode: InstagramConnectionMode;
    }
  | {
      requestedUsernames: readonly string[];
      requestedUsernamesSha256: string;
      requestState: "requested_unverified";
      providerConnectionMode: "facebook_login";
    };

export interface CollaboratorStatusSnapshot {
  /** Optional only so records created before the lineage contract remain readable. */
  workspaceId?: string | undefined;
  brandId?: string | undefined;
  contentItemId?: string | undefined;
  proofId: string;
  accountId?: string | undefined;
  externalMediaId: string;
  requestedUsernamesSha256?: string | undefined;
  username: string;
  providerScopedUserId?: string | undefined;
  status: InstagramCollaboratorSnapshotStatus;
  capturedAt: string;
  providerResponseSha256: string;
}

export interface CurrentCollaboratorStatusSnapshot extends CollaboratorStatusSnapshot {
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  accountId: string;
  requestedUsernamesSha256: string;
}

const usernamePattern = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/u;

function normalizeOneUsername(value: string): string {
  const normalized = value.normalize("NFC").trim().replace(/^@/u, "").toLowerCase();
  if (!usernamePattern.test(normalized)) {
    throw new DomainError(
      "Use an Instagram username with letters, numbers, periods, or underscores.",
      "instagram_collaborator_invalid_syntax",
    );
  }
  return normalized;
}

export function normalizeInstagramPublisherUsername(value: string): string {
  return normalizeOneUsername(value);
}

export function normalizeInstagramCollaborators(
  input: readonly string[],
  publishingUsername?: string,
): readonly string[] {
  if (input.length > instagramCollaboratorLimit) {
    throw new DomainError(
      `Instagram accepts at most ${instagramCollaboratorLimit} collaborators for API publishing.`,
      "instagram_collaborator_limit_exceeded",
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const username = normalizeOneUsername(value);
    if (seen.has(username)) continue;
    seen.add(username);
    normalized.push(username);
  }

  const publisher = publishingUsername ? normalizeOneUsername(publishingUsername) : undefined;
  if (publisher && seen.has(publisher)) {
    throw new DomainError(
      "The publishing Instagram account cannot invite itself as a collaborator.",
      "instagram_collaborator_self_invite",
    );
  }
  return normalized;
}

export function normalizeInstagramReelCover(value: unknown): InstagramReelCoverSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("Instagram Reel cover settings are invalid.", "instagram_reel_cover_invalid", 409);
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "instagram_default" && Object.keys(candidate).length === 1) return { mode: "instagram_default" };
  if (candidate.mode === "video_frame" && Object.keys(candidate).every((key) => key === "mode" || key === "offsetMs") && Number.isInteger(candidate.offsetMs) && Number(candidate.offsetMs) >= 0) return { mode: "video_frame", offsetMs: Number(candidate.offsetMs) };
  if (candidate.mode === "custom_image" && Object.keys(candidate).every((key) => ["mode", "mediaId", "mediaSha256"].includes(key)) && typeof candidate.mediaId === "string" && candidate.mediaId.trim() && typeof candidate.mediaSha256 === "string" && /^[a-f0-9]{64}$/u.test(candidate.mediaSha256)) return { mode: "custom_image", mediaId: candidate.mediaId.trim(), mediaSha256: candidate.mediaSha256 };
  throw new DomainError("Choose Instagram default, a valid video-frame offset, or one verified custom-cover image.", "instagram_reel_cover_invalid", 409);
}

export function assertInstagramReelCoverForDraft(cover: InstagramReelCoverSelection | undefined, format: "image" | "carousel" | "reel" | "story" | "short" | "text", videoDurationMs?: number, requireMeasuredDuration = false): void {
  if (!cover) return;
  if (format !== "reel") throw new DomainError("Reel cover settings apply only to Instagram Reels.", "instagram_reel_cover_format_unsupported", 409);
  if (cover.mode === "video_frame") {
    if (videoDurationMs === undefined && !requireMeasuredDuration) return;
    if (!Number.isInteger(videoDurationMs) || Number(videoDurationMs) <= 0) throw new DomainError("The Reel needs trusted server-measured duration before choosing a frame.", "instagram_reel_duration_required", 409);
    if (cover.offsetMs >= Number(videoDurationMs)) throw new DomainError(`Choose a frame before ${videoDurationMs} ms.`, "instagram_reel_cover_offset_out_of_range", 409);
  }
}

export function instagramPublishSettingsHash(input: Pick<InstagramPublishSettings, "collaborators" | "shareToFeed" | "reelCover" | "isAiGenerated">): string {
  const reelCover = normalizeInstagramReelCover(input.reelCover);
  return createHash("sha256")
    .update(JSON.stringify({
      collaborators: [...input.collaborators],
      shareToFeed: input.shareToFeed !== false,
      ...(reelCover ? { reelCover } : {}),
      ...(input.isAiGenerated !== undefined ? { isAiGenerated: input.isAiGenerated } : {}),
    }))
    .digest("hex");
}

export function instagramRequestedUsernamesHash(usernames: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...usernames])).digest("hex");
}

function approvalBindingValue(input: Omit<InstagramPublishApprovalBinding, "canonicalSha256">): Omit<InstagramPublishApprovalBinding, "canonicalSha256"> {
  return { platform: "instagram", accountId: input.accountId, draftSha256: input.draftSha256, approvedSettingsSha256: input.approvedSettingsSha256 };
}

export function bindInstagramPublishApproval(input: Omit<InstagramPublishApprovalBinding, "platform" | "canonicalSha256">): InstagramPublishApprovalBinding {
  if (!input.accountId.trim() || !/^[a-f0-9]{64}$/u.test(input.draftSha256) || !/^[a-f0-9]{64}$/u.test(input.approvedSettingsSha256)) {
    throw new DomainError("Instagram collaborator approval binding is invalid.", "instagram_collaborator_approval_binding_invalid", 409);
  }
  const value = approvalBindingValue({ platform: "instagram", ...input });
  return { ...value, canonicalSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

export function assertInstagramPublishApprovalBinding(
  value: unknown,
  expected: { platform: "instagram"; accountId: string; draftSha256: string; approvedSettingsSha256: string },
): InstagramPublishApprovalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("Instagram collaborator publishing needs an exact approved target binding.", "instagram_collaborator_approval_binding_required", 409);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["platform", "accountId", "draftSha256", "approvedSettingsSha256", "canonicalSha256"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key)) || candidate.platform !== "instagram" || typeof candidate.accountId !== "string" || typeof candidate.draftSha256 !== "string" || typeof candidate.approvedSettingsSha256 !== "string" || typeof candidate.canonicalSha256 !== "string") {
    throw new DomainError("Instagram collaborator approval binding is invalid.", "instagram_collaborator_approval_binding_invalid", 409);
  }
  const canonical = bindInstagramPublishApproval({ accountId: candidate.accountId, draftSha256: candidate.draftSha256, approvedSettingsSha256: candidate.approvedSettingsSha256 });
  if (canonical.canonicalSha256 !== candidate.canonicalSha256 || candidate.platform !== expected.platform || candidate.accountId !== expected.accountId || candidate.draftSha256 !== expected.draftSha256 || candidate.approvedSettingsSha256 !== expected.approvedSettingsSha256) {
    throw new DomainError("Instagram collaborator approval binding changed after approval.", "instagram_collaborator_approval_binding_stale", 409);
  }
  return canonical;
}

export function approveInstagramPublishSettings(
  input: { collaborators: readonly string[]; shareToFeed?: boolean | undefined; reelCover?: unknown; isAiGenerated?: boolean | undefined },
  publishingUsername?: string,
): InstagramPublishSettings {
  const collaborators = normalizeInstagramCollaborators(input.collaborators, publishingUsername);
  const shareToFeed = input.shareToFeed !== false;
  const reelCover = normalizeInstagramReelCover(input.reelCover);
  if (input.isAiGenerated !== undefined && typeof input.isAiGenerated !== "boolean") {
    throw new DomainError("Choose whether Instagram should apply its native AI info label.", "instagram_ai_disclosure_invalid", 409);
  }
  return {
    collaborators,
    shareToFeed,
    ...(reelCover ? { reelCover } : {}),
    ...(input.isAiGenerated !== undefined ? { isAiGenerated: input.isAiGenerated } : {}),
    approvedSettingsSha256: instagramPublishSettingsHash({ collaborators, shareToFeed, reelCover, isAiGenerated: input.isAiGenerated }),
  };
}

export function assertApprovedInstagramPublishSettings(
  value: unknown,
  publishingUsername?: string,
): InstagramPublishSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("Instagram collaborator settings are invalid.", "instagram_collaborator_invalid_syntax");
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["collaborators", "shareToFeed", "reelCover", "isAiGenerated", "approvedSettingsSha256", "approvalBinding"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key)) || !Array.isArray(candidate.collaborators) || candidate.collaborators.some((entry) => typeof entry !== "string")) {
    throw new DomainError("Instagram collaborator settings are invalid.", "instagram_collaborator_invalid_syntax");
  }
  if (typeof candidate.approvedSettingsSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.approvedSettingsSha256)) {
    throw new DomainError("Instagram collaborator settings need approval before publishing.", "instagram_collaborator_approval_required", 409);
  }
  const legacy = candidate.shareToFeed === undefined && candidate.reelCover === undefined;
  const collaborators = normalizeInstagramCollaborators(candidate.collaborators as string[], publishingUsername);
  if (legacy) {
    const legacyHash = createHash("sha256").update(JSON.stringify({ collaborators: [...collaborators] })).digest("hex");
    if (legacyHash === candidate.approvedSettingsSha256) return { collaborators, approvedSettingsSha256: legacyHash, ...(candidate.approvalBinding ? { approvalBinding: candidate.approvalBinding as InstagramPublishApprovalBinding } : {}) };
  }
  if (candidate.shareToFeed !== undefined && typeof candidate.shareToFeed !== "boolean") throw new DomainError("Instagram share-to-feed setting is invalid.", "instagram_publish_settings_invalid", 409);
  if (candidate.isAiGenerated !== undefined && typeof candidate.isAiGenerated !== "boolean") throw new DomainError("Instagram AI disclosure setting is invalid.", "instagram_ai_disclosure_invalid", 409);
  const approved = approveInstagramPublishSettings({
    collaborators,
    shareToFeed: candidate.shareToFeed as boolean | undefined,
    reelCover: candidate.reelCover,
    ...(candidate.isAiGenerated !== undefined ? { isAiGenerated: candidate.isAiGenerated as boolean } : {}),
  }, publishingUsername);
  if (approved.approvedSettingsSha256 !== candidate.approvedSettingsSha256) {
    throw new DomainError("Instagram collaborator settings changed after approval.", "instagram_collaborator_approval_stale", 409);
  }
  return { ...approved, ...(candidate.approvalBinding ? { approvalBinding: candidate.approvalBinding as InstagramPublishApprovalBinding } : {}) };
}

export function assertInstagramCollaboratorFormat(
  format: "image" | "carousel" | "reel" | "story" | "short" | "text",
  hasCollaborators: boolean,
): void {
  if (hasCollaborators && !["image", "carousel", "reel"].includes(format)) {
    throw new DomainError(
      "Instagram collaborator invitations are supported only for feed images, Reels, and carousel parents.",
      "instagram_collaborators_format_unsupported",
      409,
    );
  }
}

export function instagramCollaboratorCapability(context: InstagramCollaboratorCapabilityContext | InstagramConnectionMode | undefined): InstagramCollaboratorCapability {
  const value = typeof context === "string" ? { connectionMode: context } : context ?? {};
  const connectionMode = value.connectionMode ?? "instagram_login";
  const unsupported = (reason: Extract<InstagramCollaboratorCapability, {state:"unsupported"}>["reason"]): InstagramCollaboratorCapability => ({ state: "unsupported", connectionMode, reason, requiredScopes: instagramCollaboratorRequiredScopes, maxCollaborators: instagramCollaboratorLimit });
  if (connectionMode !== "facebook_login") return unsupported("facebook_login_required");
  const scopes = new Set((value.scopes ?? []).map((scope) => scope.trim()).filter(Boolean));
  if (instagramCollaboratorRequiredScopes.some((scope) => !scopes.has(scope))) return unsupported("required_scopes_missing");
  if (value.endpointFamily !== "instagram_api_with_facebook_login") return unsupported("endpoint_family_unsupported");
  if (value.endpointProbe?.state !== "verified" || !value.endpointProbe.apiVersion?.trim()) return unsupported("endpoint_probe_required");
  return { state: "supported", connectionMode, publish: true, statusRead: true, requiredScopes: instagramCollaboratorRequiredScopes, endpointFamily: value.endpointFamily, providerVersion: value.endpointProbe.apiVersion, maxCollaborators: instagramCollaboratorLimit };
}

export function collaboratorInviteProof(
  settings: InstagramPublishSettings | undefined,
  connectionMode: InstagramConnectionMode | undefined,
): CollaboratorInviteProof {
  const mode = connectionMode ?? "instagram_login";
  if (!settings?.collaborators.length) {
    const requestedUsernames: readonly [] = [];
    return {
      requestedUsernames,
      requestedUsernamesSha256: instagramRequestedUsernamesHash(requestedUsernames),
      requestState: "not_requested",
      providerConnectionMode: mode,
    };
  }
  if (mode !== "facebook_login") {
    throw new DomainError(
      "Connect Instagram through Meta before inviting collaborators.",
      "instagram_collaborators_connection_unsupported",
      409,
    );
  }
  return {
    requestedUsernames: settings.collaborators,
    requestedUsernamesSha256: instagramRequestedUsernamesHash(settings.collaborators),
    requestState: "requested_unverified",
    providerConnectionMode: mode,
  };
}
