export type PublishingPlatform = "instagram" | "facebook" | "youtube";
export type ConnectedAccountStatus = "setup_required" | "healthy" | "expiring" | "refresh_failed" | "disconnected";
export type ConnectionReadiness = "healthy" | "warning" | "blocked";
export type FacebookPageCandidate = { externalAccountId: string; displayName: string };
export type FacebookPageSelection = { selectionId: string; expiresAt: string; pages: FacebookPageCandidate[] };
export type InstagramFacebookCandidate = { externalAccountId: string; username: string; displayName: string; pageId: string; pageName: string };
export type InstagramFacebookSelection = { selectionId: string; expiresAt: string; connectionMode: "facebook_login"; accounts: InstagramFacebookCandidate[] };
export type MetaMessagingConnectionMode = "facebook_page_messenger" | "instagram_linked_page";
export type MetaMessagingCandidate = {
  targetKey: string;
  connectionMode: MetaMessagingConnectionMode;
  externalBusinessAccountId: string;
  displayName: string;
  pageName: string;
  username?: string;
  accountId: string;
};
export type MetaMessagingSelection = { selectionId: string; expiresAt: string; candidates: MetaMessagingCandidate[] };
export type ProviderGrantView = {
  id: string;
  provider: "meta" | "google";
  authorizationKind: "instagram_login" | "facebook_login" | "google_oauth";
  status: "active" | "expiring" | "refresh_failed" | "reauthorization_required" | "deauthorized" | "revoked" | "deletion_pending" | "deleted" | "superseded";
  scopes: string[];
  version: number;
  accountIds: string[];
  accessExpiresAt?: string;
  dataAccessExpiresAt?: string;
  nextRefreshAt?: string;
  nextValidationAt?: string;
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  lastErrorCode?: string;
  lastErrorSummary?: string;
  updatedAt: string;
};

export const publishingPlatforms = ["instagram", "facebook", "youtube"] as const;

const platformDetails: Record<PublishingPlatform, {
  label: string;
  badge: string;
  accountKind: string;
  formats: readonly string[];
  defaultFormat: string;
  liveUrlPlaceholder: string;
  externalIdPlaceholder: string;
}> = {
  instagram: {
    label: "Instagram",
    badge: "IG",
    accountKind: "Professional account",
    formats: ["image", "carousel", "reel", "story"],
    defaultFormat: "image",
    liveUrlPlaceholder: "https://www.instagram.com/p/…",
    externalIdPlaceholder: "Example: DAbC123",
  },
  facebook: {
    label: "Facebook Page",
    badge: "FB",
    accountKind: "Page",
    formats: ["text", "image"],
    defaultFormat: "text",
    liveUrlPlaceholder: "https://www.facebook.com/your-page/posts/…",
    externalIdPlaceholder: "Example: 123456789_987654321",
  },
  youtube: {
    label: "YouTube",
    badge: "YT",
    accountKind: "Channel",
    formats: ["short"],
    defaultFormat: "short",
    liveUrlPlaceholder: "https://www.youtube.com/watch?v=…",
    externalIdPlaceholder: "Example: dQw4w9WgXcQ",
  },
};

export function isPublishingPlatform(value: string): value is PublishingPlatform {
  return publishingPlatforms.includes(value as PublishingPlatform);
}

export function platformLabel(platform: string): string {
  return isPublishingPlatform(platform) ? platformDetails[platform].label : "Unknown platform";
}

export function platformBadge(platform: string): string {
  return isPublishingPlatform(platform) ? platformDetails[platform].badge : "—";
}

export function platformAccountKind(platform: string): string {
  return isPublishingPlatform(platform) ? platformDetails[platform].accountKind : "Account";
}

export function platformFormats(platform: PublishingPlatform): readonly string[] {
  return platformDetails[platform].formats;
}

export function defaultPlatformFormat(platform: PublishingPlatform): string {
  return platformDetails[platform].defaultFormat;
}

export function liveUrlPlaceholder(platform: string): string {
  return isPublishingPlatform(platform) ? platformDetails[platform].liveUrlPlaceholder : "https://…";
}

export function externalPostIdPlaceholder(platform: string): string {
  return isPublishingPlatform(platform) ? platformDetails[platform].externalIdPlaceholder : "Provider post ID";
}

export function connectedAccountStatusPresentation(status: ConnectedAccountStatus, readiness: ConnectionReadiness): { label: string; className: ConnectedAccountStatus } {
  if (status === "disconnected") return { label: "Disconnected", className: status };
  if (readiness === "blocked") return { label: "Action needed", className: "setup_required" };
  if (readiness === "warning") return { label: "Review needed", className: "expiring" };
  return { label: status.replaceAll("_", " "), className: status };
}

export function facebookPageMediaError(format: string, mediaKinds: readonly string[]): string | null {
  if (format === "text") return mediaKinds.length === 0 ? null : "A Facebook Page text post cannot include media.";
  if (format !== "image") return "Facebook Pages currently support text posts and single-image posts only.";
  if (mediaKinds.length !== 1 || mediaKinds[0] !== "image") return "A Facebook Page image post needs exactly one ready image.";
  return null;
}

export function instagramStoryMediaError(format: string, media: readonly { kind: string; inspectionStatus?: string }[]): string | null {
  if (format !== "story") return null;
  if (media.length !== 1) return "An Instagram Story needs exactly one ready, checked image or video.";
  if (media[0]?.kind !== "image" && media[0]?.kind !== "video") return "An Instagram Story needs exactly one ready, checked image or video.";
  if (media[0].inspectionStatus !== "ready") return "The Instagram Story image or video must finish its Library check first.";
  return null;
}

export function parseFacebookPageSelection(value: unknown, fallbackSelectionId: string): FacebookPageSelection {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pages = Array.isArray(body.pages) ? body.pages.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const page = candidate as Record<string, unknown>;
    return typeof page.externalAccountId === "string" && typeof page.displayName === "string"
      ? [{ externalAccountId: page.externalAccountId, displayName: page.displayName }]
      : [];
  }) : [];
  return {
    selectionId: typeof body.selectionId === "string" ? body.selectionId : fallbackSelectionId,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
    pages,
  };
}

export function parseInstagramFacebookSelection(value: unknown, fallbackSelectionId: string): InstagramFacebookSelection {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const accounts = Array.isArray(body.accounts) ? body.accounts.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    return typeof item.externalAccountId === "string" && typeof item.username === "string" && typeof item.displayName === "string" && typeof item.pageId === "string" && typeof item.pageName === "string"
      ? [{ externalAccountId: item.externalAccountId, username: item.username, displayName: item.displayName, pageId: item.pageId, pageName: item.pageName }]
      : [];
  }) : [];
  return {
    selectionId: typeof body.selectionId === "string" ? body.selectionId : fallbackSelectionId,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
    connectionMode: "facebook_login",
    accounts,
  };
}

export function parseProviderGrantViews(value: unknown): ProviderGrantView[] {
  if (!Array.isArray(value)) return [];
  const allowedStatuses = new Set<ProviderGrantView["status"]>(["active", "expiring", "refresh_failed", "reauthorization_required", "deauthorized", "revoked", "deletion_pending", "deleted", "superseded"]);
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || (item.provider !== "meta" && item.provider !== "google") || (item.authorizationKind !== "instagram_login" && item.authorizationKind !== "facebook_login" && item.authorizationKind !== "google_oauth") || typeof item.status !== "string" || !allowedStatuses.has(item.status as ProviderGrantView["status"]) || typeof item.version !== "number" || typeof item.updatedAt !== "string") return [];
    const scopes = Array.isArray(item.scopes) ? item.scopes.filter((scope): scope is string => typeof scope === "string") : [];
    const accountIds = Array.isArray(item.accountIds) ? item.accountIds.filter((id): id is string => typeof id === "string") : [];
    return [{
      id: item.id,
      provider: item.provider,
      authorizationKind: item.authorizationKind,
      status: item.status as ProviderGrantView["status"],
      scopes,
      version: item.version,
      accountIds,
      ...(typeof item.accessExpiresAt === "string" ? { accessExpiresAt: item.accessExpiresAt } : {}),
      ...(typeof item.dataAccessExpiresAt === "string" ? { dataAccessExpiresAt: item.dataAccessExpiresAt } : {}),
      ...(typeof item.nextRefreshAt === "string" ? { nextRefreshAt: item.nextRefreshAt } : {}),
      ...(typeof item.nextValidationAt === "string" ? { nextValidationAt: item.nextValidationAt } : {}),
      ...(typeof item.lastCheckedAt === "string" ? { lastCheckedAt: item.lastCheckedAt } : {}),
      ...(typeof item.lastHealthyAt === "string" ? { lastHealthyAt: item.lastHealthyAt } : {}),
      ...(typeof item.lastErrorCode === "string" ? { lastErrorCode: item.lastErrorCode } : {}),
      ...(typeof item.lastErrorSummary === "string" ? { lastErrorSummary: item.lastErrorSummary } : {}),
      updatedAt: item.updatedAt,
    }];
  });
}

export function parseMetaMessagingSelection(value: unknown, fallbackSelectionId: string): MetaMessagingSelection {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const candidates = Array.isArray(body.candidates) ? body.candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const connectionMode = item.connectionMode;
    if (
      typeof item.targetKey !== "string"
      || (connectionMode !== "facebook_page_messenger" && connectionMode !== "instagram_linked_page")
      || typeof item.externalBusinessAccountId !== "string"
      || typeof item.displayName !== "string"
      || typeof item.pageName !== "string"
      || typeof item.accountId !== "string"
    ) return [];
    const safeConnectionMode: MetaMessagingConnectionMode = connectionMode;
    return [{
      targetKey: item.targetKey,
      connectionMode: safeConnectionMode,
      externalBusinessAccountId: item.externalBusinessAccountId,
      displayName: item.displayName,
      pageName: item.pageName,
      ...(typeof item.username === "string" ? { username: item.username } : {}),
      accountId: item.accountId,
    }];
  }) : [];
  return {
    selectionId: typeof body.selectionId === "string" ? body.selectionId : fallbackSelectionId,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
    candidates,
  };
}
