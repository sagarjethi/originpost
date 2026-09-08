import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { AuditEvent, Platform } from "./types.js";

export const engagementPlatforms = ["instagram", "facebook"] as const satisfies readonly Platform[];
export type EngagementPlatform = (typeof engagementPlatforms)[number];
export type EngagementThreadState = "open" | "resolved";
export type EngagementCommentDirection = "incoming" | "outgoing";
export type EngagementCommentVisibility = "visible" | "hidden" | "deleted";
export type EngagementCommentSource = "webhook" | "reconcile" | "action";
export type EngagementActionType = "reply";
export type EngagementActionStatus = "draft" | "pending_approval" | "queued" | "processing" | "succeeded" | "failed" | "uncertain" | "cancelled";

export interface BrandScope {
  workspaceId: string;
  brandId: string;
}

export interface EngagementThread {
  id: string;
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  proofId: string;
  accountId: string;
  platform: EngagementPlatform;
  externalMediaId: string;
  state: EngagementThreadState;
  assignedTo?: string | undefined;
  lastActivityAt: string;
  lastSyncedAt?: string | undefined;
  resolvedAt?: string | undefined;
  version: number;
}

export interface EngagementComment {
  id: string;
  workspaceId: string;
  brandId: string;
  threadId: string;
  accountId: string;
  externalMediaId: string;
  externalCommentId: string;
  parentExternalCommentId?: string | undefined;
  authorScopedId?: string | undefined;
  authorUsername?: string | undefined;
  body: string;
  bodySha256: string;
  direction: EngagementCommentDirection;
  visibility: EngagementCommentVisibility;
  providerCreatedAt?: string | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  source: EngagementCommentSource;
  rawPayloadSha256?: string | undefined;
}

export interface EngagementAction {
  id: string;
  workspaceId: string;
  brandId: string;
  threadId: string;
  commentId: string;
  type: EngagementActionType;
  body: string;
  bodySha256: string;
  status: EngagementActionStatus;
  idempotencyKey: string;
  requestedBy: string;
  approvedBy?: string | undefined;
  providerReplyId?: string | undefined;
  providerResponseSha256?: string | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  version: number;
}

export interface ReadMarker {
  lastReadAt: string;
  lastReadCommentId?: string | undefined;
}

export interface EngagementThreadSummary {
  thread: EngagementThread;
  latestComment?: EngagementComment | undefined;
  unreadCount: number;
  needsReply: boolean;
}

export interface EngagementThreadView {
  thread: EngagementThread;
  comments: EngagementComment[];
  actions: EngagementAction[];
}

export interface InboxQuery {
  viewerId: string;
  state?: EngagementThreadState | undefined;
  assignedTo?: string | undefined;
  accountId?: string | undefined;
  query?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface InboxPage {
  items: EngagementThreadSummary[];
  nextCursor?: string | undefined;
}

export interface CommentIngestBatch {
  thread: EngagementThread;
  comments: EngagementComment[];
  syncedAt: string;
}

export interface IngestResult {
  thread: EngagementThread;
  inserted: number;
  updated: number;
  reopened: boolean;
}

export interface ActionTransition {
  actionId: string;
  expectedVersion: number;
  to: EngagementActionStatus;
  actorId: string;
  at: string;
  approvedBy?: string | undefined;
  providerReplyId?: string | undefined;
  providerResponseSha256?: string | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
}

export interface EngagementThreadUpdate {
  expectedVersion: number;
  actorId: string;
  at: string;
  state?: EngagementThreadState | undefined;
  assignedTo?: string | null | undefined;
}

export type EngagementWebhookReceiptStatus = "pending" | "processing" | "processed" | "failed";

export interface EngagementWebhookReceipt {
  id: string;
  provider: EngagementPlatform;
  workspaceId: string;
  brandId: string;
  accountId: string;
  payloadSha256: string;
  normalizedEvent: Record<string, unknown>;
  status: EngagementWebhookReceiptStatus;
  attempts: number;
  availableAt: string;
  createdAt: string;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  lastError?: string | undefined;
  processedAt?: string | undefined;
}

export interface EngagementRepository {
  listThreads(scope: BrandScope, query: InboxQuery): Promise<InboxPage>;
  getThread(scope: BrandScope, id: string): Promise<EngagementThreadView | null>;
  getComment(scope: BrandScope, id: string): Promise<EngagementComment | null>;
  getAction(scope: BrandScope, id: string): Promise<EngagementAction | null>;
  updateThread(scope: BrandScope, id: string, command: EngagementThreadUpdate, event: AuditEvent): Promise<EngagementThread | null>;
  ingest(scope: BrandScope, batch: CommentIngestBatch, event: AuditEvent): Promise<IngestResult>;
  markRead(scope: BrandScope, threadId: string, userId: string, marker: ReadMarker): Promise<void>;
  saveAction(action: EngagementAction, event: AuditEvent): Promise<void>;
  transitionAction(scope: BrandScope, command: ActionTransition, event: AuditEvent): Promise<EngagementAction | null>;
  listActionsForRecovery(statuses?: EngagementActionStatus[], limit?: number): Promise<EngagementAction[]>;
  listThreadsNeedingSync(before: string, limit?: number): Promise<EngagementThread[]>;
  recordWebhookReceipt(receipt: EngagementWebhookReceipt): Promise<{ receipt: EngagementWebhookReceipt; created: boolean }>;
  claimWebhookReceipts(owner: string, limit?: number, leaseSeconds?: number): Promise<EngagementWebhookReceipt[]>;
  completeWebhookReceipt(id: string, leaseOwner: string, processedAt: string): Promise<void>;
  failWebhookReceipt(id: string, leaseOwner: string, error: string, retryAt: string, maxAttempts?: number): Promise<void>;
}

const actionTransitions: Readonly<Record<EngagementActionStatus, ReadonlySet<EngagementActionStatus>>> = {
  draft: new Set(["pending_approval", "cancelled"]),
  pending_approval: new Set(["draft", "queued", "cancelled"]),
  queued: new Set(["processing", "cancelled"]),
  processing: new Set(["succeeded", "failed", "uncertain"]),
  succeeded: new Set(),
  failed: new Set(["queued", "cancelled"]),
  uncertain: new Set(["succeeded", "failed", "cancelled"]),
  cancelled: new Set(),
};

export function engagementBodySha256(body: string): string {
  return createHash("sha256").update(body.normalize("NFC")).digest("hex");
}

export function canTransitionEngagementAction(from: EngagementActionStatus, to: EngagementActionStatus): boolean {
  return actionTransitions[from].has(to);
}

export function reviseEngagementAction(action: EngagementAction, body: string, actorId: string, at: string): EngagementAction {
  if (action.status !== "draft" && action.status !== "pending_approval") {
    throw new DomainError("Only a draft reply can be edited.", "engagement_action_not_editable", 409);
  }
  const normalized = body.normalize("NFC").trim();
  if (!normalized) throw new DomainError("Reply text is required.", "engagement_reply_empty", 400);
  const nextVersion = action.version + 1;
  const bodySha256 = engagementBodySha256(normalized);
  return {
    ...action,
    body: normalized,
    bodySha256,
    status: "draft",
    idempotencyKey: `engagement:reply:${action.id}:v${nextVersion}:${bodySha256}`,
    requestedBy: actorId,
    approvedBy: undefined,
    providerReplyId: undefined,
    providerResponseSha256: undefined,
    errorCode: undefined,
    errorSummary: undefined,
    completedAt: undefined,
    updatedAt: at,
    version: nextVersion,
  };
}

export function transitionEngagementAction(action: EngagementAction, command: ActionTransition): EngagementAction {
  if (action.id !== command.actionId || action.version !== command.expectedVersion) {
    throw new DomainError("This reply changed while you were working. Refresh it and try again.", "engagement_action_version_conflict", 409);
  }
  if (!canTransitionEngagementAction(action.status, command.to)) {
    throw new DomainError(`A reply cannot move from ${action.status} to ${command.to}.`, "engagement_action_transition_invalid", 409);
  }
  if (command.to === "queued" && (!command.approvedBy || command.approvedBy !== command.actorId)) {
    throw new DomainError("A manager or owner must approve this exact reply before it can be sent.", "engagement_approval_required", 409);
  }
  const terminal = command.to === "succeeded" || command.to === "failed" || command.to === "cancelled";
  const resetsAttempt = command.to === "draft" || command.to === "pending_approval" || command.to === "queued" || command.to === "processing";
  return {
    ...action,
    status: command.to,
    updatedAt: command.at,
    version: action.version + 1,
    approvedBy: command.to === "draft" ? undefined : (command.approvedBy ?? action.approvedBy),
    providerReplyId: resetsAttempt ? undefined : (command.providerReplyId ?? action.providerReplyId),
    providerResponseSha256: resetsAttempt ? undefined : (command.providerResponseSha256 ?? action.providerResponseSha256),
    errorCode: resetsAttempt || command.to === "succeeded" || command.to === "cancelled" ? undefined : (command.errorCode ?? action.errorCode),
    errorSummary: resetsAttempt || command.to === "succeeded" || command.to === "cancelled" ? undefined : (command.errorSummary?.slice(0, 500) ?? action.errorSummary),
    completedAt: terminal ? command.at : undefined,
  };
}
