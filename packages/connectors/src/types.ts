import type { AnalyticsMetric, ContentFormat, CurrentCollaboratorStatusSnapshot, EngagementPlatform, MediaInspectionStatus, MediaMalwareScanStatus, Platform, RightsState } from "@originpost/domain";

export interface ConnectorMedia {
  id: string;
  type: "image" | "video";
  url: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  inspectionStatus: MediaInspectionStatus;
  malwareScanStatus?: MediaMalwareScanStatus | undefined;
  widthPixels?: number;
  heightPixels?: number;
  durationMs?: number;
  /** Optional for legacy formats; mandatory and fail-closed for Story publishing. */
  rights?: RightsState;
  altText?: string;
  thumbnailUrl?: string;
}

export interface PublishRequest {
  workspaceId: string;
  contentItemId: string;
  targetId: string;
  accountId: string;
  /** Required for collaborator publishing; optional so older ordinary publish callers remain compatible. */
  draftSha256?: string | undefined;
  platform: Platform;
  format: ContentFormat;
  caption: string;
  media: ConnectorMedia[];
  /** Server-resolved, rights-checked Reel cover. Never supplied as an arbitrary browser URL. */
  coverMedia?: ConnectorMedia | undefined;
  idempotencyKey: string;
  settings: Record<string, unknown>;
}

export interface AnalyticsRequest {
  workspaceId: string;
  contentItemId: string;
  proofId: string;
  accountId: string;
  platform: Extract<Platform, "instagram" | "youtube">;
  externalPostId: string;
  publishedAt: string;
}

export interface AnalyticsResult {
  capturedAt: string;
  period: "lifetime";
  metrics: AnalyticsMetric[];
  status?: "ready" | "pending" | "unavailable" | "privacy_threshold" | "expired" | "hidden";
  completeThrough?: string;
  caveats?: string[];
  rawResponse: unknown;
}

export class ProviderAnalyticsError extends Error {
  constructor(message: string, public readonly code: "permission_missing" | "unsupported" | "provider_failed") {
    super(message);
    this.name = "ProviderAnalyticsError";
  }
}

export class ProviderPublishError extends Error {
  readonly retrySafety = "reconcile_first" as const;

  constructor(
    message: string,
    public readonly code: "uncertain",
    public readonly detail: { containerId: string; externalPostId?: string },
  ) {
    super(message);
    this.name = "ProviderPublishError";
  }
}

export interface ReadInstagramCollaboratorStatusesRequest {
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  accountId: string;
  proofId: string;
  externalMediaId: string;
  requestedUsernames: readonly string[];
  requestedUsernamesSha256: string;
}

export type InstagramCollaboratorStatusAvailability = "available" | "credential_unavailable" | "connection_unsupported" | "scope_missing" | "endpoint_unavailable" | "transport_failed" | "provider_failed" | "invalid_response";
export type InstagramCollaboratorStatusErrorCode = Exclude<InstagramCollaboratorStatusAvailability, "available">;
export type InstagramCollaboratorStatusResult =
  | { snapshots: CurrentCollaboratorStatusSnapshot[]; capturedAt: string; complete: true; availability: "available"; rawResponseSha256: string }
  | { snapshots: CurrentCollaboratorStatusSnapshot[]; capturedAt: string; complete: false; availability: InstagramCollaboratorStatusErrorCode; error: { code: InstagramCollaboratorStatusErrorCode; message: string; providerCode?: number | undefined; providerSubcode?: number | undefined }; retry: { recommended: boolean; afterSeconds?: number | undefined }; rawResponseSha256?: string | undefined };

export type ProviderEngagementErrorCode = "permission_missing" | "unsupported" | "rate_limited" | "expired" | "not_found" | "provider_failed" | "uncertain";

export class ProviderEngagementError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderEngagementErrorCode,
    public readonly detail: { providerCode?: number; providerSubcode?: number; traceId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ProviderEngagementError";
  }
}

export interface EngagementRequestScope {
  workspaceId: string;
  brandId: string;
  accountId: string;
  platform: EngagementPlatform;
}

export interface ReadCommentsRequest extends EngagementRequestScope {
  externalMediaId: string;
}

export interface ProviderEngagementComment {
  externalCommentId: string;
  parentExternalCommentId?: string | undefined;
  authorScopedId?: string | undefined;
  authorUsername?: string | undefined;
  body: string;
  visibility: "visible" | "hidden";
  providerCreatedAt?: string | undefined;
}

export interface CommentPage {
  comments: ProviderEngagementComment[];
  fetchedAt: string;
  complete: true;
  rawResponse: unknown;
}

export interface ReplyToCommentRequest extends EngagementRequestScope {
  externalCommentId: string;
  body: string;
  idempotencyKey: string;
}

export interface ReplyToCommentResult {
  externalReplyId: string;
  createdAt: string;
  rawResponse: unknown;
}

export interface SubscribeCommentsRequest extends EngagementRequestScope {
  externalAccountId: string;
}

export interface SubscriptionResult {
  subscribed: true;
  fields: ["comments"] | ["feed"];
  rawResponse: unknown;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export type PublishResult =
  | {
      status: "published";
      externalPostId: string;
      liveUrl: string;
      rawResponse: unknown;
    }
  | {
      status: "pending";
      pendingToken: string;
      rawResponse: unknown;
    };

export type PendingResult =
  | { status: "pending"; pendingToken: string }
  | { status: "ready"; pendingToken: string }
  | { status: "published"; externalPostId: string; liveUrl: string; rawResponse: unknown };

export interface ConnectorManifest {
  id: string;
  name: string;
  platform: Platform;
  version: string;
  apiMode: "official" | "mock";
  capabilities: {
    formats: PublishRequest["format"][];
    analytics: boolean;
    comments: boolean;
    tokenRefresh: boolean;
    pendingPublishing: boolean;
  };
  limits: {
    captionCharacters: number;
    maxMedia: number;
    maxVideoBytes?: number;
  };
}

export interface PlatformConnector {
  readonly manifest: ConnectorManifest;
  validate(request: PublishRequest): Promise<ValidationIssue[]>;
  publish(request: PublishRequest): Promise<PublishResult>;
  checkPending?(pendingToken: string): Promise<PendingResult>;
  finalizePending?(pendingToken: string): Promise<PendingResult>;
  readPostAnalytics?(request: AnalyticsRequest): Promise<AnalyticsResult>;
}

export interface EngagementConnector {
  readonly manifest: ConnectorManifest & { platform: EngagementPlatform; capabilities: ConnectorManifest["capabilities"] & { comments: true } };
  readComments(request: ReadCommentsRequest): Promise<CommentPage>;
  replyToComment(request: ReplyToCommentRequest): Promise<ReplyToCommentResult>;
  subscribeToComments(request: SubscribeCommentsRequest): Promise<SubscriptionResult>;
}

export interface OriginPostPluginManifest {
  schemaVersion: "1";
  id: string;
  name: string;
  version: string;
  description: string;
  entrypoint: string;
  compatibility: { originpost: string };
  permissions: Array<
    | "content:read"
    | "content:write"
    | "media:read"
    | "media:write"
    | "network:outbound"
    | "publish:request"
    | "analytics:read"
    | "engagement:read"
    | "engagement:reply"
  >;
  networkAllowlist: string[];
  settingsSchema: Record<string, unknown>;
}
