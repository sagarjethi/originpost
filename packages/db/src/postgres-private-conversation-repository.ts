import {
  DomainError,
  applyPrivateMessageObservation,
  privateConversationPlatformForMode,
  transitionPrivateReplyIntent,
  type AuditEvent,
  type BrandScope,
  type PrivateConversation,
  type PrivateConversationParticipantView,
  type PrivateConversationRecordView,
  type PrivateConversationRepository,
  type PrivateConversationSyncPage,
  type PrivateConversationSyncState,
  type PrivateConversationUpdate,
  type PrivateInboxPage,
  type PrivateInboxQuery,
  type PrivateIngestResult,
  type PrivateMessage,
  type PrivateMessageAttachment,
  type PrivateMessageView,
  type PrivateMessageWebhookReceipt,
  type PrivateProviderMessageDeletion,
  type PrivateProviderMessageDeletionResult,
  type PrivateProviderObservationBatch,
  type PrivateProviderErasureResult,
  type PrivateReadMarker,
  type PrivateReplyApprovalContext,
  type PrivateReplyClaim,
  type PrivateReplyExecutionContext,
  type PrivateReplyIntent,
  type PrivateReplyIntentStatus,
  type PrivateReplyIntentView,
  type PrivateReplyRecovery,
  type PrivateReplyTransition,
  type PrivateRetentionPurgeResult,
  type PrivateSyncPageResult,
} from "@originpost/domain";
import type { Sql } from "postgres";
import { PrivateConversationCipher, type PrivateConversationKeys, type PrivateEnvelope } from "./private-conversation-crypto.js";

type Row = Record<string, any>;
type Queryable = any;
const limitOf = (value: number | undefined, fallback: number, maximum: number) => Math.max(1, Math.min(value ?? fallback, maximum));
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const maybeIso = (value: Date | string | null | undefined) => value ? iso(value) : undefined;
const plusDays = (value: string, days: number) => new Date(Date.parse(value) + days * 86_400_000).toISOString();

export class PostgresPrivateConversationRepository implements PrivateConversationRepository {
  private readonly cipher: PrivateConversationCipher;

  constructor(private readonly sql: Sql, keys: PrivateConversationKeys) {
    this.cipher = new PrivateConversationCipher(keys);
  }

  async eraseProviderData(workspaceId: string, accountIds: string[], erasedAt: string): Promise<PrivateProviderErasureResult> {
    if (!accountIds.length) return { conversations: 0, participants: 0, messages: 0, replyIntents: 0, receipts: 0 };
    return this.sql.begin(async (sql) => {
      const conversations = await sql<Row[]>`select id, workspace_id, brand_id, account_id from private_conversations where workspace_id = ${workspaceId} and account_id = any(${accountIds}) for update`;
      const participants = await sql<Row[]>`select id, workspace_id, brand_id, account_id, provider_participant_key_hash from private_conversation_participants where workspace_id = ${workspaceId} and account_id = any(${accountIds}) for update`;
      const messages = await sql<Row[]>`select id, workspace_id, brand_id, account_id, provider_message_key_hash from private_messages where workspace_id = ${workspaceId} and account_id = any(${accountIds}) for update`;
      const intents = await sql<Row[]>`select id, workspace_id, brand_id, account_id, provider_message_key_hash from private_reply_intents where workspace_id = ${workspaceId} and account_id = any(${accountIds}) for update`;
      const receipts = await sql<Row[]>`select id, workspace_id, brand_id, account_id from private_message_webhook_receipts where workspace_id = ${workspaceId} and account_id = any(${accountIds}) for update`;

      for (const row of conversations) await sql`update private_conversations set provider_conversation_key_envelope = ${sql.json(this.cipher.seal(workspaceId, "conversation-key", row.id, "deleted") as never)}, state = 'resolved', resolved_at = coalesce(resolved_at, ${erasedAt}), assigned_to = null, updated_at = ${erasedAt} where id = ${row.id}`;
      for (const row of participants) {
        await sql`update private_conversation_participants set provider_participant_key_envelope = ${sql.json(this.cipher.seal(workspaceId, "participant-key", row.id, "deleted") as never)}, profile_envelope = null, redacted_at = coalesce(redacted_at, ${erasedAt}), updated_at = ${erasedAt} where id = ${row.id}`;
        await this.tombstone(sql, row, "participant", row.provider_participant_key_hash, erasedAt, "user_deleted");
      }
      for (const row of messages) {
        await sql`update private_messages set provider_message_key_envelope = ${sql.json(this.cipher.seal(workspaceId, "message-key", row.id, "deleted") as never)}, body_envelope = null, body_integrity_key = null, attachments_envelope = ${sql.json(this.cipher.seal(workspaceId, "message-attachments", row.id, []) as never)}, availability = 'expired', tombstoned_at = coalesce(tombstoned_at, ${erasedAt}), updated_at = ${erasedAt} where id = ${row.id}`;
        await this.tombstone(sql, row, "message", row.provider_message_key_hash, erasedAt, "user_deleted");
      }
      for (const row of intents) {
        await sql`update private_reply_intents set body_envelope = null, body_integrity_key = null, provider_message_key_envelope = null, status = case when status in ('succeeded','failed','cancelled','expired') then status else 'cancelled' end, completed_at = coalesce(completed_at, ${erasedAt}), lease_owner = null, lease_expires_at = null, tombstoned_at = coalesce(tombstoned_at, ${erasedAt}), updated_at = ${erasedAt} where id = ${row.id}`;
        await this.tombstone(sql, row, "reply_intent", row.provider_message_key_hash, erasedAt, "user_deleted");
      }
      for (const row of receipts) await this.tombstone(sql, row, "webhook_receipt", null, erasedAt, "user_deleted");
      await sql`delete from private_message_webhook_receipts where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
      await sql`delete from private_conversation_sync_states where workspace_id = ${workspaceId} and account_id = any(${accountIds})`;
      return { conversations: conversations.length, participants: participants.length, messages: messages.length, replyIntents: intents.length, receipts: receipts.length };
    });
  }

  async list(scope: BrandScope, query: PrivateInboxQuery): Promise<PrivateInboxPage> {
    const rows = await this.sql<Row[]>`
      select * from private_conversations
      where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId}
        and (${query.state ?? null}::text is null or state = ${query.state ?? null})
        and (${query.assignedTo ?? null}::text is null or assigned_to = ${query.assignedTo ?? null})
        and (${query.accountId ?? null}::text is null or account_id = ${query.accountId ?? null})
        and (${query.platform ?? null}::text is null or platform = ${query.platform ?? null})
        and (${query.connectionMode ?? null}::text is null or connection_mode = ${query.connectionMode ?? null})
      order by last_activity_at desc, id desc limit 500
    `;
    const items = [];
    const search = query.query?.normalize("NFC").trim().toLocaleLowerCase();
    for (const row of rows) {
      const summary = await this.summary(this.sql, row, query.viewerId);
      if (query.eligibility && summary.replyEligibility.state !== query.eligibility) continue;
      if (query.attention === "unread" && summary.unreadCount === 0) continue;
      if (query.attention === "needs_reply" && !summary.needsReply) continue;
      if (query.attention === "mine" && summary.conversation.assignedTo !== query.viewerId) continue;
      if (search && ![...summary.participants.map((p: PrivateConversationParticipantView) => `${p.displayName ?? ""} ${p.username ?? ""}`), summary.latestMessage?.body ?? ""].join(" ").toLocaleLowerCase().includes(search)) continue;
      items.push(summary);
    }
    const start = query.cursor ? Math.max(0, items.findIndex((item) => item.conversation.id === query.cursor) + 1) : 0;
    const selected = items.slice(start, start + limitOf(query.limit, 30, 100));
    const nextCursor = start + selected.length < items.length ? selected.at(-1)?.conversation.id : undefined;
    return { items: selected, ...(nextCursor ? { nextCursor } : {}) };
  }

  async get(scope: BrandScope, id: string, viewerId: string) {
    const rows = await this.sql<Row[]>`select * from private_conversations where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id} limit 1`;
    const row = rows[0];
    if (!row) return null;
    const participants = await this.participantViews(this.sql, id);
    const messages = await this.messageViews(this.sql, id);
    const intentRows = await this.sql<Row[]>`select * from private_reply_intents where conversation_id = ${id} and tombstoned_at is null order by created_at, id`;
    return { conversation: this.mapConversationView(row), participants, messages, replyIntents: intentRows.map((entry) => this.mapIntentView(entry)), replyEligibility: row.reply_eligibility };
  }

  async updateConversation(scope: BrandScope, id: string, command: PrivateConversationUpdate, event: AuditEvent): Promise<PrivateConversationRecordView | null> {
    this.assertAudit(scope, event, command.actorId);
    return this.sql.begin(async (sql) => {
      const currentRows = await sql<Row[]>`select * from private_conversations where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id} for update`;
      const current = currentRows[0]; if (!current) return null;
      if (current.version !== command.expectedVersion) throw new DomainError("This private conversation changed. Refresh it and try again.", "private_conversation_version_conflict", 409);
      const state = command.state ?? current.state; const assignmentChanged = Object.hasOwn(command, "assignedTo");
      const updated = await sql<Row[]>`update private_conversations set state = ${state}, assigned_to = case when ${assignmentChanged} then ${command.assignedTo ?? null} else assigned_to end, resolved_at = case when ${state} = 'resolved' then coalesce(resolved_at, ${command.at}) else null end, version = version + 1, updated_at = ${command.at} where id = ${id} and version = ${command.expectedVersion} returning *`;
      if (!updated[0]) throw new DomainError("This private conversation changed. Refresh it and try again.", "private_conversation_version_conflict", 409);
      await this.audit(sql, event); return this.mapConversationView(updated[0]);
    });
  }

  async markRead(scope: BrandScope, conversationId: string, userId: string, marker: PrivateReadMarker): Promise<void> {
    await this.sql`
      insert into private_conversation_reads (workspace_id, brand_id, conversation_id, user_id, last_read_message_id, last_read_at, updated_at)
      select ${scope.workspaceId}, ${scope.brandId}, ${conversationId}, ${userId}, ${marker.lastReadMessageId ?? null}, ${marker.lastReadAt}, ${marker.lastReadAt}
      where exists (select 1 from private_conversations where id = ${conversationId} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId})
      on conflict (workspace_id, conversation_id, user_id) do update set last_read_message_id = excluded.last_read_message_id, last_read_at = excluded.last_read_at, updated_at = excluded.updated_at
      where private_conversation_reads.last_read_at <= excluded.last_read_at
    `;
  }

  async ingestProviderObservations(scope: BrandScope, batch: PrivateProviderObservationBatch, event: AuditEvent): Promise<PrivateIngestResult> {
    this.assertObservation(scope, batch); this.assertAudit(scope, event);
    return this.sql.begin(async (sql) => { const result = await this.ingest(sql, scope, batch); await this.audit(sql, event); return result; });
  }

  async getMessage(scope: BrandScope, id: string): Promise<PrivateMessage | null> {
    const rows = await this.sql<Row[]>`select * from private_messages where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id} limit 1`;
    return rows[0] ? this.mapMessage(rows[0]) : null;
  }

  async applyProviderMessageDeletion(scope: BrandScope, command: PrivateProviderMessageDeletion, event: AuditEvent): Promise<PrivateProviderMessageDeletionResult> {
    this.assertAudit(scope, event);
    if (command.platform !== privateConversationPlatformForMode(command.connectionMode)) throw new Error("Private provider deletion lineage is invalid.");
    const providerHash = this.cipher.hash(scope.workspaceId, command.accountId, "message", command.externalMessageId);
    return this.sql.begin(async (sql) => {
      const rows = await sql<Row[]>`select * from private_messages where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and account_id = ${command.accountId} and provider_message_key_hash = ${providerHash} limit 1 for update`;
      const current = rows[0];
      if (!current) { await this.audit(sql, event); return { found: false, alreadyDeleted: false }; }
      if (current.platform !== command.platform || current.connection_mode !== command.connectionMode) throw new DomainError("The provider-deleted message does not match this connection.", "private_message_lineage_conflict", 409);
      const alreadyDeleted = current.availability === "deleted";
      const attachments = this.cipher.seal(scope.workspaceId, "message-attachments", current.id, []);
      await sql`update private_messages set body_envelope = null, body_integrity_key = null, attachments_envelope = ${sql.json(attachments as never)}, availability = 'deleted', deleted_at = coalesce(deleted_at, ${command.observedAt}), last_seen_at = ${command.observedAt}, source = 'webhook', observation_kind = 'deleted', raw_payload_sha256 = coalesce(${command.rawPayloadSha256 ?? null}, raw_payload_sha256), tombstoned_at = coalesce(tombstoned_at, ${command.observedAt}), updated_at = ${command.observedAt} where id = ${current.id}`;
      await this.tombstone(sql, current, "message", providerHash, command.observedAt, "provider_deleted");
      await this.audit(sql, event);
      return { found: true, alreadyDeleted };
    });
  }

  async saveReplyIntent(intent: PrivateReplyIntent, event: AuditEvent): Promise<void> {
    const scope = { workspaceId: intent.workspaceId, brandId: intent.brandId }; this.assertAudit(scope, event, intent.requestedBy);
    if (this.cipher.bodyIntegrityKey(intent.body) !== intent.bodyIntegrityKey) throw new DomainError("Private reply integrity is invalid.", "private_reply_body_hash_invalid", 400);
    await this.sql.begin(async (sql) => {
      const lineage = await sql<Row[]>`select c.account_id from private_conversations c join private_messages m on m.id = ${intent.inReplyToMessageId} and m.conversation_id = c.id where c.id = ${intent.conversationId} and c.workspace_id = ${intent.workspaceId} and c.brand_id = ${intent.brandId}`;
      const accountId = lineage[0]?.account_id as string | undefined;
      if (!accountId) throw new DomainError("Private reply lineage is invalid.", "private_reply_lineage_invalid", 400);
      const envelope = this.cipher.seal(intent.workspaceId, "reply-body", intent.id, intent.body);
      const inserted = await sql<Row[]>`
        insert into private_reply_intents (id, workspace_id, brand_id, conversation_id, account_id, in_reply_to_message_id, body_envelope, body_integrity_key, status, idempotency_key, requested_by, approved_by, eligibility_at_approval, provider_message_key_hash, provider_message_key_envelope, provider_accepted_at, provider_response_sha256, error_code, error_summary, attempt_count, lease_owner, lease_expires_at, created_at, updated_at, completed_at, retain_until, version)
        values (${intent.id}, ${intent.workspaceId}, ${intent.brandId}, ${intent.conversationId}, ${accountId}, ${intent.inReplyToMessageId}, ${sql.json(envelope as never)}, ${intent.bodyIntegrityKey}, ${intent.status}, ${intent.idempotencyKey}, ${intent.requestedBy}, ${intent.approvedBy ?? null}, ${intent.eligibilityAtApproval ? sql.json(intent.eligibilityAtApproval as never) : null}, null, null, ${intent.providerAcceptedAt ?? null}, ${intent.providerResponseSha256 ?? null}, ${intent.errorCode ?? null}, ${intent.errorSummary ?? null}, ${intent.attemptCount}, null, null, ${intent.createdAt}, ${intent.updatedAt}, ${intent.completedAt ?? null}, ${plusDays(intent.createdAt, 90)}, ${intent.version})
        on conflict (id) do nothing returning id
      `;
      if (!inserted[0]) {
        const existing = await sql<Row[]>`select version, body_integrity_key from private_reply_intents where id = ${intent.id}`;
        if (existing[0]?.version !== intent.version || existing[0]?.body_integrity_key !== intent.bodyIntegrityKey) throw new DomainError("This private reply changed. Refresh it and try again.", "private_reply_version_conflict", 409);
        return;
      }
      await this.replyEvent(sql, intent.id, event, null, intent.status, intent.version, 0); await this.audit(sql, event);
    });
  }

  async getReplyIntent(scope: BrandScope, id: string): Promise<PrivateReplyIntent | null> {
    const rows = await this.sql<Row[]>`select * from private_reply_intents where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id} and tombstoned_at is null limit 1`;
    return rows[0] ? this.mapIntent(rows[0]) : null;
  }

  async reviseReplyIntent(scope: BrandScope, revised: PrivateReplyIntent, event: AuditEvent): Promise<PrivateReplyIntent | null> {
    this.assertAudit(scope, event, revised.requestedBy);
    if (!revised.body.trim() || !/^[0-9a-f]{64}$/.test(revised.bodyIntegrityKey) || this.cipher.bodyIntegrityKey(revised.body) !== revised.bodyIntegrityKey || revised.status !== "pending_approval" || revised.approvedBy || revised.providerMessageKey || revised.leaseOwner || revised.leaseExpiresAt || revised.attemptCount !== 0) throw new DomainError("This private reply revision is invalid or stale.", "private_reply_revision_conflict", 409);
    return this.sql.begin(async (sql) => {
      const rows = await sql<Row[]>`select * from private_reply_intents where id = ${revised.id} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and tombstoned_at is null for update`; const current = rows[0]; if (!current) return null;
      if (revised.workspaceId !== current.workspace_id || revised.brandId !== current.brand_id || revised.conversationId !== current.conversation_id || revised.inReplyToMessageId !== current.in_reply_to_message_id || revised.createdAt !== iso(current.created_at) || revised.version !== current.version + 1) throw new DomainError("This private reply revision is invalid or stale.", "private_reply_revision_conflict", 409);
      const envelope = this.cipher.seal(scope.workspaceId, "reply-body", revised.id, revised.body);
      const updated = await sql<Row[]>`update private_reply_intents set body_envelope = ${sql.json(envelope as never)}, body_integrity_key = ${revised.bodyIntegrityKey}, status = 'pending_approval', idempotency_key = ${revised.idempotencyKey}, requested_by = ${revised.requestedBy}, approved_by = null, eligibility_at_approval = null, provider_message_key_hash = null, provider_message_key_envelope = null, provider_accepted_at = null, provider_response_sha256 = null, error_code = null, error_summary = null, attempt_count = 0, lease_owner = null, lease_expires_at = null, completed_at = null, updated_at = ${revised.updatedAt}, version = ${revised.version} where id = ${revised.id} and version = ${current.version} returning *`;
      if (!updated[0]) throw new DomainError("This private reply revision is invalid or stale.", "private_reply_revision_conflict", 409);
      await this.replyEvent(sql, revised.id, event, current.status, "pending_approval", revised.version, current.lease_fence); await this.audit(sql, event); return this.mapIntent(updated[0]);
    });
  }

  async transitionReplyIntent(scope: BrandScope, command: PrivateReplyTransition, event: AuditEvent): Promise<PrivateReplyIntent | null> {
    this.assertAudit(scope, event, command.actorId);
    return this.sql.begin(async (sql) => {
      const rows = await sql<Row[]>`select *, (lease_expires_at > clock_timestamp()) as lease_active from private_reply_intents where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${command.intentId} and tombstoned_at is null for update`;
      const row = rows[0]; if (!row) return null;
      if (row.status === "processing" && (command.leaseOwner !== row.lease_owner || !row.lease_active)) throw new DomainError("The private reply execution lease is stale.", "private_reply_lease_stale", 409);
      const current = this.mapIntent(row); const next = transitionPrivateReplyIntent(current, command);
      const providerHash = command.providerMessageKey ? this.cipher.hash(scope.workspaceId, row.account_id, "message", command.providerMessageKey) : row.provider_message_key_hash;
      const providerEnvelope = command.providerMessageKey ? this.cipher.seal(scope.workspaceId, "reply-provider-message", row.id, command.providerMessageKey) : row.provider_message_key_envelope;
      const updated = await sql<Row[]>`
        update private_reply_intents set status = ${next.status}, approved_by = ${next.approvedBy ?? null}, eligibility_at_approval = ${next.eligibilityAtApproval ? sql.json(next.eligibilityAtApproval as never) : null}, provider_message_key_hash = ${providerHash ?? null}, provider_message_key_envelope = ${providerEnvelope ? sql.json(providerEnvelope as never) : null}, provider_accepted_at = ${next.providerAcceptedAt ?? null}, provider_response_sha256 = ${next.providerResponseSha256 ?? null}, error_code = ${next.errorCode ?? null}, error_summary = ${next.errorSummary ?? null}, lease_owner = null, lease_expires_at = null, completed_at = ${next.completedAt ?? null}, updated_at = ${command.at}, version = ${next.version}
        where id = ${row.id} and version = ${command.expectedVersion} returning *
      `;
      if (!updated[0]) throw new DomainError("This private reply changed while you were working.", "private_reply_version_conflict", 409);
      await this.replyEvent(sql, row.id, event, row.status, next.status, next.version, row.lease_fence); await this.audit(sql, event); return this.mapIntent(updated[0]);
    });
  }

  async claimReplyIntentForExecution(scope: BrandScope, command: PrivateReplyClaim, event: AuditEvent): Promise<PrivateReplyExecutionContext | null> {
    this.assertAudit(scope, event);
    if (!command.owner.trim() || !Number.isInteger(command.leaseSeconds) || command.leaseSeconds < 5 || command.leaseSeconds > 900) throw new DomainError("The private reply lease is invalid.", "private_reply_lease_invalid", 400);
    return this.sql.begin(async (sql) => {
      const updated = await sql<Row[]>`
        update private_reply_intents set status = 'processing', attempt_count = attempt_count + 1, lease_fence = lease_fence + 1, lease_owner = ${command.owner} || ':' || (lease_fence + 1)::text, lease_expires_at = clock_timestamp() + make_interval(secs => ${command.leaseSeconds}), updated_at = clock_timestamp(), version = version + 1
        where id = ${command.intentId} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and status = 'queued' and version = ${command.expectedVersion} and tombstoned_at is null returning *
      `;
      const row = updated[0]; if (!row) throw new DomainError("This private reply is not available to send.", "private_reply_claim_conflict", 409);
      await this.replyEvent(sql, row.id, event, "queued", "processing", row.version, row.lease_fence); await this.audit(sql, event);
      return this.executionContext(sql, row);
    });
  }

  async getReplyApprovalContext(scope: BrandScope, intentId: string): Promise<PrivateReplyApprovalContext | null> {
    const rows = await this.sql<Row[]>`select * from private_reply_intents where id = ${intentId} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and status = 'pending_approval' and tombstoned_at is null limit 1`;
    return rows[0] ? this.approvalContext(this.sql, rows[0]) : null;
  }

  async getReplyExecutionContext(scope: BrandScope, intentId: string): Promise<PrivateReplyExecutionContext | null> {
    const rows = await this.sql<Row[]>`select * from private_reply_intents where id = ${intentId} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and status = 'processing' and lease_expires_at > clock_timestamp() and tombstoned_at is null limit 1`;
    return rows[0] ? this.executionContext(this.sql, rows[0]) : null;
  }

  async recoverExpiredReplyIntent(scope: BrandScope, command: PrivateReplyRecovery, event: AuditEvent): Promise<PrivateReplyIntent | null> {
    this.assertAudit(scope, event, command.actorId);
    return this.sql.begin(async (sql) => {
      const updated = await sql<Row[]>`
        update private_reply_intents set status = 'uncertain', error_code = 'send_outcome_unknown', error_summary = 'The provider outcome was not recorded before the execution lease expired.', lease_owner = null, lease_expires_at = null, lease_fence = lease_fence + 1, updated_at = clock_timestamp(), version = version + 1
        where id = ${command.intentId} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and status = 'processing' and version = ${command.expectedVersion} and lease_expires_at <= clock_timestamp() and tombstoned_at is null returning *
      `;
      const row = updated[0]; if (!row) throw new DomainError("This private reply is not an expired send attempt.", "private_reply_recovery_conflict", 409);
      await this.replyEvent(sql, row.id, event, "processing", "uncertain", row.version, row.lease_fence); await this.audit(sql, event); return this.mapIntent(row);
    });
  }

  async getSyncState(scope: BrandScope, accountId: string): Promise<PrivateConversationSyncState | null> {
    const rows = await this.sql<Row[]>`select * from private_conversation_sync_states where account_id = ${accountId} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} limit 1`;
    return rows[0] ? this.mapSync(rows[0]) : null;
  }

  async saveSyncPage(scope: BrandScope, page: PrivateConversationSyncPage, event: AuditEvent): Promise<PrivateSyncPageResult> {
    this.assertAudit(scope, event); const state = page.syncState;
    if (state.workspaceId !== scope.workspaceId || state.brandId !== scope.brandId || page.batches.some((batch) => batch.accountId !== state.accountId || batch.platform !== state.platform || batch.connectionMode !== state.connectionMode)) throw new Error("Private sync page lineage is invalid.");
    return this.sql.begin(async (sql) => {
      const existing = await sql<Row[]>`select * from private_conversation_sync_states where account_id = ${state.accountId} for update`;
      if (existing[0] && (existing[0].workspace_id !== scope.workspaceId || existing[0].brand_id !== scope.brandId || existing[0].version !== state.version || (existing[0].lease_owner && existing[0].lease_owner !== state.leaseOwner))) throw new DomainError("The private sync cursor changed.", "private_sync_version_conflict", 409);
      const result: PrivateSyncPageResult = { conversations: 0, inserted: 0, updated: 0, deleted: 0, reopened: 0 };
      for (const batch of page.batches) { const value = await this.ingest(sql, scope, batch); result.conversations += 1; result.inserted += value.inserted; result.updated += value.updated; result.deleted += value.deleted; result.reopened += value.reopened ? 1 : 0; }
      const cursor = page.nextCursor ? this.cipher.seal(scope.workspaceId, "sync-cursor", state.accountId, page.nextCursor) : null;
      if (existing[0]) {
        const changed = await sql<Row[]>`update private_conversation_sync_states set cursor_envelope = ${cursor ? sql.json(cursor as never) : null}, last_attempted_at = ${page.fetchedAt}, last_succeeded_at = ${page.fetchedAt}, failure_count = 0, error_code = null, error_summary = null, lease_owner = null, lease_expires_at = null, next_sync_at = ${state.nextSyncAt}, version = version + 1, updated_at = clock_timestamp() where account_id = ${state.accountId} and version = ${state.version} returning account_id`;
        if (!changed[0]) throw new DomainError("The private sync cursor changed.", "private_sync_version_conflict", 409);
      } else {
        await sql`insert into private_conversation_sync_states (account_id, workspace_id, brand_id, platform, connection_mode, cursor_envelope, last_attempted_at, last_succeeded_at, next_sync_at, failure_count, version) values (${state.accountId}, ${scope.workspaceId}, ${scope.brandId}, ${state.platform}, ${state.connectionMode}, ${cursor ? sql.json(cursor as never) : null}, ${page.fetchedAt}, ${page.fetchedAt}, ${state.nextSyncAt}, 0, 1)`;
      }
      await this.audit(sql, event); return result;
    });
  }

  async listAccountsNeedingSync(before: string, limit = 100): Promise<PrivateConversationSyncState[]> {
    const rows = await this.sql<Row[]>`select * from private_conversation_sync_states where next_sync_at <= ${before} and (lease_expires_at is null or lease_expires_at <= clock_timestamp()) order by next_sync_at, account_id limit ${limitOf(limit, 100, 500)}`;
    return rows.map((row) => this.mapSync(row));
  }

  async recordWebhookReceipt(receipt: PrivateMessageWebhookReceipt) {
    const envelope = this.cipher.seal(receipt.workspaceId, "webhook-event", receipt.id, receipt.normalizedEvent);
    const rows = await this.sql<Row[]>`
      insert into private_message_webhook_receipts (id, provider, connection_mode, workspace_id, brand_id, account_id, payload_sha256, normalized_event_envelope, status, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, processed_at, retain_until)
      values (${receipt.id}, ${receipt.provider}, ${receipt.connectionMode}, ${receipt.workspaceId}, ${receipt.brandId}, ${receipt.accountId}, ${receipt.payloadSha256}, ${this.sql.json(envelope as never)}, ${receipt.status}, ${receipt.attempts}, ${receipt.availableAt}, ${receipt.leaseOwner ?? null}, ${receipt.leaseExpiresAt ?? null}, ${receipt.lastError ?? null}, ${receipt.createdAt}, ${receipt.processedAt ?? null}, ${plusDays(receipt.createdAt, 30)})
      on conflict (provider, connection_mode, account_id, payload_sha256) do nothing returning *
    `;
    if (rows[0]) return { receipt: this.mapReceipt(rows[0]), created: true };
    const existing = await this.sql<Row[]>`select * from private_message_webhook_receipts where provider = ${receipt.provider} and connection_mode = ${receipt.connectionMode} and account_id = ${receipt.accountId} and payload_sha256 = ${receipt.payloadSha256} limit 1`;
    return { receipt: this.mapReceipt(existing[0]!), created: false };
  }

  async claimWebhookReceipts(owner: string, limit = 25, leaseSeconds = 60): Promise<PrivateMessageWebhookReceipt[]> {
    const rows = await this.sql<Row[]>`
      with candidates as (select id from private_message_webhook_receipts where available_at <= clock_timestamp() and (status = 'pending' or (status = 'processing' and lease_expires_at <= clock_timestamp())) order by available_at, created_at, id for update skip locked limit ${limitOf(limit, 25, 100)})
      update private_message_webhook_receipts r set status = 'processing', attempts = attempts + 1, lease_fence = lease_fence + 1, lease_owner = ${owner} || ':' || (lease_fence + 1)::text, lease_expires_at = clock_timestamp() + make_interval(secs => ${Math.max(5, Math.min(leaseSeconds, 900))}), updated_at = clock_timestamp() from candidates c where r.id = c.id returning r.*
    `;
    return rows.map((row) => this.mapReceipt(row));
  }

  async completeWebhookReceipt(id: string, owner: string, processedAt: string): Promise<void> {
    const rows = await this.sql<Row[]>`update private_message_webhook_receipts set status = 'processed', processed_at = ${processedAt}, lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp() where id = ${id} and status = 'processing' and lease_owner = ${owner} and lease_expires_at > clock_timestamp() returning id`;
    if (!rows[0]) throw new DomainError("The webhook receipt lease is stale.", "private_webhook_lease_stale", 409);
  }

  async failWebhookReceipt(id: string, owner: string, error: string, retryAt: string, maxAttempts = 10): Promise<void> {
    const rows = await this.sql<Row[]>`update private_message_webhook_receipts set status = case when attempts >= ${maxAttempts} then 'failed' else 'pending' end, available_at = ${retryAt}, last_error = ${error.slice(0, 500)}, lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp() where id = ${id} and status = 'processing' and lease_owner = ${owner} and lease_expires_at > clock_timestamp() returning id`;
    if (!rows[0]) throw new DomainError("The webhook receipt lease is stale.", "private_webhook_lease_stale", 409);
  }

  async listReplyIntentsForRecovery(statuses: PrivateReplyIntentStatus[] = ["queued", "processing", "uncertain"], limit = 100): Promise<PrivateReplyIntent[]> {
    const rows = await this.sql<Row[]>`select * from private_reply_intents where status = any(${statuses}) and tombstoned_at is null and (status <> 'processing' or lease_expires_at <= clock_timestamp()) order by updated_at, id limit ${limitOf(limit, 100, 500)}`;
    return rows.map((row) => this.mapIntent(row));
  }

  async purgeExpired(now: string, limit = 500): Promise<PrivateRetentionPurgeResult> {
    const max = limitOf(limit, 500, 2000);
    return this.sql.begin(async (sql) => {
      const messageCandidates: Row[] = await sql<Row[]>`select id, workspace_id, brand_id, account_id, provider_message_key_hash from private_messages where tombstoned_at is null and retain_until <= ${now} order by retain_until limit ${max} for update skip locked`;
      const messages: Row[] = [];
      for (const row of messageCandidates) { const envelope = this.cipher.seal(row.workspace_id, "message-attachments", row.id, []); const updated: Row[] = await sql<Row[]>`update private_messages set body_envelope = null, body_integrity_key = null, attachments_envelope = ${sql.json(envelope as never)}, availability = 'expired', tombstoned_at = ${now}, updated_at = ${now} where id = ${row.id} returning id, workspace_id, brand_id, account_id, provider_message_key_hash`; if (updated[0]) messages.push(updated[0]); }
      const intents = await sql<Row[]>`update private_reply_intents set body_envelope = null, body_integrity_key = null, provider_message_key_envelope = null, tombstoned_at = ${now}, updated_at = ${now} where id in (select id from private_reply_intents where tombstoned_at is null and retain_until <= ${now} and status in ('succeeded','failed','cancelled','expired') order by retain_until limit ${max} for update skip locked) returning id, workspace_id, brand_id, account_id, provider_message_key_hash`;
      const participants = await sql<Row[]>`update private_conversation_participants set profile_envelope = null, redacted_at = ${now}, updated_at = ${now} where id in (select id from private_conversation_participants where redacted_at is null and retain_until <= ${now} order by retain_until limit ${max} for update skip locked) returning id, workspace_id, brand_id, account_id, provider_participant_key_hash`;
      const receipts = await sql<Row[]>`delete from private_message_webhook_receipts where id in (select id from private_message_webhook_receipts where retain_until <= ${now} and status in ('processed','failed') order by retain_until limit ${max} for update skip locked) returning id, workspace_id, brand_id, account_id`;
      for (const [type, rows, key] of [["message", messages, "provider_message_key_hash"], ["reply_intent", intents, "provider_message_key_hash"], ["participant", participants, "provider_participant_key_hash"], ["webhook_receipt", receipts, null]] as const) for (const row of rows) await this.tombstone(sql, row, type, key ? row[key] : null, now);
      return { messages: messages.length, replyIntents: intents.length, participants: participants.length, receipts: receipts.length };
    });
  }

  private async ingest(sql: Queryable, scope: BrandScope, batch: PrivateProviderObservationBatch): Promise<PrivateIngestResult> {
    this.assertObservation(scope, batch);
    const conversationHash = this.cipher.hash(scope.workspaceId, batch.accountId, "conversation", batch.externalConversationId);
    const existingRows = await sql<Row[]>`select * from private_conversations where account_id = ${batch.accountId} and provider_conversation_key_hash = ${conversationHash} for update`;
    const existing = existingRows[0];
    if (existing && (existing.workspace_id !== scope.workspaceId || existing.brand_id !== scope.brandId || existing.platform !== batch.platform || existing.connection_mode !== batch.connectionMode)) throw new DomainError("The provider conversation is already linked outside this scope.", "private_conversation_lineage_conflict", 409);
    const conversationId = existing?.id ?? `private_conversation_${conversationHash.slice(0, 32)}`;
    const conversationEnvelope = existing?.provider_conversation_key_envelope ?? this.cipher.seal(scope.workspaceId, "conversation-key", conversationId, batch.externalConversationId);
    if (!existing) await sql`
      insert into private_conversations (id, workspace_id, brand_id, account_id, platform, connection_mode, provider_conversation_key_hash, provider_conversation_key_envelope, state, reply_eligibility, last_activity_at, last_synced_at, version, created_at, updated_at)
      values (${conversationId}, ${scope.workspaceId}, ${scope.brandId}, ${batch.accountId}, ${batch.platform}, ${batch.connectionMode}, ${conversationHash}, ${sql.json(conversationEnvelope as never)}, 'open', ${sql.json(batch.replyEligibility as never)}, ${batch.syncedAt}, ${batch.syncedAt}, 1, ${batch.syncedAt}, ${batch.syncedAt})
      on conflict (account_id, provider_conversation_key_hash) do nothing
    `;
    const participantIds = new Map<string, string>();
    for (const item of batch.participants) {
      const hash = this.cipher.hash(scope.workspaceId, batch.accountId, "participant", item.externalParticipantId); const id = `private_participant_${hash.slice(0, 32)}`;
      const profile = { displayName: item.displayName, username: item.username, avatarUrl: item.avatarUrl, avatarExpiresAt: item.avatarExpiresAt };
      const profileEnvelope = Object.values(profile).some(Boolean) ? this.cipher.seal(scope.workspaceId, "participant-profile", id, profile) : null;
      await sql`
        insert into private_conversation_participants (id, workspace_id, brand_id, conversation_id, account_id, platform, connection_mode, provider_participant_key_hash, provider_participant_key_envelope, role, profile_envelope, first_seen_at, last_seen_at, retain_until)
        values (${id}, ${scope.workspaceId}, ${scope.brandId}, ${conversationId}, ${batch.accountId}, ${batch.platform}, ${batch.connectionMode}, ${hash}, ${sql.json(this.cipher.seal(scope.workspaceId, "participant-key", id, item.externalParticipantId) as never)}, ${item.role}, ${profileEnvelope ? sql.json(profileEnvelope as never) : null}, ${batch.syncedAt}, ${batch.syncedAt}, ${plusDays(batch.syncedAt, 90)})
        on conflict (account_id, provider_participant_key_hash) do update set role = excluded.role, profile_envelope = coalesce(excluded.profile_envelope, private_conversation_participants.profile_envelope), last_seen_at = greatest(private_conversation_participants.last_seen_at, excluded.last_seen_at), retain_until = excluded.retain_until, redacted_at = null, updated_at = clock_timestamp()
      `;
      participantIds.set(item.externalParticipantId, id);
    }
    let inserted = 0, updated = 0, deleted = 0, newIncoming = false;
    for (const item of batch.messages) {
      const hash = this.cipher.hash(scope.workspaceId, batch.accountId, "message", item.externalMessageId); const id = `private_message_${hash.slice(0, 32)}`;
      const priorRows = await sql<Row[]>`select * from private_messages where account_id = ${batch.accountId} and provider_message_key_hash = ${hash} for update`; const prior = priorRows[0];
      if (prior && prior.conversation_id !== conversationId) throw new DomainError("The provider message is linked to another conversation.", "private_message_lineage_conflict", 409);
      if (prior) {
        let next = this.mapMessage(prior);
        if (item.observationKind === "deleted" || item.availability === "deleted") { next = applyPrivateMessageObservation(next, { kind: "deleted", observedAt: item.observedAt }); if (prior.availability !== "deleted") deleted += 1; }
        else if (item.observationKind === "delivery") next = applyPrivateMessageObservation(next, { kind: "delivery", observedAt: item.observedAt, deliveryState: item.deliveryState });
        else if (item.observationKind === "read") next = applyPrivateMessageObservation(next, { kind: "read", observedAt: item.observedAt });
        const deletedAttachments = next.availability === "deleted" ? this.cipher.seal(scope.workspaceId, "message-attachments", prior.id, next.attachments) : null;
        await sql`update private_messages set availability = ${next.availability}, delivery_state = ${next.deliveryState}, delivered_at = ${next.deliveredAt ?? null}, read_at = ${next.readAt ?? null}, deleted_at = ${next.deletedAt ?? null}, last_seen_at = greatest(last_seen_at, ${item.observedAt}), observation_kind = ${item.observationKind}, body_envelope = case when ${next.body === undefined} then null else body_envelope end, body_integrity_key = case when ${next.bodyIntegrityKey === undefined} then null else body_integrity_key end, attachments_envelope = coalesce(${deletedAttachments ? sql.json(deletedAttachments as never) : null}, attachments_envelope), tombstoned_at = case when ${next.availability} = 'deleted' then ${item.observedAt} else tombstoned_at end, updated_at = ${item.observedAt} where id = ${prior.id}`;
        if (next.availability === "deleted") await this.tombstone(sql, prior, "message", prior.provider_message_key_hash, item.observedAt, "provider_deleted");
        updated += 1; continue;
      }
      const senderId = item.externalSenderId ? participantIds.get(item.externalSenderId) : undefined;
      let replyId: string | undefined;
      if (item.replyToExternalMessageId) { const replyHash = this.cipher.hash(scope.workspaceId, batch.accountId, "message", item.replyToExternalMessageId); const reply = await sql<Row[]>`select id from private_messages where account_id = ${batch.accountId} and provider_message_key_hash = ${replyHash}`; replyId = reply[0]?.id; }
      const attachments: PrivateMessageAttachment[] = item.attachments.map((attachment, index) => ({ id: `private_attachment_${this.cipher.hash(scope.workspaceId, batch.accountId, "attachment", `${item.externalMessageId}:${attachment.externalAttachmentId ?? index}`).slice(0, 32)}`, ...(attachment.externalAttachmentId ? { providerAttachmentKey: this.cipher.hash(scope.workspaceId, batch.accountId, "attachment-provider", attachment.externalAttachmentId) } : {}), ...attachment }));
      const isDeleted = item.availability === "deleted"; const body = isDeleted ? undefined : item.body?.normalize("NFC"); const finalAttachments = isDeleted ? attachments.map((entry) => ({ ...entry, providerAttachmentKey: undefined, url: undefined, availability: "deleted" as const })) : attachments;
      await sql`
        insert into private_messages (id, workspace_id, brand_id, conversation_id, account_id, platform, connection_mode, provider_message_key_hash, provider_message_key_envelope, sender_participant_id, direction, kind, body_envelope, body_integrity_key, attachments_envelope, reply_to_message_id, is_echo, availability, delivery_state, delivered_at, read_at, deleted_at, provider_created_at, first_seen_at, last_seen_at, source, observation_kind, raw_payload_sha256, retain_until, tombstoned_at)
        values (${id}, ${scope.workspaceId}, ${scope.brandId}, ${conversationId}, ${batch.accountId}, ${batch.platform}, ${batch.connectionMode}, ${hash}, ${sql.json(this.cipher.seal(scope.workspaceId, "message-key", id, item.externalMessageId) as never)}, ${senderId ?? null}, ${item.direction}, ${item.kind}, ${body ? sql.json(this.cipher.seal(scope.workspaceId, "message-body", id, body) as never) : null}, ${body ? this.cipher.bodyIntegrityKey(body) : null}, ${sql.json(this.cipher.seal(scope.workspaceId, "message-attachments", id, finalAttachments) as never)}, ${replyId ?? null}, ${item.isEcho}, ${item.availability}, ${item.deliveryState}, ${item.deliveredAt ?? null}, ${item.readAt ?? null}, ${item.deletedAt ?? (isDeleted ? item.observedAt : null)}, ${item.providerCreatedAt ?? null}, ${item.observedAt}, ${item.observedAt}, ${item.isEcho ? "webhook" : "reconcile"}, ${item.observationKind}, ${item.rawPayloadSha256 ?? null}, ${plusDays(item.observedAt, 90)}, ${isDeleted ? item.observedAt : null})
      `;
      inserted += 1; if (item.direction === "incoming") newIncoming = true; if (isDeleted) { deleted += 1; await this.tombstone(sql, { id, workspace_id: scope.workspaceId, brand_id: scope.brandId, account_id: batch.accountId }, "message", hash, item.observedAt, "provider_deleted"); }
    }
    const activity = await sql<Row[]>`select max(coalesce(provider_created_at, first_seen_at)) filter (where direction = 'incoming') inbound, max(coalesce(provider_created_at, first_seen_at)) filter (where direction = 'outgoing') outbound from private_messages where conversation_id = ${conversationId}`;
    const inbound = maybeIso(activity[0]?.inbound) ?? maybeIso(existing?.last_inbound_at); const outbound = maybeIso(activity[0]?.outbound) ?? maybeIso(existing?.last_outbound_at); const lastActivity = [batch.syncedAt, inbound, outbound, maybeIso(existing?.last_activity_at)].filter(Boolean).sort().at(-1)!; const reopened = Boolean(existing?.state === "resolved" && newIncoming);
    const rows = await sql<Row[]>`
      insert into private_conversations (id, workspace_id, brand_id, account_id, platform, connection_mode, provider_conversation_key_hash, provider_conversation_key_envelope, state, assigned_to, reply_eligibility, last_inbound_at, last_outbound_at, last_activity_at, last_synced_at, resolved_at, version, created_at, updated_at)
      values (${conversationId}, ${scope.workspaceId}, ${scope.brandId}, ${batch.accountId}, ${batch.platform}, ${batch.connectionMode}, ${conversationHash}, ${sql.json(conversationEnvelope as never)}, 'open', null, ${sql.json(batch.replyEligibility as never)}, ${inbound ?? null}, ${outbound ?? null}, ${lastActivity}, ${batch.syncedAt}, null, 1, ${batch.syncedAt}, ${batch.syncedAt})
      on conflict (account_id, provider_conversation_key_hash) do update set reply_eligibility = excluded.reply_eligibility, last_inbound_at = excluded.last_inbound_at, last_outbound_at = excluded.last_outbound_at, last_activity_at = excluded.last_activity_at, last_synced_at = excluded.last_synced_at, state = case when private_conversations.state = 'resolved' and ${newIncoming} then 'open' else private_conversations.state end, resolved_at = case when private_conversations.state = 'resolved' and ${newIncoming} then null else private_conversations.resolved_at end, version = private_conversations.version + case when private_conversations.state = 'resolved' and ${newIncoming} then 1 else 0 end, updated_at = excluded.updated_at returning *
    `;
    return { conversation: this.mapConversation(rows[0]!), inserted, updated, deleted, reopened };
  }

  private mapConversationView(row: Row): PrivateConversationRecordView {
    return { id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, accountId: row.account_id, platform: row.platform, connectionMode: row.connection_mode, state: row.state, lastActivityAt: iso(row.last_activity_at), version: row.version, ...(row.assigned_to ? { assignedTo: row.assigned_to } : {}), ...(row.last_inbound_at ? { lastInboundAt: iso(row.last_inbound_at) } : {}), ...(row.last_outbound_at ? { lastOutboundAt: iso(row.last_outbound_at) } : {}), ...(row.last_synced_at ? { lastSyncedAt: iso(row.last_synced_at) } : {}), ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}) };
  }

  private mapConversation(row: Row, reveal = false): PrivateConversation {
    const key = reveal ? this.cipher.open(row.workspace_id, "conversation-key", row.id, row.provider_conversation_key_envelope as PrivateEnvelope) : row.provider_conversation_key_hash;
    return { ...this.mapConversationView(row), providerConversationKey: key };
  }

  private mapParticipantView(row: Row): PrivateConversationParticipantView {
    const profile = row.profile_envelope && !row.redacted_at ? this.cipher.openJson<Record<string, string | undefined>>(row.workspace_id, "participant-profile", row.id, row.profile_envelope) : {};
    return { id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, conversationId: row.conversation_id, accountId: row.account_id, role: row.role, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at), ...profile };
  }

  private mapMessage(row: Row, reveal = false): PrivateMessage {
    const body = row.body_envelope ? this.cipher.open(row.workspace_id, "message-body", row.id, row.body_envelope) : undefined;
    const attachments = this.cipher.openJson<PrivateMessageAttachment[]>(row.workspace_id, "message-attachments", row.id, row.attachments_envelope);
    return { id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, conversationId: row.conversation_id, accountId: row.account_id, platform: row.platform, connectionMode: row.connection_mode, providerMessageKey: reveal ? this.cipher.open(row.workspace_id, "message-key", row.id, row.provider_message_key_envelope) : row.provider_message_key_hash, direction: row.direction, kind: row.kind, attachments, isEcho: row.is_echo, availability: row.availability, deliveryState: row.delivery_state, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at), source: row.source, observationKind: row.observation_kind, ...(row.sender_participant_id ? { senderParticipantId: row.sender_participant_id } : {}), ...(body !== undefined ? { body, bodyIntegrityKey: row.body_integrity_key } : {}), ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}), ...(row.delivered_at ? { deliveredAt: iso(row.delivered_at) } : {}), ...(row.read_at ? { readAt: iso(row.read_at) } : {}), ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}), ...(row.provider_created_at ? { providerCreatedAt: iso(row.provider_created_at) } : {}), ...(row.raw_payload_sha256 ? { rawPayloadSha256: row.raw_payload_sha256 } : {}) };
  }

  private mapMessageView(row: Row): PrivateMessageView { const { providerMessageKey: _p, bodyIntegrityKey: _i, rawPayloadSha256: _r, ...view } = this.mapMessage(row); return view; }
  private mapIntent(row: Row): PrivateReplyIntent {
    if (!row.body_envelope || !row.body_integrity_key) throw new DomainError("Private reply content has expired.", "private_reply_expired", 410);
    return { id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, conversationId: row.conversation_id, inReplyToMessageId: row.in_reply_to_message_id, body: this.cipher.open(row.workspace_id, "reply-body", row.id, row.body_envelope), bodyIntegrityKey: row.body_integrity_key, status: row.status, idempotencyKey: row.idempotency_key, requestedBy: row.requested_by, attemptCount: row.attempt_count, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), version: row.version, ...(row.approved_by ? { approvedBy: row.approved_by } : {}), ...(row.eligibility_at_approval ? { eligibilityAtApproval: row.eligibility_at_approval } : {}), ...(row.provider_message_key_envelope ? { providerMessageKey: this.cipher.open(row.workspace_id, "reply-provider-message", row.id, row.provider_message_key_envelope) } : {}), ...(row.provider_accepted_at ? { providerAcceptedAt: iso(row.provider_accepted_at) } : {}), ...(row.provider_response_sha256 ? { providerResponseSha256: row.provider_response_sha256 } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_summary ? { errorSummary: row.error_summary } : {}), ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}), ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}) };
  }
  private mapIntentView(row: Row): PrivateReplyIntentView { const { bodyIntegrityKey: _b, idempotencyKey: _i, providerMessageKey: _p, providerResponseSha256: _r, leaseOwner: _o, leaseExpiresAt: _e, ...view } = this.mapIntent(row); return view; }
  private mapSync(row: Row): PrivateConversationSyncState { const cursor = row.cursor_envelope ? this.cipher.open(row.workspace_id, "sync-cursor", row.account_id, row.cursor_envelope) : undefined; return { workspaceId: row.workspace_id, brandId: row.brand_id, accountId: row.account_id, platform: row.platform, connectionMode: row.connection_mode, nextSyncAt: iso(row.next_sync_at), failureCount: row.failure_count, version: row.version, ...(cursor ? { cursor } : {}), ...(row.last_attempted_at ? { lastAttemptedAt: iso(row.last_attempted_at) } : {}), ...(row.last_succeeded_at ? { lastSucceededAt: iso(row.last_succeeded_at) } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_summary ? { errorSummary: row.error_summary } : {}), ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}) }; }
  private mapReceipt(row: Row): PrivateMessageWebhookReceipt { return { id: row.id, provider: row.provider, connectionMode: row.connection_mode, workspaceId: row.workspace_id, brandId: row.brand_id, accountId: row.account_id, payloadSha256: row.payload_sha256, normalizedEvent: this.cipher.openJson(row.workspace_id, "webhook-event", row.id, row.normalized_event_envelope), status: row.status, attempts: row.attempts, availableAt: iso(row.available_at), createdAt: iso(row.created_at), ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}), ...(row.last_error ? { lastError: row.last_error } : {}), ...(row.processed_at ? { processedAt: iso(row.processed_at) } : {}) }; }

  private async participantViews(sql: Queryable, conversationId: string) { const rows: Row[] = await sql<Row[]>`select * from private_conversation_participants where conversation_id = ${conversationId} order by first_seen_at, id`; return rows.map((row: Row) => this.mapParticipantView(row)); }
  private async messageViews(sql: Queryable, conversationId: string) { const rows: Row[] = await sql<Row[]>`select * from private_messages where conversation_id = ${conversationId} order by coalesce(provider_created_at, first_seen_at), id`; return rows.map((row: Row) => this.mapMessageView(row)); }
  private async summary(sql: Queryable, row: Row, viewerId: string) { const participants = await this.participantViews(sql, row.id); const messageRows: Row[] = await sql<Row[]>`select * from private_messages where conversation_id = ${row.id} order by coalesce(provider_created_at, first_seen_at), id`; const messages = messageRows.map((entry: Row) => this.mapMessageView(entry)); const readRows: Row[] = await sql<Row[]>`select last_read_at from private_conversation_reads where workspace_id = ${row.workspace_id} and conversation_id = ${row.id} and user_id = ${viewerId}`; const readAt = maybeIso(readRows[0]?.last_read_at); const unreadCount = messages.filter((message: PrivateMessageView) => message.direction === "incoming" && message.availability === "available" && (!readAt || (message.providerCreatedAt ?? message.firstSeenAt) > readAt)).length; const incoming = [...messages].reverse().find((message: PrivateMessageView) => message.direction === "incoming" && message.availability === "available"); const outgoing = [...messages].reverse().find((message: PrivateMessageView) => message.direction === "outgoing" && message.availability === "available"); const latestMessage = messages.at(-1); return { conversation: this.mapConversationView(row), participants, ...(latestMessage ? { latestMessage } : {}), unreadCount, needsReply: Boolean(incoming && (!outgoing || (incoming.providerCreatedAt ?? incoming.firstSeenAt) > (outgoing.providerCreatedAt ?? outgoing.firstSeenAt))), replyEligibility: row.reply_eligibility } as const; }

  private async approvalContext(sql: Queryable, intentRow: Row): Promise<PrivateReplyApprovalContext> { const conversations = await sql<Row[]>`select * from private_conversations where id = ${intentRow.conversation_id}`; const messages = await sql<Row[]>`select * from private_messages where id = ${intentRow.in_reply_to_message_id}`; const conversation = conversations[0], anchor = messages[0]; if (!conversation || !anchor) throw new DomainError("The private reply execution lineage is unavailable.", "private_reply_execution_lineage_missing", 409); return { intent: this.mapIntent(intentRow), conversation: this.mapConversation(conversation, true), anchorMessage: this.mapMessage(anchor, true), externalConversationId: this.cipher.open(conversation.workspace_id, "conversation-key", conversation.id, conversation.provider_conversation_key_envelope) }; }
  private async executionContext(sql: Queryable, intentRow: Row): Promise<PrivateReplyExecutionContext> { const base = await this.approvalContext(sql, intentRow); const participantRows = await sql<Row[]>`select * from private_conversation_participants where conversation_id = ${intentRow.conversation_id} and role = 'customer' order by first_seen_at limit 1`; const customer = participantRows[0]; if (!customer) throw new DomainError("The private reply recipient is unavailable.", "private_reply_recipient_missing", 409); return { ...base, externalRecipientId: this.cipher.open(customer.workspace_id, "participant-key", customer.id, customer.provider_participant_key_envelope), inReplyToExternalMessageId: base.anchorMessage.providerMessageKey } ; }

  private assertAudit(scope: BrandScope, event: AuditEvent, actorId?: string) { if (event.workspaceId !== scope.workspaceId || (actorId && event.actorId !== actorId) || event.contentItemId !== undefined) throw new Error("Private-message audit events must match the workspace and must not be content-item scoped."); }
  private assertObservation(scope: BrandScope, batch: PrivateProviderObservationBatch) { if (!scope.workspaceId || !scope.brandId || !batch.accountId || batch.platform !== privateConversationPlatformForMode(batch.connectionMode)) throw new Error("Private provider observation lineage is invalid."); }
  private async audit(sql: Queryable, event: AuditEvent) { await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt}) on conflict (id) do nothing`; }
  private async replyEvent(sql: Queryable, intentId: string, event: AuditEvent, from: string | null, to: string, version: number, fence: number) { await sql`insert into private_reply_intent_events (id, intent_id, workspace_id, brand_id, actor_id, from_status, to_status, version, lease_fence, detail, created_at) select ${`${event.id}:private-reply`}, id, workspace_id, brand_id, ${event.actorId}, ${from}, ${to}, ${version}, ${fence}, ${sql.json(event.detail as never)}, ${event.createdAt} from private_reply_intents where id = ${intentId} on conflict (intent_id, version) do nothing`; }
  private async tombstone(sql: Queryable, row: Row, type: "message" | "participant" | "reply_intent" | "webhook_receipt", providerHash: string | null, at: string, reason: "provider_deleted" | "retention_expired" | "user_deleted" = "retention_expired") { const hash = this.cipher.hash(row.workspace_id, row.account_id ?? row.brand_id, "retention-resource", row.id); await sql`insert into private_retention_tombstones (id, workspace_id, brand_id, resource_type, resource_id_hash, provider_key_hash, reason, deleted_at) values (${`private_tombstone_${hash.slice(0, 32)}_${reason}`}, ${row.workspace_id}, ${row.brand_id}, ${type}, ${hash}, ${providerHash}, ${reason}, ${at}) on conflict (workspace_id, resource_type, resource_id_hash, reason) do nothing`; }
}
