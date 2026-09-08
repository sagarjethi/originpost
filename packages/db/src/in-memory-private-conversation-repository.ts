import {
  DomainError,
  applyPrivateMessageObservation,
  privateConversationPlatformForMode,
  transitionPrivateReplyIntent,
  type AuditEvent,
  type BrandScope,
  type PrivateConversation,
  type PrivateConversationRecordView,
  type PrivateConversationParticipant,
  type PrivateConversationParticipantView,
  type PrivateConversationRepository,
  type PrivateConversationSyncPage,
  type PrivateConversationSyncState,
  type PrivateConversationUpdate,
  type PrivateInboxPage,
  type PrivateInboxQuery,
  type PrivateIngestResult,
  type PrivateMessage,
  type PrivateMessageView,
  type PrivateMessageAttachment,
  type PrivateMessageWebhookReceipt,
  type PrivateProviderMessageDeletion,
  type PrivateProviderMessageDeletionResult,
  type PrivateProviderObservationBatch,
  type PrivateProviderErasureResult,
  type PrivateReadMarker,
  type PrivateReplyApprovalContext,
  type PrivateReplyClaim,
  type PrivateReplyExecutionContext,
  type PrivateReplyRecovery,
  type PrivateReplyIntent,
  type PrivateReplyIntentView,
  type PrivateReplyEligibility,
  type PrivateReplyIntentStatus,
  type PrivateReplyTransition,
  type PrivateRetentionPurgeResult,
  type PrivateSyncPageResult,
} from "@originpost/domain";
import { PrivateConversationCipher, type PrivateConversationKeys, type PrivateEnvelope } from "./private-conversation-crypto.js";

type StoredConversation = Omit<PrivateConversation, "providerConversationKey"> & {
  providerConversationKeyHash: string;
  providerConversationKeyEnvelope: PrivateEnvelope;
  replyEligibility: PrivateReplyEligibility;
  createdAt: string;
  updatedAt: string;
};
type StoredParticipant = Omit<PrivateConversationParticipant, "providerParticipantKey" | "displayName" | "username" | "avatarUrl" | "avatarExpiresAt"> & {
  providerParticipantKeyHash: string;
  providerParticipantKeyEnvelope: PrivateEnvelope;
  profileEnvelope?: PrivateEnvelope | undefined;
  retainUntil: string;
  redactedAt?: string | undefined;
};
type StoredMessage = Omit<PrivateMessage, "providerMessageKey" | "body" | "bodyIntegrityKey" | "attachments"> & {
  providerMessageKeyHash: string;
  providerMessageKeyEnvelope: PrivateEnvelope;
  bodyEnvelope?: PrivateEnvelope | undefined;
  bodyIntegrityHash?: string | undefined;
  attachmentsEnvelope: PrivateEnvelope;
  retainUntil: string;
  tombstonedAt?: string | undefined;
  updatedAt?: string | undefined;
};
type StoredReplyIntent = Omit<PrivateReplyIntent, "body" | "bodyIntegrityKey" | "providerMessageKey"> & {
  accountId: string;
  bodyEnvelope?: PrivateEnvelope | undefined;
  bodyIntegrityHash?: string | undefined;
  providerMessageKeyHash?: string | undefined;
  providerMessageKeyEnvelope?: PrivateEnvelope | undefined;
  leaseFence: number;
  retainUntil: string;
  tombstonedAt?: string | undefined;
};
type StoredSyncState = Omit<PrivateConversationSyncState, "cursor"> & { cursorEnvelope?: PrivateEnvelope | undefined; leaseFence: number };
type StoredReceipt = Omit<PrivateMessageWebhookReceipt, "normalizedEvent"> & { normalizedEventEnvelope: PrivateEnvelope; leaseFence: number; retainUntil: string };

function plusDays(value: string, days: number): string { return new Date(Date.parse(value) + days * 86_400_000).toISOString(); }
function boundedLimit(value: number | undefined, fallback: number, maximum: number): number { return Math.max(1, Math.min(value ?? fallback, maximum)); }
function clone<T>(value: T): T { return structuredClone(value); }
function maxIso(...values: Array<string | undefined>): string | undefined { return values.filter(Boolean).sort().at(-1); }

export class InMemoryPrivateConversationRepository implements PrivateConversationRepository {
  private readonly cipher: PrivateConversationCipher;
  private conversations = new Map<string, StoredConversation>();
  private participants = new Map<string, StoredParticipant>();
  private messages = new Map<string, StoredMessage>();
  private reads = new Map<string, PrivateReadMarker>();
  private intents = new Map<string, StoredReplyIntent>();
  private syncStates = new Map<string, StoredSyncState>();
  private receipts = new Map<string, StoredReceipt>();
  private readonly audits: AuditEvent[] = [];
  private readonly tombstones = new Set<string>();

  constructor(keys: PrivateConversationKeys, private readonly clock: () => Date = () => new Date()) {
    this.cipher = new PrivateConversationCipher(keys);
  }

  async eraseProviderData(workspaceId: string, accountIds: string[], erasedAt: string): Promise<PrivateProviderErasureResult> {
    const accountSet = new Set(accountIds);
    const conversationIds = new Set([...this.conversations.values()].filter((entry) => entry.workspaceId === workspaceId && accountSet.has(entry.accountId)).map((entry) => entry.id));
    const count = <T extends { workspaceId: string; accountId: string }>(map: Map<string, T>) => [...map.values()].filter((entry) => entry.workspaceId === workspaceId && accountSet.has(entry.accountId)).length;
    const result = { conversations: conversationIds.size, participants: count(this.participants), messages: count(this.messages), replyIntents: count(this.intents), receipts: count(this.receipts) };
    for (const [id, entry] of this.conversations) if (entry.workspaceId === workspaceId && accountSet.has(entry.accountId)) this.conversations.delete(id);
    for (const map of [this.participants, this.messages, this.intents, this.receipts] as Array<Map<string, { workspaceId: string; accountId: string }>>) for (const [id, entry] of map) if (entry.workspaceId === workspaceId && accountSet.has(entry.accountId)) map.delete(id);
    for (const [id, entry] of this.syncStates) if (entry.workspaceId === workspaceId && accountSet.has(entry.accountId)) this.syncStates.delete(id);
    for (const [id] of this.reads) if ([...conversationIds].some((conversationId) => id.includes(conversationId))) this.reads.delete(id);
    void erasedAt;
    return result;
  }

  async list(scope: BrandScope, query: PrivateInboxQuery): Promise<PrivateInboxPage> {
    const search = query.query?.normalize("NFC").trim().toLocaleLowerCase();
    const all = [...this.conversations.values()]
      .filter((entry) => entry.workspaceId === scope.workspaceId && entry.brandId === scope.brandId)
      .filter((entry) => !query.state || entry.state === query.state)
      .filter((entry) => !query.assignedTo || entry.assignedTo === query.assignedTo)
      .filter((entry) => !query.accountId || entry.accountId === query.accountId)
      .filter((entry) => !query.platform || entry.platform === query.platform)
      .filter((entry) => !query.connectionMode || entry.connectionMode === query.connectionMode)
      .filter((entry) => !query.eligibility || entry.replyEligibility.state === query.eligibility)
      .filter((entry) => {
        const summary = this.summary(entry, query.viewerId);
        if (query.attention === "unread" && summary.unreadCount === 0) return false;
        if (query.attention === "needs_reply" && !summary.needsReply) return false;
        if (query.attention === "mine" && entry.assignedTo !== query.viewerId) return false;
        if (!search) return true;
        return [...summary.participants.map((p) => `${p.displayName ?? ""} ${p.username ?? ""}`), summary.latestMessage?.body ?? ""]
          .join(" ").toLocaleLowerCase().includes(search);
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id));
    const start = query.cursor ? Math.max(0, all.findIndex((entry) => entry.id === query.cursor) + 1) : 0;
    const limit = boundedLimit(query.limit, 30, 100);
    const selected = all.slice(start, start + limit);
    const items = selected.map((entry) => this.summary(entry, query.viewerId));
    const nextCursor = start + selected.length < all.length ? selected.at(-1)?.id : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async get(scope: BrandScope, id: string, viewerId: string) {
    const stored = this.conversations.get(id);
    if (!stored || !this.inScope(scope, stored)) return null;
    return {
      conversation: this.publicConversation(stored),
      participants: this.participantsFor(id).map((entry) => this.publicParticipant(entry)),
      messages: this.messagesFor(id).map((entry) => this.publicMessage(entry)),
      replyIntents: this.intentsFor(id).filter((entry) => !entry.tombstonedAt).map((entry) => this.publicIntent(entry)),
      replyEligibility: clone(stored.replyEligibility),
    };
  }

  async updateConversation(scope: BrandScope, id: string, command: PrivateConversationUpdate, event: AuditEvent): Promise<PrivateConversationRecordView | null> {
    this.assertAudit(scope, event, command.actorId);
    const current = this.conversations.get(id);
    if (!current || !this.inScope(scope, current)) return null;
    if (current.version !== command.expectedVersion) throw new DomainError("This private conversation changed. Refresh it and try again.", "private_conversation_version_conflict", 409);
    const state = command.state ?? current.state;
    const next: StoredConversation = {
      ...current,
      state,
      ...(Object.hasOwn(command, "assignedTo") ? { assignedTo: command.assignedTo ?? undefined } : {}),
      resolvedAt: state === "resolved" ? (current.resolvedAt ?? command.at) : undefined,
      version: current.version + 1,
      updatedAt: command.at,
    };
    this.conversations.set(id, next); this.audits.push(clone(event));
    return this.publicConversation(next);
  }

  async markRead(scope: BrandScope, conversationId: string, userId: string, marker: PrivateReadMarker): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || !this.inScope(scope, conversation)) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    if (marker.lastReadMessageId && !this.messagesFor(conversationId).some((entry) => entry.id === marker.lastReadMessageId)) throw new DomainError("The read marker message is not in this conversation.", "private_read_marker_invalid", 400);
    const key = this.readKey(scope, conversationId, userId); const current = this.reads.get(key);
    if (!current || marker.lastReadAt >= current.lastReadAt) this.reads.set(key, clone(marker));
  }

  async ingestProviderObservations(scope: BrandScope, batch: PrivateProviderObservationBatch, event: AuditEvent): Promise<PrivateIngestResult> {
    this.assertObservationScope(scope, batch); this.assertAudit(scope, event);
    const result = this.ingestInternal(scope, batch);
    this.audits.push(clone(event));
    return result;
  }

  async getMessage(scope: BrandScope, id: string): Promise<PrivateMessage | null> {
    const value = this.messages.get(id);
    return value && this.inScope(scope, value) ? this.fullMessage(value) : null;
  }

  async applyProviderMessageDeletion(scope: BrandScope, command: PrivateProviderMessageDeletion, event: AuditEvent): Promise<PrivateProviderMessageDeletionResult> {
    this.assertAudit(scope, event);
    if (command.platform !== privateConversationPlatformForMode(command.connectionMode)) throw new Error("Private provider deletion lineage is invalid.");
    const providerHash = this.cipher.hash(scope.workspaceId, command.accountId, "message", command.externalMessageId);
    const current = [...this.messages.values()].find((entry) => entry.accountId === command.accountId && entry.providerMessageKeyHash === providerHash && this.inScope(scope, entry));
    if (!current) { this.audits.push(clone(event)); return { found: false, alreadyDeleted: false }; }
    if (current.platform !== command.platform || current.connectionMode !== command.connectionMode) throw new DomainError("The provider-deleted message does not match this connection.", "private_message_lineage_conflict", 409);
    const alreadyDeleted = current.availability === "deleted";
    this.messages.set(current.id, {
      ...current,
      bodyEnvelope: undefined,
      bodyIntegrityHash: undefined,
      attachmentsEnvelope: this.cipher.seal(scope.workspaceId, "message-attachments", current.id, []),
      availability: "deleted",
      deletedAt: current.deletedAt ?? command.observedAt,
      lastSeenAt: command.observedAt,
      source: "webhook",
      observationKind: "deleted",
      ...(command.rawPayloadSha256 ? { rawPayloadSha256: command.rawPayloadSha256 } : {}),
      tombstonedAt: current.tombstonedAt ?? command.observedAt,
      updatedAt: command.observedAt,
    });
    this.tombstones.add(`message:${current.id}`);
    this.audits.push(clone(event));
    return { found: true, alreadyDeleted };
  }

  async saveReplyIntent(intent: PrivateReplyIntent, event: AuditEvent): Promise<void> {
    const scope = { workspaceId: intent.workspaceId, brandId: intent.brandId }; this.assertAudit(scope, event, intent.requestedBy);
    const conversation = this.conversations.get(intent.conversationId); const anchor = this.messages.get(intent.inReplyToMessageId);
    if (!conversation || !anchor || !this.inScope(scope, conversation) || !this.inScope(scope, anchor) || anchor.conversationId !== conversation.id) throw new DomainError("Private reply lineage is invalid.", "private_reply_lineage_invalid", 400);
    if (this.cipher.bodyIntegrityKey(intent.body) !== intent.bodyIntegrityKey) throw new DomainError("Private reply integrity is invalid.", "private_reply_body_hash_invalid", 400);
    const existing = this.intents.get(intent.id);
    if (existing) {
      const same = existing.version === intent.version && existing.bodyIntegrityHash === this.integrity(scope.workspaceId, conversation.accountId, intent.body);
      if (same) return;
      throw new DomainError("This private reply changed. Refresh it and try again.", "private_reply_version_conflict", 409);
    }
    if (intent.version !== 1 || intent.attemptCount !== 0 || intent.leaseOwner || intent.leaseExpiresAt) throw new DomainError("A new private reply has invalid execution state.", "private_reply_initial_state_invalid", 400);
    if ([...this.intents.values()].some((entry) => entry.workspaceId === intent.workspaceId && entry.idempotencyKey === intent.idempotencyKey)) throw new DomainError("This exact private reply already exists.", "private_reply_duplicate", 409);
    if (["queued", "processing", "uncertain"].includes(intent.status) && this.hasOtherProviderWrite(intent.workspaceId, intent.conversationId, intent.id)) throw new DomainError("This conversation already has a reply being sent or reconciled.", "private_reply_provider_write_conflict", 409);
    const { body: _body, bodyIntegrityKey: _integrity, providerMessageKey: _providerMessageKey, ...intentMetadata } = intent;
    this.intents.set(intent.id, {
      ...intentMetadata,
      accountId: conversation.accountId,
      bodyEnvelope: this.cipher.seal(intent.workspaceId, "reply-body", intent.id, intent.body),
      bodyIntegrityHash: this.integrity(intent.workspaceId, conversation.accountId, intent.body),
      providerMessageKeyHash: undefined,
      providerMessageKeyEnvelope: undefined,
      leaseFence: 0,
      retainUntil: plusDays(intent.createdAt, 90),
    });
    this.audits.push(clone(event));
  }

  async getReplyIntent(scope: BrandScope, id: string): Promise<PrivateReplyIntent | null> {
    const value = this.intents.get(id); return value && !value.tombstonedAt && this.inScope(scope, value) ? this.fullIntent(value) : null;
  }

  async reviseReplyIntent(scope: BrandScope, revised: PrivateReplyIntent, event: AuditEvent): Promise<PrivateReplyIntent | null> {
    this.assertAudit(scope, event, revised.requestedBy);
    const current = this.intents.get(revised.id);
    if (!current || current.tombstonedAt || !this.inScope(scope, current)) return null;
    if (revised.workspaceId !== current.workspaceId || revised.brandId !== current.brandId || revised.conversationId !== current.conversationId || revised.inReplyToMessageId !== current.inReplyToMessageId || revised.createdAt !== current.createdAt || revised.version !== current.version + 1 || revised.status !== "pending_approval" || !revised.body.trim() || !/^[0-9a-f]{64}$/.test(revised.bodyIntegrityKey) || this.cipher.bodyIntegrityKey(revised.body) !== revised.bodyIntegrityKey || revised.approvedBy || revised.providerMessageKey || revised.leaseOwner || revised.leaseExpiresAt || revised.attemptCount !== 0) {
      throw new DomainError("This private reply revision is invalid or stale.", "private_reply_revision_conflict", 409);
    }
    const { body: _body, bodyIntegrityKey: _integrity, providerMessageKey: _provider, ...metadata } = revised;
    const next: StoredReplyIntent = { ...current, ...metadata, bodyEnvelope: this.cipher.seal(scope.workspaceId, "reply-body", revised.id, revised.body), bodyIntegrityHash: revised.bodyIntegrityKey, providerMessageKeyHash: undefined, providerMessageKeyEnvelope: undefined, leaseOwner: undefined, leaseExpiresAt: undefined };
    this.intents.set(next.id, next); this.audits.push(clone(event)); return this.fullIntent(next);
  }

  async getReplyApprovalContext(scope: BrandScope, intentId: string): Promise<PrivateReplyApprovalContext | null> {
    const current = this.intents.get(intentId);
    if (!current || current.tombstonedAt || !this.inScope(scope, current) || current.status !== "pending_approval") return null;
    return this.approvalContext(current);
  }

  async transitionReplyIntent(scope: BrandScope, command: PrivateReplyTransition, event: AuditEvent): Promise<PrivateReplyIntent | null> {
    this.assertAudit(scope, event, command.actorId);
    const current = this.intents.get(command.intentId);
    if (!current || !this.inScope(scope, current)) return null;
    if (current.status === "processing" && (!command.leaseOwner || command.leaseOwner !== current.leaseOwner || !current.leaseExpiresAt || this.clock().toISOString() >= current.leaseExpiresAt)) throw new DomainError("The private reply execution lease is stale.", "private_reply_lease_stale", 409);
    if (["queued", "processing", "uncertain"].includes(command.to) && this.hasOtherProviderWrite(scope.workspaceId, current.conversationId, current.id)) throw new DomainError("This conversation already has a reply being sent or reconciled.", "private_reply_provider_write_conflict", 409);
    const publicCurrent = this.fullIntent(current); const next = transitionPrivateReplyIntent(publicCurrent, command);
    const clearsLease = next.status !== "processing";
    const { body: _body, bodyIntegrityKey: _integrity, providerMessageKey: _providerMessageKey, ...nextMetadata } = next;
    const stored: StoredReplyIntent = {
      ...current,
      ...nextMetadata,
      accountId: current.accountId,
      bodyEnvelope: current.bodyEnvelope,
      bodyIntegrityHash: current.bodyIntegrityHash,
      providerMessageKeyHash: command.providerMessageKey ? this.cipher.hash(scope.workspaceId, current.accountId, "message", command.providerMessageKey) : current.providerMessageKeyHash,
      providerMessageKeyEnvelope: command.providerMessageKey ? this.cipher.seal(scope.workspaceId, "reply-provider-message", current.id, command.providerMessageKey) : current.providerMessageKeyEnvelope,
      leaseOwner: clearsLease ? undefined : current.leaseOwner,
      leaseExpiresAt: clearsLease ? undefined : current.leaseExpiresAt,
      leaseFence: current.leaseFence,
      retainUntil: current.retainUntil,
    };
    this.intents.set(current.id, stored); this.audits.push(clone(event)); return this.fullIntent(stored);
  }

  async claimReplyIntentForExecution(scope: BrandScope, command: PrivateReplyClaim, event: AuditEvent): Promise<PrivateReplyExecutionContext | null> {
    this.assertAudit(scope, event);
    const current = this.intents.get(command.intentId);
    if (!current || !this.inScope(scope, current)) return null;
    if (current.status !== "queued" || current.version !== command.expectedVersion) throw new DomainError("This private reply is not available to send.", "private_reply_claim_conflict", 409);
    if (!Number.isInteger(command.leaseSeconds) || command.leaseSeconds < 5 || command.leaseSeconds > 900) throw new DomainError("The private reply lease is invalid.", "private_reply_lease_invalid", 400);
    const now = this.clock(); const fence = current.leaseFence + 1; const leaseOwner = `${command.owner}:${fence}`; const leaseExpiresAt = new Date(now.getTime() + command.leaseSeconds * 1000).toISOString();
    const stored: StoredReplyIntent = { ...current, status: "processing", attemptCount: current.attemptCount + 1, leaseOwner, leaseExpiresAt, leaseFence: fence, updatedAt: now.toISOString(), version: current.version + 1 };
    this.intents.set(current.id, stored); this.audits.push(clone(event));
    return this.executionContext(stored);
  }

  async getReplyExecutionContext(scope: BrandScope, intentId: string): Promise<PrivateReplyExecutionContext | null> {
    const current = this.intents.get(intentId);
    if (!current || !this.inScope(scope, current) || current.status !== "processing" || !current.leaseExpiresAt || current.leaseExpiresAt <= this.clock().toISOString()) return null;
    return this.executionContext(current);
  }

  async recoverExpiredReplyIntent(scope: BrandScope, command: PrivateReplyRecovery, event: AuditEvent): Promise<PrivateReplyIntent | null> {
    this.assertAudit(scope, event, command.actorId);
    const current = this.intents.get(command.intentId);
    if (!current || current.tombstonedAt || !this.inScope(scope, current)) return null;
    const now = this.clock().toISOString();
    if (current.version !== command.expectedVersion || current.status !== "processing" || !current.leaseExpiresAt || current.leaseExpiresAt > now) {
      throw new DomainError("This private reply is not an expired send attempt.", "private_reply_recovery_conflict", 409);
    }
    const next: StoredReplyIntent = {
      ...current,
      status: "uncertain",
      errorCode: "send_outcome_unknown",
      errorSummary: "The provider outcome was not recorded before the execution lease expired.",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseFence: current.leaseFence + 1,
      updatedAt: now,
      version: current.version + 1,
    };
    this.intents.set(next.id, next);
    this.audits.push(clone(event));
    return this.fullIntent(next);
  }

  async getSyncState(scope: BrandScope, accountId: string): Promise<PrivateConversationSyncState | null> {
    const state = this.syncStates.get(accountId); return state && this.inScope(scope, state) ? this.publicSyncState(state) : null;
  }

  async saveSyncPage(scope: BrandScope, page: PrivateConversationSyncPage, event: AuditEvent): Promise<PrivateSyncPageResult> {
    this.assertAudit(scope, event); const state = page.syncState;
    if (state.workspaceId !== scope.workspaceId || state.brandId !== scope.brandId || page.batches.some((batch) => batch.accountId !== state.accountId || batch.platform !== state.platform || batch.connectionMode !== state.connectionMode)) throw new Error("Private sync page lineage is invalid.");
    const current = this.syncStates.get(state.accountId);
    if (current && (current.version !== state.version || (current.leaseOwner && current.leaseOwner !== state.leaseOwner))) throw new DomainError("The private sync cursor changed.", "private_sync_version_conflict", 409);
    const snapshot = this.snapshot();
    try {
      const aggregate: PrivateSyncPageResult = { conversations: 0, inserted: 0, updated: 0, deleted: 0, reopened: 0 };
      for (const batch of page.batches) {
        this.assertObservationScope(scope, batch); const result = this.ingestInternal(scope, batch);
        aggregate.conversations += 1; aggregate.inserted += result.inserted; aggregate.updated += result.updated; aggregate.deleted += result.deleted; aggregate.reopened += result.reopened ? 1 : 0;
      }
      const nowVersion = (current?.version ?? 0) + 1;
      const { cursor: _cursor, ...stateMetadata } = state;
      this.syncStates.set(state.accountId, {
        ...stateMetadata,
        cursorEnvelope: page.nextCursor ? this.cipher.seal(scope.workspaceId, "sync-cursor", state.accountId, page.nextCursor) : undefined,
        lastAttemptedAt: page.fetchedAt, lastSucceededAt: page.fetchedAt, failureCount: 0, errorCode: undefined, errorSummary: undefined,
        leaseOwner: undefined, leaseExpiresAt: undefined, leaseFence: current?.leaseFence ?? 0, version: nowVersion,
      });
      this.audits.push(clone(event)); return aggregate;
    } catch (error) { this.restore(snapshot); throw error; }
  }

  async listAccountsNeedingSync(before: string, limit = 100): Promise<PrivateConversationSyncState[]> {
    return [...this.syncStates.values()].filter((entry) => entry.nextSyncAt <= before && (!entry.leaseExpiresAt || entry.leaseExpiresAt < before))
      .sort((a, b) => a.nextSyncAt.localeCompare(b.nextSyncAt) || a.accountId.localeCompare(b.accountId)).slice(0, boundedLimit(limit, 100, 500)).map((entry) => this.publicSyncState(entry));
  }

  async recordWebhookReceipt(receipt: PrivateMessageWebhookReceipt) {
    const existing = [...this.receipts.values()].find((entry) => entry.provider === receipt.provider && entry.connectionMode === receipt.connectionMode && entry.accountId === receipt.accountId && entry.payloadSha256 === receipt.payloadSha256);
    if (existing) return { receipt: this.publicReceipt(existing), created: false };
    const { normalizedEvent, ...receiptMetadata } = receipt;
    const stored: StoredReceipt = { ...receiptMetadata, normalizedEventEnvelope: this.cipher.seal(receipt.workspaceId, "webhook-event", receipt.id, normalizedEvent), leaseFence: 0, retainUntil: plusDays(receipt.createdAt, 30) };
    this.receipts.set(receipt.id, stored); return { receipt: this.publicReceipt(stored), created: true };
  }

  async claimWebhookReceipts(owner: string, limit = 25, leaseSeconds = 60): Promise<PrivateMessageWebhookReceipt[]> {
    const now = this.clock(); const selected = [...this.receipts.values()].filter((entry) => Date.parse(entry.availableAt) <= now.getTime() && (entry.status === "pending" || (entry.status === "processing" && Boolean(entry.leaseExpiresAt) && Date.parse(entry.leaseExpiresAt!) < now.getTime())))
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.id.localeCompare(b.id)).slice(0, boundedLimit(limit, 25, 100));
    return selected.map((entry) => { const fence = entry.leaseFence + 1; const stored: StoredReceipt = { ...entry, status: "processing", attempts: entry.attempts + 1, leaseFence: fence, leaseOwner: `${owner}:${fence}`, leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString() }; this.receipts.set(entry.id, stored); return this.publicReceipt(stored); });
  }

  async completeWebhookReceipt(id: string, owner: string, processedAt: string): Promise<void> {
    const current = this.receipts.get(id); if (!current || current.status !== "processing" || current.leaseOwner !== owner || !current.leaseExpiresAt || this.clock().toISOString() >= current.leaseExpiresAt) throw new DomainError("The webhook receipt lease is stale.", "private_webhook_lease_stale", 409);
    this.receipts.set(id, { ...current, status: "processed", processedAt, leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  async failWebhookReceipt(id: string, owner: string, error: string, retryAt: string, maxAttempts = 10): Promise<void> {
    const current = this.receipts.get(id); if (!current || current.status !== "processing" || current.leaseOwner !== owner || !current.leaseExpiresAt || this.clock().toISOString() >= current.leaseExpiresAt) throw new DomainError("The webhook receipt lease is stale.", "private_webhook_lease_stale", 409);
    this.receipts.set(id, { ...current, status: current.attempts >= maxAttempts ? "failed" : "pending", availableAt: retryAt, lastError: error.slice(0, 500), leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  async listReplyIntentsForRecovery(statuses: PrivateReplyIntentStatus[] = ["queued", "processing", "uncertain"], limit = 100): Promise<PrivateReplyIntent[]> {
    const now = this.clock().toISOString();
    return [...this.intents.values()].filter((entry) => statuses.includes(entry.status) && (entry.status !== "processing" || Boolean(entry.leaseExpiresAt && entry.leaseExpiresAt <= now))).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)).slice(0, boundedLimit(limit, 100, 500)).map((entry) => this.fullIntent(entry));
  }

  async purgeExpired(now: string, limit = 500): Promise<PrivateRetentionPurgeResult> {
    const max = boundedLimit(limit, 500, 2000); let messages = 0, replyIntents = 0, participants = 0, receipts = 0;
    for (const [id, entry] of [...this.messages].filter(([, value]) => !value.tombstonedAt && value.retainUntil <= now).slice(0, max)) { const attachments = this.fullMessage(entry).attachments.map((a) => ({ ...a, providerAttachmentKey: undefined, url: undefined, availability: "expired" as const })); this.messages.set(id, { ...entry, bodyEnvelope: undefined, bodyIntegrityHash: undefined, attachmentsEnvelope: this.cipher.seal(entry.workspaceId, "message-attachments", id, attachments), availability: "expired", tombstonedAt: now, updatedAt: now }); this.tombstones.add(`message:${id}`); messages += 1; }
    for (const [id, entry] of [...this.intents].filter(([, value]) => !value.tombstonedAt && ["succeeded", "failed", "cancelled", "expired"].includes(value.status) && value.retainUntil <= now).slice(0, max)) { this.intents.set(id, { ...entry, bodyEnvelope: undefined, bodyIntegrityHash: undefined, providerMessageKeyEnvelope: undefined, tombstonedAt: now }); this.tombstones.add(`reply:${id}`); replyIntents += 1; }
    for (const [id, entry] of [...this.participants].filter(([, value]) => !value.redactedAt && value.retainUntil <= now).slice(0, max)) { this.participants.set(id, { ...entry, profileEnvelope: undefined, redactedAt: now }); this.tombstones.add(`participant:${id}`); participants += 1; }
    for (const [id] of [...this.receipts].filter(([, value]) => ["processed", "failed"].includes(value.status) && value.retainUntil <= now).slice(0, max)) { this.receipts.delete(id); this.tombstones.add(`receipt:${id}`); receipts += 1; }
    return { messages, replyIntents, participants, receipts };
  }

  private ingestInternal(scope: BrandScope, batch: PrivateProviderObservationBatch): PrivateIngestResult {
    const conversationHash = this.cipher.hash(scope.workspaceId, batch.accountId, "conversation", batch.externalConversationId);
    const existing = [...this.conversations.values()].find((entry) => entry.accountId === batch.accountId && entry.providerConversationKeyHash === conversationHash);
    const conversationId = existing?.id ?? `private_conversation_${conversationHash.slice(0, 32)}`;
    if (existing && (existing.platform !== batch.platform || existing.connectionMode !== batch.connectionMode || !this.inScope(scope, existing))) throw new DomainError("The provider conversation is already linked outside this scope.", "private_conversation_lineage_conflict", 409);
    const participantByExternal = new Map<string, string>();
    for (const observation of batch.participants) {
      const hash = this.cipher.hash(scope.workspaceId, batch.accountId, "participant", observation.externalParticipantId); const prior = [...this.participants.values()].find((entry) => entry.accountId === batch.accountId && entry.providerParticipantKeyHash === hash);
      const id = prior?.id ?? `private_participant_${hash.slice(0, 32)}`; if (prior && prior.conversationId !== conversationId) throw new DomainError("The provider participant is linked to another conversation.", "private_participant_lineage_conflict", 409);
      const profile = { displayName: observation.displayName, username: observation.username, avatarUrl: observation.avatarUrl, avatarExpiresAt: observation.avatarExpiresAt };
      this.participants.set(id, { id, workspaceId: scope.workspaceId, brandId: scope.brandId, conversationId, accountId: batch.accountId, providerParticipantKeyHash: hash, providerParticipantKeyEnvelope: prior?.providerParticipantKeyEnvelope ?? this.cipher.seal(scope.workspaceId, "participant-key", id, observation.externalParticipantId), role: observation.role, profileEnvelope: Object.values(profile).some(Boolean) ? this.cipher.seal(scope.workspaceId, "participant-profile", id, profile) : undefined, firstSeenAt: prior?.firstSeenAt ?? batch.syncedAt, lastSeenAt: batch.syncedAt, retainUntil: plusDays(batch.syncedAt, 90), redactedAt: undefined });
      participantByExternal.set(observation.externalParticipantId, id);
    }
    let inserted = 0, updated = 0, deleted = 0; let newIncoming = false;
    for (const observation of batch.messages) {
      const hash = this.cipher.hash(scope.workspaceId, batch.accountId, "message", observation.externalMessageId); const prior = [...this.messages.values()].find((entry) => entry.accountId === batch.accountId && entry.providerMessageKeyHash === hash); const id = prior?.id ?? `private_message_${hash.slice(0, 32)}`;
      if (prior && prior.conversationId !== conversationId) throw new DomainError("The provider message is linked to another conversation.", "private_message_lineage_conflict", 409);
      if (prior) {
        let next = this.fullMessage(prior);
        if (observation.observationKind === "deleted" || observation.availability === "deleted") { next = applyPrivateMessageObservation(next, { kind: "deleted", observedAt: observation.observedAt }); if (prior.availability !== "deleted") deleted += 1; }
        else if (observation.observationKind === "delivery") next = applyPrivateMessageObservation(next, { kind: "delivery", observedAt: observation.observedAt, deliveryState: observation.deliveryState });
        else if (observation.observationKind === "read") next = applyPrivateMessageObservation(next, { kind: "read", observedAt: observation.observedAt });
        this.messages.set(id, { ...prior, availability: next.availability, deliveryState: next.deliveryState, deliveredAt: next.deliveredAt, readAt: next.readAt, deletedAt: next.deletedAt, lastSeenAt: maxIso(prior.lastSeenAt, observation.observedAt)!, observationKind: observation.observationKind, bodyEnvelope: next.body === undefined ? undefined : prior.bodyEnvelope, bodyIntegrityHash: next.bodyIntegrityKey === undefined ? undefined : prior.bodyIntegrityHash, attachmentsEnvelope: next.availability === "deleted" ? this.cipher.seal(scope.workspaceId, "message-attachments", id, next.attachments) : prior.attachmentsEnvelope, tombstonedAt: next.availability === "deleted" ? observation.observedAt : prior.tombstonedAt, updatedAt: observation.observedAt } as StoredMessage); updated += 1; continue;
      }
      const senderId = observation.externalSenderId ? (participantByExternal.get(observation.externalSenderId) ?? [...this.participants.values()].find((p) => p.accountId === batch.accountId && p.providerParticipantKeyHash === this.cipher.hash(scope.workspaceId, batch.accountId, "participant", observation.externalSenderId!))?.id) : undefined;
      const replyHash = observation.replyToExternalMessageId ? this.cipher.hash(scope.workspaceId, batch.accountId, "message", observation.replyToExternalMessageId) : undefined; const replyId = replyHash ? [...this.messages.values()].find((m) => m.accountId === batch.accountId && m.providerMessageKeyHash === replyHash)?.id : undefined;
      const attachments: PrivateMessageAttachment[] = observation.attachments.map((attachment, index) => ({ id: `private_attachment_${this.cipher.hash(scope.workspaceId, batch.accountId, "attachment", `${observation.externalMessageId}:${attachment.externalAttachmentId ?? index}`).slice(0, 32)}`, ...(attachment.externalAttachmentId ? { providerAttachmentKey: this.cipher.hash(scope.workspaceId, batch.accountId, "attachment-provider", attachment.externalAttachmentId) } : {}), ...attachment }));
      const deletedMessage = observation.availability === "deleted"; const body = deletedMessage ? undefined : observation.body?.normalize("NFC");
      const stored: StoredMessage = { id, workspaceId: scope.workspaceId, brandId: scope.brandId, conversationId, accountId: batch.accountId, platform: batch.platform, connectionMode: batch.connectionMode, providerMessageKeyHash: hash, providerMessageKeyEnvelope: this.cipher.seal(scope.workspaceId, "message-key", id, observation.externalMessageId), senderParticipantId: senderId, direction: observation.direction, kind: observation.kind, bodyEnvelope: body ? this.cipher.seal(scope.workspaceId, "message-body", id, body) : undefined, bodyIntegrityHash: body ? this.integrity(scope.workspaceId, batch.accountId, body) : undefined, attachmentsEnvelope: this.cipher.seal(scope.workspaceId, "message-attachments", id, deletedMessage ? attachments.map((a) => ({ ...a, providerAttachmentKey: undefined, url: undefined, availability: "deleted" })) : attachments), replyToMessageId: replyId, isEcho: observation.isEcho, availability: observation.availability, deliveryState: observation.deliveryState, deliveredAt: observation.deliveredAt, readAt: observation.readAt, deletedAt: observation.deletedAt ?? (deletedMessage ? observation.observedAt : undefined), providerCreatedAt: observation.providerCreatedAt, firstSeenAt: observation.observedAt, lastSeenAt: observation.observedAt, source: observation.observationKind === "message" || observation.observationKind === "echo" ? (observation.isEcho ? "webhook" : "webhook") : "reconcile", observationKind: observation.observationKind, rawPayloadSha256: observation.rawPayloadSha256, retainUntil: plusDays(observation.observedAt, 90), tombstonedAt: deletedMessage ? observation.observedAt : undefined };
      this.messages.set(id, stored); inserted += 1; if (observation.direction === "incoming") newIncoming = true; if (deletedMessage) { deleted += 1; this.tombstones.add(`message:${id}`); }
    }
    const messages = this.messagesFor(conversationId); const lastInboundAt = maxIso(existing?.lastInboundAt, ...messages.filter((m) => m.direction === "incoming").map((m) => m.providerCreatedAt ?? m.firstSeenAt)); const lastOutboundAt = maxIso(existing?.lastOutboundAt, ...messages.filter((m) => m.direction === "outgoing").map((m) => m.providerCreatedAt ?? m.firstSeenAt)); const lastActivityAt = maxIso(existing?.lastActivityAt, lastInboundAt, lastOutboundAt, batch.syncedAt)!; const reopened = Boolean(existing?.state === "resolved" && newIncoming);
    const storedConversation: StoredConversation = { id: conversationId, workspaceId: scope.workspaceId, brandId: scope.brandId, accountId: batch.accountId, platform: batch.platform, connectionMode: batch.connectionMode, providerConversationKeyHash: conversationHash, providerConversationKeyEnvelope: existing?.providerConversationKeyEnvelope ?? this.cipher.seal(scope.workspaceId, "conversation-key", conversationId, batch.externalConversationId), state: reopened ? "open" : (existing?.state ?? "open"), assignedTo: existing?.assignedTo, replyEligibility: clone(batch.replyEligibility), lastInboundAt, lastOutboundAt, lastActivityAt, lastSyncedAt: batch.syncedAt, resolvedAt: reopened ? undefined : existing?.resolvedAt, version: existing ? existing.version + (reopened ? 1 : 0) : 1, createdAt: existing?.createdAt ?? batch.syncedAt, updatedAt: batch.syncedAt };
    this.conversations.set(conversationId, storedConversation); return { conversation: this.fullConversation(storedConversation), inserted, updated, deleted, reopened };
  }

  private summary(entry: StoredConversation, viewerId: string) { const messages = this.messagesFor(entry.id).map((m) => this.publicMessage(m)); const latestMessage = messages.at(-1); const read = this.reads.get(this.readKey(entry, entry.id, viewerId)); const unreadCount = messages.filter((m) => m.direction === "incoming" && m.availability === "available" && (!read || (m.providerCreatedAt ?? m.firstSeenAt) > read.lastReadAt)).length; const incoming = [...messages].reverse().find((m) => m.direction === "incoming" && m.availability === "available"); const outgoing = [...messages].reverse().find((m) => m.direction === "outgoing" && m.availability === "available"); return { conversation: this.publicConversation(entry), participants: this.participantsFor(entry.id).map((p) => this.publicParticipant(p)), ...(latestMessage ? { latestMessage } : {}), unreadCount, needsReply: Boolean(incoming && (!outgoing || (incoming.providerCreatedAt ?? incoming.firstSeenAt) > (outgoing.providerCreatedAt ?? outgoing.firstSeenAt))), replyEligibility: clone(entry.replyEligibility) }; }
  private publicConversation(value: StoredConversation): PrivateConversationRecordView { const { providerConversationKeyHash: _h, providerConversationKeyEnvelope: _e, replyEligibility: _r, createdAt: _c, updatedAt: _u, ...rest } = value; return clone(rest); }
  private fullConversation(value: StoredConversation, reveal = false): PrivateConversation { return { ...this.publicConversation(value), providerConversationKey: reveal ? this.cipher.open(value.workspaceId, "conversation-key", value.id, value.providerConversationKeyEnvelope) : value.providerConversationKeyHash }; }
  private publicParticipant(value: StoredParticipant): PrivateConversationParticipantView { const profile = value.profileEnvelope && !value.redactedAt ? this.cipher.openJson<{ displayName?: string; username?: string; avatarUrl?: string; avatarExpiresAt?: string }>(value.workspaceId, "participant-profile", value.id, value.profileEnvelope) : {}; const { providerParticipantKeyHash: _h, providerParticipantKeyEnvelope: _e, profileEnvelope: _p, retainUntil: _r, redactedAt: _d, ...rest } = value; return { ...clone(rest), ...profile }; }
  private fullMessage(value: StoredMessage, reveal = false): PrivateMessage { const body = value.bodyEnvelope ? this.cipher.open(value.workspaceId, "message-body", value.id, value.bodyEnvelope) : undefined; const attachments = this.cipher.openJson<PrivateMessageAttachment[]>(value.workspaceId, "message-attachments", value.id, value.attachmentsEnvelope); const { providerMessageKeyHash, providerMessageKeyEnvelope, bodyEnvelope: _b, bodyIntegrityHash, attachmentsEnvelope: _a, retainUntil: _r, tombstonedAt: _t, ...rest } = value; return { ...clone(rest), providerMessageKey: reveal ? this.cipher.open(value.workspaceId, "message-key", value.id, providerMessageKeyEnvelope) : providerMessageKeyHash, ...(body !== undefined ? { body, bodyIntegrityKey: bodyIntegrityHash } : {}), attachments }; }
  private publicMessage(value: StoredMessage): PrivateMessageView { const { providerMessageKey: _p, bodyIntegrityKey: _i, rawPayloadSha256: _r, ...view } = this.fullMessage(value); return view; }
  private fullIntent(value: StoredReplyIntent): PrivateReplyIntent { if (!value.bodyEnvelope || !value.bodyIntegrityHash) throw new DomainError("Private reply content has expired.", "private_reply_expired", 410); const body = this.cipher.open(value.workspaceId, "reply-body", value.id, value.bodyEnvelope); const { accountId: _a, bodyEnvelope: _b, bodyIntegrityHash, providerMessageKeyHash: _h, providerMessageKeyEnvelope, leaseFence: _f, retainUntil: _r, tombstonedAt: _t, ...rest } = value; return { ...clone(rest), body, bodyIntegrityKey: bodyIntegrityHash, ...(providerMessageKeyEnvelope ? { providerMessageKey: this.cipher.open(value.workspaceId, "reply-provider-message", value.id, providerMessageKeyEnvelope) } : {}) }; }
  private publicIntent(value: StoredReplyIntent): PrivateReplyIntentView { const { bodyIntegrityKey: _b, idempotencyKey: _i, providerMessageKey: _p, providerResponseSha256: _r, leaseOwner: _o, leaseExpiresAt: _e, ...view } = this.fullIntent(value); return view; }
  private publicSyncState(value: StoredSyncState): PrivateConversationSyncState { const cursor = value.cursorEnvelope ? this.cipher.open(value.workspaceId, "sync-cursor", value.accountId, value.cursorEnvelope) : undefined; const { cursorEnvelope: _e, leaseFence: _f, ...rest } = value; return { ...clone(rest), ...(cursor ? { cursor } : {}) }; }
  private publicReceipt(value: StoredReceipt): PrivateMessageWebhookReceipt { const normalizedEvent = this.cipher.openJson<Record<string, unknown>>(value.workspaceId, "webhook-event", value.id, value.normalizedEventEnvelope); const { normalizedEventEnvelope: _e, leaseFence: _f, retainUntil: _r, ...rest } = value; return { ...clone(rest), normalizedEvent }; }
  private executionContext(value: StoredReplyIntent): PrivateReplyExecutionContext { const conversation = this.conversations.get(value.conversationId); const anchor = this.messages.get(value.inReplyToMessageId); if (!conversation || !anchor) throw new DomainError("The private reply execution lineage is unavailable.", "private_reply_execution_lineage_missing", 409); const customer = this.participantsFor(conversation.id).find((entry) => entry.role === "customer"); if (!customer) throw new DomainError("The private reply recipient is unavailable.", "private_reply_recipient_missing", 409); return { intent: this.fullIntent(value), conversation: this.fullConversation(conversation, true), anchorMessage: this.fullMessage(anchor, true), externalConversationId: this.cipher.open(conversation.workspaceId, "conversation-key", conversation.id, conversation.providerConversationKeyEnvelope), externalRecipientId: this.cipher.open(customer.workspaceId, "participant-key", customer.id, customer.providerParticipantKeyEnvelope), inReplyToExternalMessageId: this.cipher.open(anchor.workspaceId, "message-key", anchor.id, anchor.providerMessageKeyEnvelope) }; }
  private approvalContext(value: StoredReplyIntent): PrivateReplyApprovalContext { const conversation = this.conversations.get(value.conversationId); const anchor = this.messages.get(value.inReplyToMessageId); if (!conversation || !anchor) throw new DomainError("The private reply approval lineage is unavailable.", "private_reply_approval_lineage_missing", 409); return { intent: this.fullIntent(value), conversation: this.fullConversation(conversation, true), anchorMessage: this.fullMessage(anchor, true), externalConversationId: this.cipher.open(conversation.workspaceId, "conversation-key", conversation.id, conversation.providerConversationKeyEnvelope) }; }
  private participantsFor(conversationId: string) { return [...this.participants.values()].filter((entry) => entry.conversationId === conversationId).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)); }
  private messagesFor(conversationId: string) { return [...this.messages.values()].filter((entry) => entry.conversationId === conversationId).sort((a, b) => (a.providerCreatedAt ?? a.firstSeenAt).localeCompare(b.providerCreatedAt ?? b.firstSeenAt) || a.id.localeCompare(b.id)); }
  private intentsFor(conversationId: string) { return [...this.intents.values()].filter((entry) => entry.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
  private inScope(scope: BrandScope, value: { workspaceId: string; brandId: string }) { return value.workspaceId === scope.workspaceId && value.brandId === scope.brandId; }
  private assertAudit(scope: BrandScope, event: AuditEvent, actorId?: string) { if (event.workspaceId !== scope.workspaceId || (actorId && event.actorId !== actorId) || event.contentItemId !== undefined) throw new Error("Private-message audit events must match the workspace and must not be content-item scoped."); }
  private assertObservationScope(scope: BrandScope, batch: PrivateProviderObservationBatch) { if (batch.accountId.length === 0 || batch.platform !== privateConversationPlatformForMode(batch.connectionMode)) throw new Error("Private provider observation lineage is invalid."); if (!scope.workspaceId || !scope.brandId) throw new Error("Private provider observation scope is invalid."); }
  private integrity(_workspaceId: string, _accountId: string, body: string) { return this.cipher.bodyIntegrityKey(body); }
  private readKey(scope: BrandScope, id: string, userId: string) { return `${scope.workspaceId}:${scope.brandId}:${id}:${userId}`; }
  private hasOtherProviderWrite(workspaceId: string, conversationId: string, excludeId: string) { return [...this.intents.values()].some((entry) => entry.workspaceId === workspaceId && entry.conversationId === conversationId && entry.id !== excludeId && ["queued", "processing", "uncertain"].includes(entry.status)); }
  private snapshot() { return { conversations: clone(this.conversations), participants: clone(this.participants), messages: clone(this.messages), reads: clone(this.reads), intents: clone(this.intents), syncStates: clone(this.syncStates), receipts: clone(this.receipts), auditsLength: this.audits.length }; }
  private restore(value: ReturnType<InMemoryPrivateConversationRepository["snapshot"]>) { this.conversations = value.conversations; this.participants = value.participants; this.messages = value.messages; this.reads = value.reads; this.intents = value.intents; this.syncStates = value.syncStates; this.receipts = value.receipts; this.audits.length = value.auditsLength; }
}
