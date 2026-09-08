import { createHmac } from "node:crypto";
import { DomainError } from "./errors.js";
import type { AuditEvent } from "./types.js";
import type { BrandScope } from "./engagement.js";

export const privateConversationPlatforms = ["instagram", "facebook"] as const;
export type PrivateConversationPlatform = (typeof privateConversationPlatforms)[number];

export const privateConversationConnectionModes = [
  "facebook_page_messenger",
  "instagram_linked_page",
  "instagram_login",
] as const;
export type PrivateConversationConnectionMode = (typeof privateConversationConnectionModes)[number];

export type PrivateConversationState = "open" | "resolved";
export type PrivateMessageDirection = "incoming" | "outgoing";
export type PrivateMessageKind = "text" | "image" | "video" | "audio" | "file" | "share" | "sticker" | "unsupported";
export type PrivateMessageSource = "webhook" | "reconcile" | "action";
export type PrivateMessageAvailability = "available" | "deleted" | "expired";
export type PrivateMessageDeliveryState = "unknown" | "sent" | "delivered" | "read" | "failed";
export type PrivateMessageObservationKind = "message" | "echo" | "deleted" | "delivery" | "read" | "reaction";
export type PrivateReplyIntentStatus =
  | "draft"
  | "pending_approval"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "expired";

export function privateConversationPlatformForMode(mode: PrivateConversationConnectionMode): PrivateConversationPlatform {
  return mode === "facebook_page_messenger" ? "facebook" : "instagram";
}

export interface PrivateConversation {
  id: string;
  workspaceId: string;
  brandId: string;
  accountId: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  providerConversationKey: string;
  state: PrivateConversationState;
  assignedTo?: string | undefined;
  lastInboundAt?: string | undefined;
  lastOutboundAt?: string | undefined;
  lastActivityAt: string;
  lastSyncedAt?: string | undefined;
  resolvedAt?: string | undefined;
  version: number;
}

export interface PrivateConversationParticipant {
  id: string;
  workspaceId: string;
  brandId: string;
  conversationId: string;
  accountId: string;
  providerParticipantKey: string;
  role: "business" | "customer" | "unknown";
  displayName?: string | undefined;
  username?: string | undefined;
  avatarUrl?: string | undefined;
  avatarExpiresAt?: string | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PrivateMessageAttachment {
  id: string;
  providerAttachmentKey?: string | undefined;
  kind: Exclude<PrivateMessageKind, "text">;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  url?: string | undefined;
  expiresAt?: string | undefined;
  cachePolicy: "reference_only" | "import_required" | "never_cache";
  availability: "available" | "expired" | "deleted" | "unsupported";
}

export interface PrivateMessage {
  id: string;
  workspaceId: string;
  brandId: string;
  conversationId: string;
  accountId: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  providerMessageKey: string;
  senderParticipantId?: string | undefined;
  direction: PrivateMessageDirection;
  kind: PrivateMessageKind;
  body?: string | undefined;
  bodyIntegrityKey?: string | undefined;
  attachments: PrivateMessageAttachment[];
  replyToMessageId?: string | undefined;
  isEcho: boolean;
  availability: PrivateMessageAvailability;
  deliveryState: PrivateMessageDeliveryState;
  deliveredAt?: string | undefined;
  readAt?: string | undefined;
  deletedAt?: string | undefined;
  providerCreatedAt?: string | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  source: PrivateMessageSource;
  observationKind: PrivateMessageObservationKind;
  rawPayloadSha256?: string | undefined;
}

export interface PrivateMessageMutationObservation {
  kind: "deleted" | "delivery" | "read";
  observedAt: string;
  deliveryState?: PrivateMessageDeliveryState | undefined;
}

export interface PrivateHumanAgentReviewEvidence {
  reviewedAt: string;
  expiresAt?: string | undefined;
  referenceSha256: string;
  humanOnly: true;
  contractVersion: string;
}

export type PrivateReplyEligibilityEvidence =
  | {
      mode: "standard";
      qualifyingEventAt: string;
      durationSeconds: number;
    }
  | {
      mode: "human_agent";
      qualifyingEventAt: string;
      durationSeconds: number;
      review: PrivateHumanAgentReviewEvidence;
    };

export interface PrivateReplyEligibility {
  state: "eligible" | "ineligible" | "unknown";
  checkedAt: string;
  expiresAt?: string | undefined;
  reason?:
    | "window_closed"
    | "permission_missing"
    | "account_disconnected"
    | "conversation_closed"
    | "provider_restricted"
    | "contract_unverified"
    | "provider_unavailable"
    | undefined;
  evidence?: PrivateReplyEligibilityEvidence | undefined;
  contractVersion: string;
}

export interface PrivateTextContract {
  maxUtf8Bytes?: number | undefined;
  maxCharacters?: number | undefined;
  supportsReplyToMessage: boolean;
  contractVersion: string;
}

export interface PrivateReplyIntent {
  id: string;
  workspaceId: string;
  brandId: string;
  conversationId: string;
  inReplyToMessageId: string;
  body: string;
  bodyIntegrityKey: string;
  status: PrivateReplyIntentStatus;
  idempotencyKey: string;
  requestedBy: string;
  approvedBy?: string | undefined;
  eligibilityAtApproval?: PrivateReplyEligibility | undefined;
  providerMessageKey?: string | undefined;
  providerAcceptedAt?: string | undefined;
  providerResponseSha256?: string | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  attemptCount: number;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  version: number;
}

export interface PrivateReadMarker {
  lastReadAt: string;
  lastReadMessageId?: string | undefined;
}

export type PrivateConversationRecordView = Omit<PrivateConversation, "providerConversationKey">;
export type PrivateConversationParticipantView = Omit<PrivateConversationParticipant, "providerParticipantKey">;
export type PrivateMessageView = Omit<PrivateMessage, "providerMessageKey" | "bodyIntegrityKey" | "rawPayloadSha256">;
export type PrivateReplyIntentView = Omit<
  PrivateReplyIntent,
  "bodyIntegrityKey" | "idempotencyKey" | "providerMessageKey" | "providerResponseSha256" | "leaseOwner" | "leaseExpiresAt"
>;

export interface PrivateConversationSummary {
  conversation: PrivateConversationRecordView;
  participants: PrivateConversationParticipantView[];
  latestMessage?: PrivateMessageView | undefined;
  unreadCount: number;
  needsReply: boolean;
  replyEligibility: PrivateReplyEligibility;
}

export interface PrivateConversationView {
  conversation: PrivateConversationRecordView;
  participants: PrivateConversationParticipantView[];
  messages: PrivateMessageView[];
  replyIntents: PrivateReplyIntentView[];
  replyEligibility: PrivateReplyEligibility;
}

export interface PrivateInboxQuery {
  viewerId: string;
  state?: PrivateConversationState | undefined;
  assignedTo?: string | undefined;
  accountId?: string | undefined;
  platform?: PrivateConversationPlatform | undefined;
  connectionMode?: PrivateConversationConnectionMode | undefined;
  attention?: "unread" | "needs_reply" | "mine" | undefined;
  eligibility?: PrivateReplyEligibility["state"] | undefined;
  query?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface PrivateInboxPage {
  items: PrivateConversationSummary[];
  nextCursor?: string | undefined;
}

export interface PrivateConversationUpdate {
  expectedVersion: number;
  actorId: string;
  at: string;
  state?: PrivateConversationState | undefined;
  assignedTo?: string | null | undefined;
}

export interface PrivateProviderParticipantObservation {
  externalParticipantId: string;
  role: PrivateConversationParticipant["role"];
  displayName?: string | undefined;
  username?: string | undefined;
  avatarUrl?: string | undefined;
  avatarExpiresAt?: string | undefined;
}

export interface PrivateProviderAttachmentObservation {
  externalAttachmentId?: string | undefined;
  kind: Exclude<PrivateMessageKind, "text">;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  url?: string | undefined;
  expiresAt?: string | undefined;
  cachePolicy: PrivateMessageAttachment["cachePolicy"];
  availability: PrivateMessageAttachment["availability"];
}

export interface PrivateProviderMessageObservation {
  externalMessageId: string;
  externalSenderId?: string | undefined;
  direction: PrivateMessageDirection;
  kind: PrivateMessageKind;
  body?: string | undefined;
  attachments: PrivateProviderAttachmentObservation[];
  replyToExternalMessageId?: string | undefined;
  isEcho: boolean;
  availability: PrivateMessageAvailability;
  deliveryState: PrivateMessageDeliveryState;
  deliveredAt?: string | undefined;
  readAt?: string | undefined;
  deletedAt?: string | undefined;
  providerCreatedAt?: string | undefined;
  observationKind: PrivateMessageObservationKind;
  reaction?: {
    action: "react" | "unreact";
    value?: string | undefined;
    externalActorId?: string | undefined;
  } | undefined;
  observedAt: string;
  rawPayloadSha256?: string | undefined;
}

/**
 * Clear provider identifiers enter persistence only through this server-side
 * observation input. A repository adapter must hash lookup keys and encrypt
 * reversible references before committing the batch.
 */
export interface PrivateProviderObservationBatch {
  accountId: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  externalConversationId: string;
  participants: PrivateProviderParticipantObservation[];
  messages: PrivateProviderMessageObservation[];
  replyEligibility: PrivateReplyEligibility;
  syncedAt: string;
}

export interface PrivateIngestResult {
  conversation: PrivateConversation;
  inserted: number;
  updated: number;
  deleted: number;
  reopened: boolean;
}

export interface PrivateReplyTransition {
  intentId: string;
  expectedVersion: number;
  to: PrivateReplyIntentStatus;
  actorId: string;
  at: string;
  approvedBy?: string | undefined;
  eligibilityAtApproval?: PrivateReplyEligibility | undefined;
  providerMessageKey?: string | undefined;
  providerAcceptedAt?: string | undefined;
  providerResponseSha256?: string | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  leaseOwner?: string | undefined;
}

export interface PrivateReplyClaim {
  intentId: string;
  expectedVersion: number;
  owner: string;
  at: string;
  leaseSeconds: number;
}

export interface PrivateReplyRecovery {
  intentId: string;
  expectedVersion: number;
  actorId: string;
  at: string;
}

/**
 * Server-only projection for one provider send. Clear provider identifiers
 * must never be returned by an authenticated inbox response DTO.
 */
export interface PrivateReplyExecutionContext {
  intent: PrivateReplyIntent;
  conversation: PrivateConversation;
  anchorMessage: PrivateMessage;
  externalConversationId: string;
  externalRecipientId: string;
  inReplyToExternalMessageId: string;
}

/**
 * Server-only read context used to check provider policy before human approval.
 * It deliberately omits the recipient identifier needed to perform a send.
 */
export interface PrivateReplyApprovalContext {
  intent: PrivateReplyIntent;
  conversation: PrivateConversation;
  anchorMessage: PrivateMessage;
  externalConversationId: string;
}

export interface PrivateConversationSyncState {
  workspaceId: string;
  brandId: string;
  accountId: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  cursor?: string | undefined;
  lastAttemptedAt?: string | undefined;
  lastSucceededAt?: string | undefined;
  nextSyncAt: string;
  failureCount: number;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  version: number;
}

export interface PrivateConversationSyncPage {
  syncState: PrivateConversationSyncState;
  batches: PrivateProviderObservationBatch[];
  nextCursor?: string | undefined;
  fetchedAt: string;
}

export interface PrivateSyncPageResult {
  conversations: number;
  inserted: number;
  updated: number;
  deleted: number;
  reopened: number;
}

export type PrivateMessageWebhookReceiptStatus = "pending" | "processing" | "processed" | "failed";

export interface PrivateMessageWebhookReceipt {
  id: string;
  provider: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  workspaceId: string;
  brandId: string;
  accountId: string;
  payloadSha256: string;
  normalizedEvent: Record<string, unknown>;
  status: PrivateMessageWebhookReceiptStatus;
  attempts: number;
  availableAt: string;
  createdAt: string;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  lastError?: string | undefined;
  processedAt?: string | undefined;
}

export interface PrivateProviderMessageDeletion {
  accountId: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  externalMessageId: string;
  observedAt: string;
  rawPayloadSha256?: string | undefined;
}

export interface PrivateProviderMessageDeletionResult {
  found: boolean;
  alreadyDeleted: boolean;
}

export interface PrivateRetentionPurgeResult {
  messages: number;
  replyIntents: number;
  participants: number;
  receipts: number;
}

export interface PrivateProviderErasureResult extends PrivateRetentionPurgeResult {
  conversations: number;
}

export interface PrivateConversationRepository {
  list(scope: BrandScope, query: PrivateInboxQuery): Promise<PrivateInboxPage>;
  get(scope: BrandScope, id: string, viewerId: string): Promise<PrivateConversationView | null>;
  updateConversation(scope: BrandScope, id: string, command: PrivateConversationUpdate, event: AuditEvent): Promise<PrivateConversationRecordView | null>;
  markRead(scope: BrandScope, conversationId: string, userId: string, marker: PrivateReadMarker): Promise<void>;

  ingestProviderObservations(scope: BrandScope, batch: PrivateProviderObservationBatch, event: AuditEvent): Promise<PrivateIngestResult>;
  getMessage(scope: BrandScope, id: string): Promise<PrivateMessage | null>;
  /** Immediately erases provider-deleted message content by its account-scoped provider ID. */
  applyProviderMessageDeletion(scope: BrandScope, command: PrivateProviderMessageDeletion, event: AuditEvent): Promise<PrivateProviderMessageDeletionResult>;

  saveReplyIntent(intent: PrivateReplyIntent, event: AuditEvent): Promise<void>;
  getReplyIntent(scope: BrandScope, id: string): Promise<PrivateReplyIntent | null>;
  /** Saves one domain-validated revision while preserving immutable lineage. */
  reviseReplyIntent(scope: BrandScope, revised: PrivateReplyIntent, event: AuditEvent): Promise<PrivateReplyIntent | null>;
  getReplyApprovalContext(scope: BrandScope, intentId: string): Promise<PrivateReplyApprovalContext | null>;
  transitionReplyIntent(scope: BrandScope, command: PrivateReplyTransition, event: AuditEvent): Promise<PrivateReplyIntent | null>;
  /** Atomically changes queued -> processing, acquires the lease, and returns decrypted execution identifiers. */
  claimReplyIntentForExecution(scope: BrandScope, command: PrivateReplyClaim, event: AuditEvent): Promise<PrivateReplyExecutionContext | null>;
  getReplyExecutionContext(scope: BrandScope, intentId: string): Promise<PrivateReplyExecutionContext | null>;
  /**
   * Fences an expired processing lease and moves the intent to uncertain.
   * Repository adapters must decide lease expiry with their authoritative
   * clock; caller-provided timestamps are audit data, not lease authority.
   */
  recoverExpiredReplyIntent(scope: BrandScope, command: PrivateReplyRecovery, event: AuditEvent): Promise<PrivateReplyIntent | null>;

  getSyncState(scope: BrandScope, accountId: string): Promise<PrivateConversationSyncState | null>;
  saveSyncPage(scope: BrandScope, page: PrivateConversationSyncPage, event: AuditEvent): Promise<PrivateSyncPageResult>;
  listAccountsNeedingSync(before: string, limit?: number): Promise<PrivateConversationSyncState[]>;

  recordWebhookReceipt(receipt: PrivateMessageWebhookReceipt): Promise<{ receipt: PrivateMessageWebhookReceipt; created: boolean }>;
  claimWebhookReceipts(owner: string, limit?: number, leaseSeconds?: number): Promise<PrivateMessageWebhookReceipt[]>;
  completeWebhookReceipt(id: string, owner: string, processedAt: string): Promise<void>;
  failWebhookReceipt(id: string, owner: string, error: string, retryAt: string, maxAttempts?: number): Promise<void>;

  listReplyIntentsForRecovery(statuses?: PrivateReplyIntentStatus[], limit?: number): Promise<PrivateReplyIntent[]>;
  purgeExpired(now: string, limit?: number): Promise<PrivateRetentionPurgeResult>;
  /** Crypto-shreds reversible provider identifiers and content for whole accounts. */
  eraseProviderData(workspaceId: string, accountIds: string[], erasedAt: string): Promise<PrivateProviderErasureResult>;
}

const replyTransitions: Readonly<Record<PrivateReplyIntentStatus, ReadonlySet<PrivateReplyIntentStatus>>> = {
  draft: new Set(["pending_approval", "cancelled"]),
  pending_approval: new Set(["draft", "queued", "cancelled"]),
  queued: new Set(["failed", "expired", "cancelled"]),
  processing: new Set(["succeeded", "failed", "uncertain", "expired"]),
  succeeded: new Set(),
  failed: new Set(["pending_approval", "cancelled"]),
  uncertain: new Set(["succeeded", "failed"]),
  cancelled: new Set(),
  expired: new Set(["pending_approval", "cancelled"]),
};

export function privateConversationBodyIntegrityKey(body: string, key: Uint8Array): string {
  if (key.byteLength < 32) {
    throw new DomainError("The private-message body-integrity key must contain at least 32 bytes.", "private_message_integrity_key_invalid", 500);
  }
  return createHmac("sha256", key).update(body.normalize("NFC")).digest("hex");
}

const deliveryRank: Readonly<Record<PrivateMessageDeliveryState, number>> = {
  unknown: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 1,
};

export function applyPrivateMessageObservation(message: PrivateMessage, observation: PrivateMessageMutationObservation): PrivateMessage {
  if (!validIso(observation.observedAt)) {
    throw new DomainError("The private-message observation time is invalid.", "private_message_observation_time_invalid", 400);
  }
  if (observation.kind === "deleted") {
    return {
      ...message,
      body: undefined,
      bodyIntegrityKey: undefined,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        providerAttachmentKey: undefined,
        url: undefined,
        availability: "deleted",
      })),
      availability: "deleted",
      deletedAt: observation.observedAt,
      lastSeenAt: observation.observedAt,
      observationKind: "deleted",
    };
  }
  if (message.availability === "deleted") return message;
  const requested = observation.kind === "read" ? "read" : (observation.deliveryState ?? "delivered");
  const deliveryState = deliveryRank[requested] >= deliveryRank[message.deliveryState] ? requested : message.deliveryState;
  return {
    ...message,
    deliveryState,
    ...(deliveryState === "delivered" && !message.deliveredAt ? { deliveredAt: observation.observedAt } : {}),
    ...(deliveryState === "read" ? { readAt: observation.observedAt, deliveredAt: message.deliveredAt ?? observation.observedAt } : {}),
    lastSeenAt: observation.observedAt,
    observationKind: observation.kind,
  };
}

export function canTransitionPrivateReplyIntent(from: PrivateReplyIntentStatus, to: PrivateReplyIntentStatus): boolean {
  return replyTransitions[from].has(to);
}

function validIso(value: string | undefined): boolean {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function assertEligibleSnapshot(value: PrivateReplyEligibility | undefined): asserts value is PrivateReplyEligibility {
  if (!value || value.state !== "eligible" || !validIso(value.checkedAt) || !value.contractVersion) {
    throw new DomainError("A current provider reply-eligibility check is required before approval.", "private_reply_eligibility_required", 409);
  }
  if (value.expiresAt && (!validIso(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.checkedAt))) {
    throw new DomainError("The provider reply-eligibility window is invalid.", "private_reply_eligibility_invalid", 409);
  }
  if (value.evidence && (!validIso(value.evidence.qualifyingEventAt) || !Number.isInteger(value.evidence.durationSeconds) || value.evidence.durationSeconds < 1)) {
    throw new DomainError("The provider reply-eligibility evidence is invalid.", "private_reply_eligibility_evidence_invalid", 409);
  }
  if (value.evidence?.mode === "human_agent" && (
    !value.evidence.review.humanOnly
    || !validIso(value.evidence.review.reviewedAt)
    || !/^[0-9a-f]{64}$/.test(value.evidence.review.referenceSha256)
    || (value.evidence.review.expiresAt !== undefined && (!validIso(value.evidence.review.expiresAt) || Date.parse(value.evidence.review.expiresAt) <= Date.parse(value.checkedAt)))
  )) {
    throw new DomainError("Reviewed Human Agent evidence is required for this manual-reply window.", "private_reply_human_agent_evidence_required", 409);
  }
}

export function revisePrivateReplyIntent(intent: PrivateReplyIntent, body: string, actorId: string, at: string, digestKey: Uint8Array): PrivateReplyIntent {
  if (!["draft", "pending_approval", "failed", "expired"].includes(intent.status)) {
    throw new DomainError("This private reply cannot be edited in its current state.", "private_reply_not_editable", 409);
  }
  const normalized = body.normalize("NFC").trim();
  if (!normalized) throw new DomainError("Reply text is required.", "private_reply_empty", 400);
  const nextVersion = intent.version + 1;
  const bodyIntegrityKey = privateConversationBodyIntegrityKey(normalized, digestKey);
  return {
    ...intent,
    body: normalized,
    bodyIntegrityKey,
    status: "pending_approval",
    idempotencyKey: `private-message:reply:${intent.id}:v${nextVersion}:${bodyIntegrityKey}`,
    requestedBy: actorId,
    approvedBy: undefined,
    eligibilityAtApproval: undefined,
    providerMessageKey: undefined,
    providerAcceptedAt: undefined,
    providerResponseSha256: undefined,
    errorCode: undefined,
    errorSummary: undefined,
    attemptCount: 0,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    completedAt: undefined,
    updatedAt: at,
    version: nextVersion,
  };
}

export function claimPrivateReplyIntent(intent: PrivateReplyIntent, command: PrivateReplyClaim): PrivateReplyIntent {
  if (intent.id !== command.intentId || intent.version !== command.expectedVersion) {
    throw new DomainError("This private reply changed before it could be claimed.", "private_reply_version_conflict", 409);
  }
  if (intent.status !== "queued") {
    throw new DomainError("Only a queued private reply can be claimed for sending.", "private_reply_not_queued", 409);
  }
  if (!command.owner.trim() || !validIso(command.at) || !Number.isInteger(command.leaseSeconds) || command.leaseSeconds < 1 || command.leaseSeconds > 3_600) {
    throw new DomainError("The private-reply execution lease is invalid.", "private_reply_lease_invalid", 400);
  }
  return {
    ...intent,
    status: "processing",
    attemptCount: intent.attemptCount + 1,
    leaseOwner: command.owner,
    leaseExpiresAt: new Date(Date.parse(command.at) + command.leaseSeconds * 1_000).toISOString(),
    updatedAt: command.at,
    completedAt: undefined,
    version: intent.version + 1,
  };
}

export function transitionPrivateReplyIntent(intent: PrivateReplyIntent, command: PrivateReplyTransition): PrivateReplyIntent {
  if (intent.id !== command.intentId || intent.version !== command.expectedVersion) {
    throw new DomainError("This private reply changed while you were working. Refresh it and try again.", "private_reply_version_conflict", 409);
  }
  if (!canTransitionPrivateReplyIntent(intent.status, command.to)) {
    throw new DomainError(`A private reply cannot move from ${intent.status} to ${command.to}.`, "private_reply_transition_invalid", 409);
  }
  if (intent.status === "processing" && intent.leaseOwner && command.leaseOwner !== intent.leaseOwner) {
    throw new DomainError("This private reply is leased by another worker.", "private_reply_lease_conflict", 409);
  }
  if (command.to === "queued") {
    if (!command.approvedBy || command.approvedBy !== command.actorId) {
      throw new DomainError("A manager or owner must approve this exact private reply before it can be sent.", "private_reply_approval_required", 409);
    }
    assertEligibleSnapshot(command.eligibilityAtApproval);
  }
  if (command.to === "succeeded" && (!command.providerMessageKey || !validIso(command.providerAcceptedAt))) {
    throw new DomainError("Exact provider send evidence is required before a private reply can be marked sent.", "private_reply_provider_evidence_required", 409);
  }

  const completed = new Set<PrivateReplyIntentStatus>(["succeeded", "failed", "cancelled", "expired"]);
  const clearsAttempt = new Set<PrivateReplyIntentStatus>(["draft", "pending_approval", "queued", "processing"]);
  const clear = clearsAttempt.has(command.to);
  return {
    ...intent,
    status: command.to,
    updatedAt: command.at,
    version: intent.version + 1,
    approvedBy: command.to === "draft" || command.to === "pending_approval" ? undefined : (command.approvedBy ?? intent.approvedBy),
    eligibilityAtApproval: command.to === "draft" || command.to === "pending_approval"
      ? undefined
      : (command.eligibilityAtApproval ?? intent.eligibilityAtApproval),
    providerMessageKey: clear ? undefined : (command.providerMessageKey ?? intent.providerMessageKey),
    providerAcceptedAt: clear ? undefined : (command.providerAcceptedAt ?? intent.providerAcceptedAt),
    providerResponseSha256: clear ? undefined : (command.providerResponseSha256 ?? intent.providerResponseSha256),
    errorCode: clear || command.to === "succeeded" || command.to === "cancelled" ? undefined : (command.errorCode ?? intent.errorCode),
    errorSummary: clear || command.to === "succeeded" || command.to === "cancelled"
      ? undefined
      : (command.errorSummary?.slice(0, 500) ?? intent.errorSummary),
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    completedAt: completed.has(command.to) ? command.at : undefined,
  };
}
