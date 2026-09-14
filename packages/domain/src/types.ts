import type { CollaboratorInviteProof, InstagramPublishApprovalBinding, InstagramPublishSettings, InstagramReelCoverSelection } from "./instagram-collaboration.js";

export const contentStatuses = [
  "inbox",
  "researching",
  "drafting",
  "review",
  "approved",
  "scheduled",
  "action_required",
  "publishing",
  "published",
  "failed",
  "archived",
] as const;

export type ContentStatus = (typeof contentStatuses)[number];
export type ResearchDepth = "quick" | "standard" | "deep";
export type Role = "owner" | "manager" | "creator" | "viewer";
export type Platform = "instagram" | "facebook" | "youtube";
export type ContentFormat = "image" | "carousel" | "reel" | "story" | "short" | "text";
export type DeliveryMode = "auto_publish" | "manual_handoff";
export type RiskLevel = "low" | "medium" | "high" | "sensitive";
export type RightsState = "unknown" | "reference-only" | "cleared" | "owned";
export type ResearchRunStatus = "queued" | "running" | "completed" | "failed";
export type MonitorRunStatus = "running" | "completed" | "failed" | "skipped";
export type ConnectedAccountStatus = "setup_required" | "healthy" | "expiring" | "refresh_failed" | "disconnected";
export type ChannelCapability = "profile_read" | "page_read" | "media_publish" | "channel_read" | "video_upload" | "analytics_read" | "comment_read" | "comment_reply" | "private_message_read" | "private_message_send" | "collaborator_publish" | "collaborator_status_read";
export type YouTubePrivacyStatus = "private" | "unlisted" | "public";
export type NotificationKind = "publish_failed" | "action_required" | "monitor_new_findings" | "monitor_failed" | "connection_attention" | "approval_needed" | "engagement_reply_failed" | "engagement_permission_missing" | "engagement_new_activity" | "private_message_new_activity" | "private_message_reply_failed" | "private_message_permission_missing" | "system";
export type NotificationSeverity = "info" | "warning" | "error";
export type BrandStatus = "active" | "archived";
export type AnalyticsSnapshotStatus = "ready" | "pending" | "unavailable" | "privacy_threshold" | "expired" | "hidden" | "permission_missing" | "unsupported" | "failed";
export type AnalyticsMetricKey = "views" | "engaged_views" | "reach" | "impressions" | "clicks" | "likes" | "comments" | "shares" | "saves" | "watch_time_seconds" | "average_view_duration_seconds" | "subscribers_gained";
export type AnalyticsMetricUnit = "count" | "seconds";

export interface YouTubePublishSettings extends Record<string, unknown> {
  title: string;
  description: string;
  privacyStatus: YouTubePrivacyStatus;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  notifySubscribers: boolean;
  categoryId?: string | undefined;
  defaultLanguage?: string | undefined;
  timezone?: string | undefined;
}

export interface Actor {
  id: string;
  name: string;
  role: Role;
  actorType?: "human" | "agent" | "system" | "api_key" | undefined;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface Brand {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description?: string | undefined;
  primaryLanguage: string;
  timezone: string;
  status: BrandStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorRule {
  id: string;
  workspaceId: string;
  brandId: string;
  name: string;
  query: string;
  intervalMinutes: number;
  depth: ResearchDepth;
  languages: string[];
  region?: string | undefined;
  sourceLimit: number;
  freshnessHours: number;
  enabled: boolean;
  notifyDestinationId?: string | undefined;
  sourceIntelligence?: import("./source-intelligence.js").SourceIntelligenceConfig | undefined;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorRun {
  id: string;
  workspaceId: string;
  monitorId: string;
  status: MonitorRunStatus;
  trigger: "scheduled" | "manual";
  jobId?: string | undefined;
  provider?: string | undefined;
  responseId?: string | undefined;
  contentItemId?: string | undefined;
  contentItemIds?: string[] | undefined;
  discoveredCount: number;
  newCount: number;
  error?: string | undefined;
  reason?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
}

export interface MonitorFingerprint {
  workspaceId: string;
  monitorId: string;
  fingerprint: string;
  sourceUrl: string;
  contentItemId: string;
  firstSeenAt: string;
}

export interface SourceEvidence {
  id: string;
  kind: "url" | "note" | "image" | "video" | "document" | "voice" | "screenshot";
  title: string;
  url?: string | undefined;
  publisher?: string | undefined;
  publishedAt?: string | undefined;
  capturedAt: string;
  sha256?: string | undefined;
  rights: RightsState;
  confidence: number;
  notes?: string | undefined;
  excerpt?: string | undefined;
  retrievedAt?: string | undefined;
}

export interface Claim {
  id: string;
  text: string;
  status: "unverified" | "supported" | "disputed" | "rejected";
  sourceIds: string[];
}

export interface ResearchRun {
  id: string;
  query: string;
  depth: ResearchDepth;
  languages: string[];
  region?: string | undefined;
  sourceLimit: number;
  freshnessHours?: number | undefined;
  status: ResearchRunStatus;
  provider?: string | undefined;
  model?: string | undefined;
  responseId?: string | undefined;
  toolsUsed: string[];
  sourceCount: number;
  claimCount: number;
  error?: string | undefined;
  createdBy: string;
  createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface PlatformDraft {
  id: string;
  revision: number;
  contentSha256: string;
  createdBy: string;
  createdAt: string;
  platform: Platform;
  format: ContentFormat;
  title: string;
  caption: string;
  mediaIds: string[];
  /** Derived server-side from immutable Library lineage; callers cannot turn it off. */
  containsSyntheticMedia?: boolean | undefined;
  scheduledFor?: string | undefined;
}

export interface Approval {
  id: string;
  draftId: string;
  draftSha256: string;
  actorId: string;
  actorName: string;
  decision: "approved" | "changes-requested" | "rejected";
  note?: string | undefined;
  /** Present only on a separate human approval of exact Instagram collaborator settings. */
  instagramPublishApprovalBinding?: InstagramPublishApprovalBinding | undefined;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  draftId: string;
  draftSha256: string;
  authorId: string;
  authorName: string;
  audience: "internal" | "reviewer" | "public";
  body: string;
  createdAt: string;
}

export interface ReviewLink {
  id: string;
  draftId: string;
  draftSha256: string;
  allowComment: boolean;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string | undefined;
}

export interface PublishTarget {
  id: string;
  platform: Platform;
  accountId: string;
  draftId: string;
  scheduledFor: string;
  timezone?: string | undefined;
  deliveryMode: DeliveryMode;
  settings?: YouTubePublishSettings | InstagramPublishSettings | undefined;
  notifyDestinationId?: string | undefined;
  status: "pending" | "queued" | "action_required" | "acknowledged" | "publishing" | "published" | "failed" | "cancelled";
  actionRequiredAt?: string | undefined;
  acknowledgedAt?: string | undefined;
  acknowledgedBy?: string | undefined;
  queueAssignment?: {
    origin: "queue_assigned";
    reservationId: string;
    profileId: string;
    profileVersion: number;
    localDate: string;
    localTime: string;
    timezone: string;
    utcOffset: string;
  } | undefined;
}

type ScheduleTargetBase = Pick<PublishTarget, "accountId" | "draftId" | "scheduledFor" | "notifyDestinationId"> & {
  targetId?: string | undefined;
  deliveryMode?: DeliveryMode | undefined;
  timezone?: string | undefined;
};

export type ScheduleTargetInput = ScheduleTargetBase & (
  | { platform: "youtube"; settings: YouTubePublishSettings }
  | { platform: "instagram"; settings?: InstagramPublishSettings | undefined }
  | { platform: "facebook"; settings?: undefined }
);

export interface PublishAttempt {
  id: string;
  targetId: string;
  attemptNo: number;
  jobId?: string | undefined;
  idempotencyKey: string;
  status: "started" | "published" | "failed";
  error?: string | undefined;
  externalPostId?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
}

export interface ProviderPublishOperation {
  id: string;
  workspaceId: string;
  contentItemId: string;
  targetId: string;
  attemptId: string;
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
  /** Exact immutable collaborator authority lineage for new Instagram operations. */
  accountId?: string | undefined;
  draftSha256?: string | undefined;
  approvedSettingsSha256?: string | undefined;
  status: "creating" | "processing" | "ready" | "finalizing" | "published" | "uncertain" | "failed";
  containerId: string;
  childContainerIds: string[];
  /** Repository-owned execution fence. Never use a caller timestamp to validate it. */
  claimOwner?: string | undefined;
  claimExpiresAt?: string | undefined;
  sessionUri?: string | undefined;
  uploadedBytes?: number | undefined;
  processingChecks?: number | undefined;
  processingDeadlineAt?: string | undefined;
  externalPostId?: string | undefined;
  liveUrl?: string | undefined;
  lastError?: string | undefined;
  collaboratorInviteProof?: CollaboratorInviteProof | undefined;
  /** Durable intent/evidence for Meta's native Instagram AI-info label. */
  instagramAiDisclosureRequested?: boolean | undefined;
  instagramAiDisclosureVerified?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface PublishProof {
  id: string;
  contentItemId: string;
  draftId: string;
  draftSha256: string;
  platform: Platform;
  accountId: string;
  externalPostId: string;
  liveUrl: string;
  publishedAt: string;
  captionSha256: string;
  mediaSha256: string[];
  connectorResponseSha256: string;
  approvedBy: string;
  sourceIds: string[];
  disclosure: "none" | "ai-assisted" | "synthetic-media";
  /** How OriginPost established that the platform object exists. Legacy rows are classified at read time. */
  evidenceMode?: PublishEvidenceMode | undefined;
  instagramAiDisclosure?: { requested: boolean; observed: boolean; label: "ai_info" } | undefined;
  screenshotUrl?: string | undefined;
  approvedSettingsSha256?: string | undefined;
  collaboratorInviteProof?: CollaboratorInviteProof | undefined;
  instagramReelCoverProof?: InstagramReelCoverSelection | undefined;
}

export type PublishEvidenceMode = "official" | "manual_attestation" | "provider_reconciliation" | "simulation" | "legacy_unknown";

export interface AnalyticsMetric {
  key: AnalyticsMetricKey;
  value: number;
  unit: AnalyticsMetricUnit;
  rawMetric?: string | undefined;
  source?: "instagram_media_insights" | "instagram_media_field" | "facebook_page_post_insights" | "youtube_analytics_query" | "youtube_reporting_bulk" | "youtube_data_api" | "mock" | undefined;
  coverage?: "organic" | "paid_and_organic" | "instagram_only" | "facebook_only" | "cross_platform" | "unknown" | undefined;
  definitionVersion?: string | undefined;
  /** Whether values may be added across proof snapshots in account/report rollups. */
  aggregation?: "sum" | "non_additive" | undefined;
  caveats?: string[] | undefined;
}

export interface PostAnalyticsSnapshot {
  id: string;
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  proofId: string;
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
  accountId: string;
  externalPostId: string;
  status: AnalyticsSnapshotStatus;
  period: "lifetime";
  metrics: AnalyticsMetric[];
  rawPayloadSha256?: string | undefined;
  provider?: string | undefined;
  completeThrough?: string | undefined;
  caveats?: string[] | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  capturedAt: string;
  createdAt: string;
}

export interface ContentItem {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  title: string;
  summary: string;
  status: ContentStatus;
  researchDepth: ResearchDepth;
  riskLevel: RiskLevel;
  tags: string[];
  sources: SourceEvidence[];
  claims: Claim[];
  researchRuns: ResearchRun[];
  drafts: PlatformDraft[];
  approvals: Approval[];
  reviewComments: ReviewComment[];
  reviewLinks: ReviewLink[];
  targets: PublishTarget[];
  publishAttempts: PublishAttempt[];
  proofs: PublishProof[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  contentItemId?: string;
  actorId: string;
  actorType: "human" | "agent" | "system" | "api_key";
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceNotification {
  id: string;
  workspaceId: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  contentItemId?: string | undefined;
  targetId?: string | undefined;
  monitorId?: string | undefined;
  accountId?: string | undefined;
  actionUrl?: string | undefined;
  dedupeKey: string;
  audience?: "workspace" | "operators" | undefined;
  createdAt: string;
  readAt?: string | undefined;
  readBy?: string | undefined;
}

export type CredentialRefreshPlatform = "instagram" | "youtube";
export type OutboxTopic = "publish.target.requested" | "remote-correction.requested" | "board.plugin.reconcile" | "board.plugin.deactivate" | "board.plugin.decision" | "board.task.execute" | "channel.credential-refresh" | "provider.grant-validation" | "provider.data-deletion";
export type OutboxStatus = "pending" | "processing" | "processed" | "failed";

export interface OutboxMessageInput {
  id: string;
  workspaceId: string;
  topic: OutboxTopic;
  dedupeKey: string;
  payload: Record<string, unknown>;
  availableAt: string;
  createdAt: string;
}

export interface OutboxMessage extends OutboxMessageInput {
  status: OutboxStatus;
  attempts: number;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  lastError?: string | undefined;
  processedAt?: string | undefined;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
  oldestPendingAt?: string | undefined;
}

export type MediaKind = "image" | "video" | "audio" | "document";
export type MediaPurpose = "creative" | "evidence" | "source";
export type MediaStatus = "pending" | "ready" | "rejected" | "trashed" | "expired" | "deleted" | "cleanup_failed";
export type MediaCleanupReason = "upload-expired" | "trash-retention-ended";
export type MediaInspectionStatus = "pending" | "ready" | "unavailable" | "failed" | "not_applicable";
export type MediaMalwareScanStatus = "pending" | "clean" | "infected" | "unavailable" | "disabled";

export interface MediaAsset {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  contentItemId?: string | undefined;
  kind: MediaKind;
  purpose: MediaPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  status: MediaStatus;
  inspectionStatus: MediaInspectionStatus;
  malwareScanStatus?: MediaMalwareScanStatus | undefined;
  malwareScannedAt?: string | undefined;
  malwareScanner?: string | undefined;
  malwareThreatName?: string | undefined;
  malwareScanErrorCode?: string | undefined;
  malwareScanErrorSummary?: string | undefined;
  detectedContentType?: string | undefined;
  widthPixels?: number | undefined;
  heightPixels?: number | undefined;
  durationMs?: number | undefined;
  inspectedAt?: string | undefined;
  inspector?: string | undefined;
  inspectionErrorCode?: string | undefined;
  inspectionErrorSummary?: string | undefined;
  rights: RightsState;
  altText?: string | undefined;
  sourceUrl?: string | undefined;
  lastError?: string | undefined;
  createdBy: string;
  createdAt: string;
  uploadExpiresAt: string;
  readyAt?: string | undefined;
  syntheticLineage?: {
    kind: "ai-generation";
    generationId: string;
    provider: "openai";
    model: string;
    promptSha256: string;
    generatedAt: string;
    sourceEvidenceIds: string[];
    disclosureRequired: true;
  } | undefined;
  statusBeforeTrash?: Exclude<MediaStatus, "trashed" | "deleted" | "cleanup_failed"> | undefined;
  trashedAt?: string | undefined;
  trashExpiresAt?: string | undefined;
  trashedBy?: string | undefined;
  cleanupReason?: MediaCleanupReason | undefined;
  cleanupAfter?: string | undefined;
  cleanupAttempts?: number | undefined;
  deletedAt?: string | undefined;
}

export interface MediaReferenceSummary {
  contentItemIds: string[];
  draftIds: string[];
  proofIds: string[];
  creativeProjectIds?: string[];
  creativeRenderIds?: string[];
}

export interface MediaStorageSummary {
  totalAssets: number;
  storedBytes: number;
  reclaimableBytes: number;
  pendingBytes: number;
  counts: Partial<Record<MediaStatus, number>>;
}

export interface ConnectedAccount {
  id: string;
  workspaceId: string;
  brandId: string;
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
  displayName: string;
  externalAccountId: string;
  credentialRef?: string | undefined;
  capabilities: ChannelCapability[];
  status: ConnectedAccountStatus;
  expiresAt?: string | undefined;
  lastCheckedAt?: string | undefined;
  lastHealthyAt?: string | undefined;
  lastErrorCode?: string | undefined;
  lastErrorStep?: string | undefined;
  lastErrorSummary?: string | undefined;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ProviderGrantProvider = "meta" | "google";
export type ProviderAuthorizationKind = "instagram_login" | "facebook_login" | "google_oauth";
export type ProviderGrantStatus = "active" | "expiring" | "refresh_failed" | "reauthorization_required" | "deauthorized" | "revoked" | "deletion_pending" | "deleted" | "superseded";

export interface ProviderGrant {
  id: string;
  workspaceId: string;
  provider: ProviderGrantProvider;
  authorizationKind: ProviderAuthorizationKind;
  clientId: string;
  lookupKeyVersion: string;
  subjectLookupHmac?: string | undefined;
  refreshTokenLookupHmac?: string | undefined;
  riscTokenPrefixLookupHmac?: string | undefined;
  riscTokenDigestLookupHmac?: string | undefined;
  status: ProviderGrantStatus;
  scopes: string[];
  version: number;
  issuedAt: string;
  accessExpiresAt?: string | undefined;
  dataAccessExpiresAt?: string | undefined;
  refreshTokenExpiresAt?: string | undefined;
  nextRefreshAt?: string | undefined;
  nextValidationAt?: string | undefined;
  lastCheckedAt?: string | undefined;
  lastHealthyAt?: string | undefined;
  lastErrorCode?: string | undefined;
  lastErrorSummary?: string | undefined;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderGrantChange {
  grant?: ProviderGrant | undefined;
  unlink?: boolean | undefined;
}

export interface ProviderDataDeletionRequest {
  id: string;
  provider: Extract<ProviderGrantProvider, "meta">;
  clientId: string;
  lookupKeyVersion: string;
  subjectLookupHmac: string;
  grantGenerationSha256: string;
  confirmationNonce: string;
  confirmationCodeSha256: string;
  status: "pending" | "processing" | "completed" | "needs_review";
  scopeCount: number;
  completedScopeCount: number;
  publicSummary: string;
  requestedAt: string;
  completedAt?: string | undefined;
  updatedAt: string;
}

export interface ProviderLifecycleRepository {
  listProviderGrants(workspaceId: string, brandId?: string): Promise<Array<{ grant: ProviderGrant; accountIds: string[] }>>;
  recordProviderGrantValidation(input: { workspaceId: string; grantId: string; expectedVersion: number; outcome: "healthy" | "transient_failure" | "review_required" | "reauthorization_required"; checkedAt: string; nextValidationAt?: string | undefined; errorCode?: string | undefined; errorSummary?: string | undefined }): Promise<boolean>;
  receiveMetaDeauthorization(input: { id: string; clientId: string; lookupKeyVersion: string; subjectLookupHmac: string; lookupCandidates: Array<{ version: string; digest: string }>; payloadSha256: string; receivedAt: string }): Promise<{ created: boolean; matchedGrants: number; affectedAccounts: number }>;
  receiveMetaDataDeletion(input: { receiptId: string; requestId: string; clientId: string; lookupKeyVersion: string; subjectLookupHmac: string; lookupCandidates: Array<{ version: string; digest: string }>; payloadSha256: string; confirmationNonce: string; confirmationCodeSha256: string; receivedAt: string }): Promise<{ created: boolean; matchedGrants: number; affectedAccounts: number; request: ProviderDataDeletionRequest }>;
  getDataDeletionByConfirmationSha256(confirmationCodeSha256: string): Promise<ProviderDataDeletionRequest | null>;
  getDataDeletionScope(requestId: string, workspaceId: string): Promise<{ status: ProviderDataDeletionRequest["status"]; accountIds: string[]; hasPrivateData: boolean } | null>;
  processDataDeletionScope(requestId: string, workspaceId: string, processedAt: string): Promise<boolean>;
  failDataDeletionScope(requestId: string, workspaceId: string, errorCode: string, failedAt: string): Promise<void>;
}

export interface OAuthConnectionState {
  id: string;
  workspaceId: string;
  brandId: string;
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
  actorId: string;
  stateHash: string;
  returnUrl: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | undefined;
}

export interface EncryptedCredential {
  id: string;
  workspaceId: string;
  purpose: "oauth-state" | "provider-token" | "provider-discovery";
  keyVersion: string;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentItemRepository {
  list(workspaceId: string, brandId?: string): Promise<ContentItem[]>;
  get(workspaceId: string, id: string): Promise<ContentItem | null>;
  commit(item: ContentItem, event: AuditEvent, outbox?: OutboxMessageInput[], providerOperations?: ProviderPublishOperation[], monitorFingerprints?: MonitorFingerprint[], scheduleConflict?: import("./schedule-conflicts.js").ScheduleConflictCommit): Promise<void>;
  listAudit(workspaceId: string, contentItemId: string): Promise<AuditEvent[]>;
}

export interface CreateWorkspaceOrganizationInput {
  workspace: Workspace;
  defaultBrand: Brand;
  ownerUserId: string;
  ownerDisplayName: string;
  event: AuditEvent;
}

export interface OrganizationRepository {
  listWorkspaces(userId?: string): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace | null>;
  createWorkspace(input: CreateWorkspaceOrganizationInput): Promise<{ workspace: Workspace; defaultBrand: Brand }>;
  updateWorkspace(workspace: Workspace, event: AuditEvent): Promise<Workspace>;
  listBrands(workspaceId: string, includeArchived?: boolean): Promise<Brand[]>;
  getBrand(workspaceId: string, id: string): Promise<Brand | null>;
  saveBrand(brand: Brand, event: AuditEvent): Promise<Brand>;
}

export interface OutboxRepository {
  claimAvailable(owner: string, limit?: number, leaseSeconds?: number): Promise<OutboxMessage[]>;
  complete(workspaceId: string, id: string): Promise<void>;
  fail(workspaceId: string, id: string, error: string, retryAt: string, maxAttempts?: number): Promise<void>;
  recoverPublishTargets(): Promise<number>;
  recoverRemoteCorrections(): Promise<number>;
  recoverAgentBoardPlugins(): Promise<number>;
  recoverCredentialRefreshes(platforms: CredentialRefreshPlatform[]): Promise<number>;
  recoverProviderGrantValidations(providers: ProviderGrantProvider[]): Promise<number>;
  recoverProviderDataDeletions(): Promise<number>;
  stats(workspaceId?: string): Promise<OutboxStats>;
  list(workspaceId: string, status?: OutboxStatus, limit?: number): Promise<OutboxMessage[]>;
  retry(workspaceId: string, id: string): Promise<boolean>;
}

export interface MediaRepository {
  list(workspaceId: string, limit?: number, brandId?: string): Promise<MediaAsset[]>;
  get(workspaceId: string, id: string): Promise<MediaAsset | null>;
  save(asset: MediaAsset, event: AuditEvent): Promise<void>;
  references(workspaceId: string, id: string): Promise<MediaReferenceSummary>;
  summary(workspaceId: string, brandId?: string): Promise<MediaStorageSummary>;
  listCleanupCandidates(now: string, limit?: number, workspaceId?: string): Promise<MediaAsset[]>;
}

export interface MonitorRepository {
  list(workspaceId: string, brandId?: string): Promise<MonitorRule[]>;
  listEnabled(): Promise<MonitorRule[]>;
  get(workspaceId: string, id: string): Promise<MonitorRule | null>;
  save(rule: MonitorRule): Promise<void>;
  startRun(run: MonitorRun): Promise<boolean>;
  recordSkipped(run: MonitorRun): Promise<void>;
  finishRun(run: MonitorRun, fingerprints: MonitorFingerprint[]): Promise<void>;
  recordFingerprints(fingerprints: MonitorFingerprint[]): Promise<void>;
  listRuns(workspaceId: string, monitorId: string, limit?: number): Promise<MonitorRun[]>;
  hasFingerprint(workspaceId: string, monitorId: string, fingerprint: string): Promise<boolean>;
}

export interface ConnectedAccountRepository {
  list(workspaceId: string, brandId?: string): Promise<ConnectedAccount[]>;
  get(workspaceId: string, id: string): Promise<ConnectedAccount | null>;
  save(account: ConnectedAccount, event: AuditEvent, credentialChange?: { save?: EncryptedCredential; deleteId?: string }, providerGrantChange?: ProviderGrantChange): Promise<void>;
  saveCredentialRefreshResult(account: ConnectedAccount, event: AuditEvent, fence: { expectedCredentialRef: string; expectedExpiresAt: string }, credentialChange?: { save?: EncryptedCredential; deleteId?: string }, notification?: WorkspaceNotification): Promise<boolean>;
  completeOAuthSelection(workspaceId: string, selectionCredentialId: string, entries: Array<{ account: ConnectedAccount; event: AuditEvent; credentialChange: { save: EncryptedCredential; deleteId?: string } }>, providerGrantChange?: ProviderGrantChange): Promise<boolean>;
}

export interface OAuthRepository {
  createState(state: OAuthConnectionState): Promise<void>;
  consumeState(stateHash: string, platform: OAuthConnectionState["platform"], now: string): Promise<OAuthConnectionState | null>;
  saveCredential(credential: EncryptedCredential): Promise<void>;
  getCredential(workspaceId: string, id: string): Promise<EncryptedCredential | null>;
  hasCredential(workspaceId: string, id: string): Promise<boolean>;
  consumeCredential(workspaceId: string, id: string, purpose: EncryptedCredential["purpose"]): Promise<EncryptedCredential | null>;
  deleteCredential(workspaceId: string, id: string): Promise<void>;
}

export interface ProviderPublishOperationRepository {
  get(workspaceId: string, targetId: string): Promise<ProviderPublishOperation | null>;
  listByStatus(workspaceId: string, statuses: ProviderPublishOperation["status"][]): Promise<ProviderPublishOperation[]>;
  save(operation: ProviderPublishOperation): Promise<void>;
  claimExecution(operation: ProviderPublishOperation, owner: string, leaseSeconds?: number): Promise<{ claimed: boolean; created: boolean; operation: ProviderPublishOperation }>;
  saveClaimed(operation: ProviderPublishOperation, owner: string, leaseSeconds?: number): Promise<boolean>;
}

export interface NotificationRepository {
  list(workspaceId: string, options?: { unreadOnly?: boolean; limit?: number; includeOperatorAlerts?: boolean }): Promise<WorkspaceNotification[]>;
  countUnread(workspaceId: string, options?: { includeOperatorAlerts?: boolean }): Promise<number>;
  create(notification: WorkspaceNotification): Promise<WorkspaceNotification>;
  markRead(workspaceId: string, id: string, actorId: string, readAt: string, options?: { includeOperatorAlerts?: boolean }): Promise<WorkspaceNotification | null>;
  markAllRead(workspaceId: string, actorId: string, readAt: string, options?: { includeOperatorAlerts?: boolean }): Promise<number>;
}

export interface AnalyticsRepository {
  list(workspaceId: string, options?: { brandId?: string; proofId?: string; limit?: number }): Promise<PostAnalyticsSnapshot[]>;
  latestForProof(workspaceId: string, proofId: string): Promise<PostAnalyticsSnapshot | null>;
  save(snapshot: PostAnalyticsSnapshot, event: AuditEvent): Promise<void>;
}
