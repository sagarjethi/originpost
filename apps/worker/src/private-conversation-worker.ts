import { createHash } from "node:crypto";
import {
  PrivateConversationConnectorError,
  type ConnectorRegistry,
  type ProviderPrivateConversation,
  type PrivateConversationConnector,
} from "@originpost/connectors";
import {
  createNotification,
  type AuditEvent,
  type NotificationRepository,
  type PrivateConversationRepository,
  type PrivateConversationSyncState,
  type PrivateProviderObservationBatch,
  type PrivateReplyEligibility,
  type PrivateReplyExecutionContext,
  type PrivateReplyIntent,
} from "@originpost/domain";
import { Queue, Worker } from "bullmq";

export type PrivateConversationJob =
  | { name: "sync-account"; workspaceId: string; brandId: string; accountId: string }
  | { name: "execute-reply"; workspaceId: string; brandId: string; intentId: string }
  | { name: "process-webhook-receipt"; receiptId?: string }
  | { name: "recover-pending"; maintenance?: "purge-expired" };

export interface PrivateConversationWorkerDependencies {
  connection: { host: string; port: number; username?: string; password?: string };
  privateConversationRepository: PrivateConversationRepository;
  notificationRepository: NotificationRepository;
  connectors: ConnectorRegistry;
  now?: () => Date;
}

export type PrivateConversationNotificationWriter = (input: Parameters<typeof createNotification>[0]) => Promise<void>;
export type PrivateConversationEnqueue = (job: PrivateConversationJob, options: { jobId: string; attempts: number; backoff?: { type: "exponential"; delay: number } }) => Promise<void>;

const SYNC_INTERVAL_MS = 15 * 60_000;
const SEND_LEASE_SECONDS = 120;
export const PRIVATE_RETENTION_PURGE_INTERVAL_MS = 6 * 60 * 60_000;
const PRIVATE_RETENTION_PURGE_LIMIT = 500;

export function privateRetentionSchedule(nowMs = Date.now()) {
  return {
    every: PRIVATE_RETENTION_PURGE_INTERVAL_MS,
    startupJobId: `private-retention-startup-${Math.floor(nowMs / PRIVATE_RETENTION_PURGE_INTERVAL_MS)}`,
  };
}

export function privateConversationWorkerMode(connectors: ConnectorRegistry): "provider" | "maintenance" {
  return connectors.listPrivateConversations().length > 0 ? "provider" : "maintenance";
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function audit(workspaceId: string, action: string, detail: Record<string, unknown>, at: string): AuditEvent {
  return { id: `audit_${crypto.randomUUID()}`, workspaceId, actorId: "originpost-private-worker", actorType: "system", action, detail, createdAt: at };
}

function providerName(context: Pick<PrivateReplyExecutionContext, "conversation">): string {
  return context.conversation.platform === "facebook" ? "Facebook Page Messenger" : "Instagram";
}

function scopeFor(input: { workspaceId: string; brandId: string }) {
  return { workspaceId: input.workspaceId, brandId: input.brandId };
}

function safeEligibilityFailure(connector: PrivateConversationConnector, checkedAt: string): PrivateReplyEligibility {
  return { state: "unknown", checkedAt, reason: "provider_unavailable", contractVersion: connector.privateConversationManifest.contractVersion };
}

export function mapPrivateProviderBatch(
  state: PrivateConversationSyncState,
  conversation: ProviderPrivateConversation,
  replyEligibility: PrivateReplyEligibility,
  fetchedAt: string,
): PrivateProviderObservationBatch {
  return {
    accountId: state.accountId,
    platform: state.platform,
    connectionMode: state.connectionMode,
    externalConversationId: conversation.externalConversationId,
    participants: conversation.participants.map((participant) => ({
      externalParticipantId: participant.externalParticipantId,
      role: participant.role,
      ...(participant.displayName ? { displayName: participant.displayName } : {}),
      ...(participant.username ? { username: participant.username } : {}),
      ...(participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}),
      ...(participant.avatarExpiresAt ? { avatarExpiresAt: participant.avatarExpiresAt } : {}),
    })),
    messages: conversation.messages.map((message) => ({
      externalMessageId: message.externalMessageId,
      ...(message.externalSenderId ? { externalSenderId: message.externalSenderId } : {}),
      direction: message.direction,
      kind: message.kind,
      ...(message.body === undefined ? {} : { body: message.body.normalize("NFC") }),
      attachments: message.attachments.map((attachment) => ({
        ...(attachment.externalAttachmentId ? { externalAttachmentId: attachment.externalAttachmentId } : {}),
        kind: attachment.kind,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
        ...(attachment.url ? { url: attachment.url } : {}),
        ...(attachment.expiresAt ? { expiresAt: attachment.expiresAt } : {}),
        cachePolicy: attachment.cachePolicy,
        availability: attachment.availability,
      })),
      ...(message.replyToExternalMessageId ? { replyToExternalMessageId: message.replyToExternalMessageId } : {}),
      isEcho: message.isEcho,
      availability: message.availability,
      deliveryState: message.deliveryState,
      ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
      ...(message.readAt ? { readAt: message.readAt } : {}),
      ...(message.deletedAt ? { deletedAt: message.deletedAt } : {}),
      ...(message.providerCreatedAt ? { providerCreatedAt: message.providerCreatedAt } : {}),
      observationKind: message.observationKind,
      ...(message.reaction ? { reaction: structuredClone(message.reaction) } : {}),
      observedAt: fetchedAt,
    })),
    replyEligibility,
    syncedAt: fetchedAt,
  };
}

export async function syncPrivateConversationAccount(
  dependencies: Pick<PrivateConversationWorkerDependencies, "privateConversationRepository" | "connectors">,
  input: Extract<PrivateConversationJob, { name: "sync-account" }>,
  notify: PrivateConversationNotificationWriter,
  now = new Date(),
) {
  const scope = scopeFor(input);
  const state = await dependencies.privateConversationRepository.getSyncState(scope, input.accountId);
  if (!state || state.workspaceId !== input.workspaceId || state.brandId !== input.brandId) return { skipped: true, reason: "sync-state-unavailable" };
  const connector = dependencies.connectors.getPrivateConversations(state.connectionMode);
  const page = await connector.sync({
    workspaceId: state.workspaceId,
    brandId: state.brandId,
    accountId: state.accountId,
    platform: state.platform,
    connectionMode: state.connectionMode,
    ...(state.cursor ? { cursor: state.cursor } : {}),
    limit: 100,
  });
  const batches: PrivateProviderObservationBatch[] = [];
  for (const conversation of page.conversations) {
    const qualifyingEventAt = [...conversation.messages]
      .reverse()
      .find((message) => message.direction === "incoming" && message.availability === "available")?.providerCreatedAt;
    let replyEligibility: PrivateReplyEligibility;
    try {
      replyEligibility = await connector.inspectReplyEligibility({
        workspaceId: state.workspaceId,
        brandId: state.brandId,
        accountId: state.accountId,
        platform: state.platform,
        connectionMode: state.connectionMode,
        externalConversationId: conversation.externalConversationId,
        ...(qualifyingEventAt ? { qualifyingEventAt } : {}),
        policyPreference: "standard",
      });
    } catch {
      replyEligibility = safeEligibilityFailure(connector, page.fetchedAt);
    }
    batches.push(mapPrivateProviderBatch(state, conversation, replyEligibility, page.fetchedAt));
  }
  const nextSyncAt = new Date(Date.parse(page.fetchedAt) + (page.complete ? SYNC_INTERVAL_MS : 0)).toISOString();
  const saved = await dependencies.privateConversationRepository.saveSyncPage(scope, {
    syncState: { ...state, lastAttemptedAt: page.fetchedAt, lastSucceededAt: page.fetchedAt, nextSyncAt, failureCount: 0 },
    batches,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    fetchedAt: page.fetchedAt,
  }, audit(state.workspaceId, "private-conversation.sync-page-saved", { accountId: state.accountId, connectionMode: state.connectionMode, conversationCount: batches.length }, page.fetchedAt));
  if (saved.inserted > 0) {
    const activityBucket = page.fetchedAt.slice(0, 16);
    await notify({
      workspaceId: state.workspaceId,
      kind: "private_message_new_activity",
      severity: "info",
      title: "New private message activity",
      body: "A connected messaging account has new private activity. Open Engagement to review it.",
      dedupeKey: `private-message:account:${state.accountId}:activity:${activityBucket}`,
      accountId: state.accountId,
      actionUrl: `/?module=Engagement&brand=${encodeURIComponent(state.brandId)}`,
    });
  }
  return { accountId: state.accountId, conversations: saved.conversations, inserted: saved.inserted, empty: page.conversations.length === 0, nextSyncAt };
}

function failedTransition(eligibility: PrivateReplyEligibility): "expired" | "failed" {
  return eligibility.reason === "window_closed" || eligibility.reason === "conversation_closed" || eligibility.state === "ineligible" ? "expired" : "failed";
}

async function transitionFromProcessing(
  repository: PrivateConversationRepository,
  context: PrivateReplyExecutionContext,
  to: "succeeded" | "failed" | "uncertain" | "expired",
  at: string,
  input: { providerMessageKey?: string; providerAcceptedAt?: string; providerResponseSha256?: string; errorCode?: string; errorSummary?: string },
) {
  return repository.transitionReplyIntent(
    { workspaceId: context.intent.workspaceId, brandId: context.intent.brandId },
    {
      intentId: context.intent.id,
      expectedVersion: context.intent.version,
      to,
      actorId: "originpost-private-worker",
      at,
      ...(context.intent.leaseOwner ? { leaseOwner: context.intent.leaseOwner } : {}),
      ...input,
    },
    audit(context.intent.workspaceId, `private-conversation.reply-${to}`, {
      intentId: context.intent.id,
      conversationId: context.conversation.id,
      accountId: context.conversation.accountId,
      connectionMode: context.conversation.connectionMode,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.providerResponseSha256 ? { providerResponseSha256: input.providerResponseSha256 } : {}),
    }, at),
  );
}

async function notifyReplyResult(
  notify: PrivateConversationNotificationWriter,
  context: PrivateReplyExecutionContext,
  state: "failed" | "uncertain" | "recording",
) {
  const name = providerName(context);
  await notify({
    workspaceId: context.intent.workspaceId,
    kind: "private_message_reply_failed",
    severity: state === "recording" ? "warning" : "error",
    title: state === "failed" ? `${name} private reply failed` : `Check the ${name} private reply`,
    body: state === "failed"
      ? "The provider did not accept the private reply. Review eligibility before revising it."
      : state === "uncertain"
        ? "The provider may have received this private reply. Check the live conversation before taking another action."
        : "The reply was sent, but the local conversation needs a refresh. Do not send it again.",
    dedupeKey: `private-message:intent:${context.intent.id}:${state}`,
    accountId: context.conversation.accountId,
    actionUrl: `/?module=Engagement&brand=${encodeURIComponent(context.intent.brandId)}`,
  });
}

export async function executePrivateConversationReply(
  dependencies: Pick<PrivateConversationWorkerDependencies, "privateConversationRepository" | "connectors">,
  input: Extract<PrivateConversationJob, { name: "execute-reply" }>,
  notify: PrivateConversationNotificationWriter,
  now = new Date(),
  owner = `private-reply-${crypto.randomUUID()}`,
) {
  const scope = scopeFor(input);
  const queued = await dependencies.privateConversationRepository.getReplyIntent(scope, input.intentId);
  if (!queued) return { skipped: true, reason: "reply-unavailable" };
  if (queued.status !== "queued") return { skipped: true, reason: `reply-${queued.status}` };
  let context: PrivateReplyExecutionContext | null;
  try {
    context = await dependencies.privateConversationRepository.claimReplyIntentForExecution(scope, {
      intentId: queued.id,
      expectedVersion: queued.version,
      owner,
      at: now.toISOString(),
      leaseSeconds: SEND_LEASE_SECONDS,
    }, audit(input.workspaceId, "private-conversation.reply-claimed", { intentId: queued.id }, now.toISOString()));
  } catch {
    return { skipped: true, reason: "reply-already-claimed" };
  }
  if (!context) return { skipped: true, reason: "reply-already-claimed" };
  const connector = dependencies.connectors.getPrivateConversations(context.conversation.connectionMode);
  let eligibility: PrivateReplyEligibility;
  try {
    eligibility = await connector.inspectReplyEligibility({
      workspaceId: context.intent.workspaceId,
      brandId: context.intent.brandId,
      accountId: context.conversation.accountId,
      platform: context.conversation.platform,
      connectionMode: context.conversation.connectionMode,
      externalConversationId: context.externalConversationId,
      qualifyingEventAt: context.anchorMessage.providerCreatedAt ?? context.anchorMessage.firstSeenAt,
      policyPreference: "standard",
    });
  } catch {
    eligibility = safeEligibilityFailure(connector, now.toISOString());
  }
  if (eligibility.state !== "eligible" || !eligibility.expiresAt || Date.parse(eligibility.expiresAt) <= now.getTime()) {
    const status = eligibility.expiresAt && Date.parse(eligibility.expiresAt) <= now.getTime() ? "expired" as const : failedTransition(eligibility);
    await transitionFromProcessing(dependencies.privateConversationRepository, context, status, now.toISOString(), { errorCode: eligibility.reason ?? "eligibility_unavailable", errorSummary: "The provider did not confirm that this private reply may be sent." });
    if (eligibility.reason === "permission_missing" || eligibility.reason === "account_disconnected" || eligibility.reason === "contract_unverified") {
      await notify({
        workspaceId: context.intent.workspaceId,
        kind: "private_message_permission_missing",
        severity: "warning",
        title: "Private messaging access needs attention",
        body: "Reconnect or verify the connected messaging account before approving another private reply.",
        dedupeKey: `private-message:account:${context.conversation.accountId}:${eligibility.reason}`,
        accountId: context.conversation.accountId,
        actionUrl: "/?module=Channels",
      });
    }
    return { intentId: context.intent.id, status };
  }

  let result;
  try {
    result = await connector.sendText({
      workspaceId: context.intent.workspaceId,
      brandId: context.intent.brandId,
      accountId: context.conversation.accountId,
      platform: context.conversation.platform,
      connectionMode: context.conversation.connectionMode,
      externalConversationId: context.externalConversationId,
      externalRecipientId: context.externalRecipientId,
      inReplyToExternalMessageId: context.inReplyToExternalMessageId,
      body: context.intent.body,
      idempotencyKey: context.intent.idempotencyKey,
      eligibility,
    });
  } catch (error) {
    const certain = error instanceof PrivateConversationConnectorError && error.certainty === "definitely_not_sent";
    const status = certain ? "failed" as const : "uncertain" as const;
    const errorCode = error instanceof PrivateConversationConnectorError ? error.code : "send_uncertain";
    await transitionFromProcessing(dependencies.privateConversationRepository, context, status, now.toISOString(), { errorCode, errorSummary: certain ? "The provider rejected the private reply before sending." : "The provider result is uncertain. Check the live conversation." }).catch(() => null);
    await notifyReplyResult(notify, context, status);
    return { intentId: context.intent.id, status };
  }

  if (result.status === "rejected") {
    const status = result.code === "window_closed" ? "expired" as const : "failed" as const;
    await transitionFromProcessing(dependencies.privateConversationRepository, context, status, now.toISOString(), { errorCode: result.code, errorSummary: "The provider rejected the private reply before acceptance." });
    await notifyReplyResult(notify, context, "failed");
    return { intentId: context.intent.id, status };
  }

  let responseDigest: string;
  try {
    const serialized = JSON.stringify(result.rawResponse);
    if (typeof serialized !== "string") throw new Error("Provider response is not serializable.");
    responseDigest = sha256(serialized);
  } catch {
    await transitionFromProcessing(dependencies.privateConversationRepository, context, "uncertain", now.toISOString(), { errorCode: "provider_evidence_invalid", errorSummary: "The provider accepted the request, but its evidence could not be validated." }).catch(() => null);
    await notifyReplyResult(notify, context, "uncertain");
    return { intentId: context.intent.id, status: "uncertain" as const };
  }
  const acceptedAtValid = Number.isFinite(Date.parse(result.acceptedAt));
  if (result.externalRecipientId !== context.externalRecipientId || !result.externalMessageId.trim() || !acceptedAtValid) {
    const evidenceAt = acceptedAtValid ? result.acceptedAt : now.toISOString();
    await transitionFromProcessing(dependencies.privateConversationRepository, context, "uncertain", evidenceAt, { errorCode: result.externalRecipientId !== context.externalRecipientId ? "recipient_mismatch" : "provider_evidence_invalid", errorSummary: "The provider returned incomplete or unexpected send evidence. Check the live conversation.", providerResponseSha256: responseDigest }).catch(() => null);
    await notifyReplyResult(notify, context, "uncertain");
    return { intentId: context.intent.id, status: "uncertain" as const };
  }

  const acceptedEvidence = {
    providerMessageKey: result.externalMessageId,
    providerAcceptedAt: result.acceptedAt,
    providerResponseSha256: responseDigest,
  };
  const hasAcceptedEvidence = (intent: PrivateReplyIntent) => intent.providerMessageKey === result.externalMessageId
    && intent.providerAcceptedAt === result.acceptedAt
    && intent.providerResponseSha256 === responseDigest;
  let completed: PrivateReplyIntent | null = null;
  let checkpoint: PrivateReplyIntent | null = null;
  try {
    checkpoint = await transitionFromProcessing(dependencies.privateConversationRepository, context, "uncertain", result.acceptedAt, {
      ...acceptedEvidence,
      errorCode: "provider_accepted_pending_confirmation",
      errorSummary: "The provider accepted this private reply. OriginPost is confirming the exact message before marking it sent.",
    });
    if (!checkpoint || checkpoint.status !== "uncertain" || !hasAcceptedEvidence(checkpoint)) {
      throw new Error("Private reply evidence was not durably checkpointed.");
    }
  } catch {
    const current = await dependencies.privateConversationRepository.getReplyIntent(scope, context.intent.id).catch(() => null);
    if (current?.status === "succeeded") {
      completed = current;
    } else if (current?.status === "uncertain" && hasAcceptedEvidence(current)) {
      checkpoint = current;
    } else if (current?.status === "processing") {
      const recoveredCheckpoint = await transitionFromProcessing(dependencies.privateConversationRepository, { ...context, intent: current }, "uncertain", new Date().toISOString(), {
        ...acceptedEvidence,
        errorCode: "result_persistence_uncertain",
        errorSummary: "The provider accepted this private reply, but saving the result was interrupted.",
      }).catch(() => null);
      checkpoint = recoveredCheckpoint?.status === "uncertain" && hasAcceptedEvidence(recoveredCheckpoint) ? recoveredCheckpoint : null;
    }
    if (!completed && !checkpoint) {
      await notifyReplyResult(notify, context, "uncertain");
      return { intentId: context.intent.id, status: "uncertain" as const };
    }
  }

  if (!completed && checkpoint) {
    if (connector.inspectMessage) {
      let confirmed = false;
      try {
        const probe = await connector.inspectMessage({
          workspaceId: context.intent.workspaceId,
          brandId: context.intent.brandId,
          accountId: context.conversation.accountId,
          platform: context.conversation.platform,
          connectionMode: context.conversation.connectionMode,
          externalConversationId: context.externalConversationId,
          externalMessageId: result.externalMessageId,
        });
        confirmed = probe.state === "found"
          && probe.message.externalMessageId === result.externalMessageId
          && probe.message.direction === "outgoing"
          && probe.message.isEcho
          && probe.message.availability === "available"
          && (probe.message.body === undefined || probe.message.body.normalize("NFC") === context.intent.body.normalize("NFC"));
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        await notifyReplyResult(notify, context, "uncertain");
        return { intentId: context.intent.id, status: "uncertain" as const };
      }
    }
    try {
      completed = await transitionFromProcessing(dependencies.privateConversationRepository, { ...context, intent: checkpoint }, "succeeded", result.acceptedAt, acceptedEvidence);
      if (!completed) throw new Error("Private reply disappeared during provider confirmation.");
    } catch {
      const current = await dependencies.privateConversationRepository.getReplyIntent(scope, context.intent.id).catch(() => null);
      if (current?.status === "succeeded") completed = current;
      else {
        await notifyReplyResult(notify, context, "uncertain");
        return { intentId: context.intent.id, status: "uncertain" as const };
      }
    }
  }

  try {
    await dependencies.privateConversationRepository.ingestProviderObservations(scope, {
      accountId: context.conversation.accountId,
      platform: context.conversation.platform,
      connectionMode: context.conversation.connectionMode,
      externalConversationId: context.externalConversationId,
      participants: [],
      messages: [{
        externalMessageId: result.externalMessageId,
        direction: "outgoing",
        kind: "text",
        body: context.intent.body,
        attachments: [],
        replyToExternalMessageId: context.inReplyToExternalMessageId,
        isEcho: true,
        availability: "available",
        deliveryState: "sent",
        providerCreatedAt: result.acceptedAt,
        observationKind: "echo",
        observedAt: result.acceptedAt,
        rawPayloadSha256: responseDigest,
      }],
      replyEligibility: eligibility,
      syncedAt: result.acceptedAt,
    }, audit(input.workspaceId, "private-conversation.outgoing-echo-ingested", { intentId: context.intent.id, conversationId: context.conversation.id, accountId: context.conversation.accountId }, result.acceptedAt));
  } catch {
    await notifyReplyResult(notify, context, "recording");
  }
  return { intentId: context.intent.id, status: "succeeded" as const };
}

export async function recoverPendingPrivateConversations(
  repository: PrivateConversationRepository,
  enqueue: PrivateConversationEnqueue,
  notify: PrivateConversationNotificationWriter,
  now = new Date(),
  providerJobsEnabled = true,
) {
  const intents = await repository.listReplyIntentsForRecovery(["queued", "processing"], 500);
  let queued = 0;
  let uncertain = 0;
  for (const intent of intents) {
    if (intent.status === "queued") {
      if (providerJobsEnabled) {
        await enqueue({ name: "execute-reply", workspaceId: intent.workspaceId, brandId: intent.brandId, intentId: intent.id }, { jobId: `private-reply-${intent.id}-v${intent.version}`, attempts: 1 });
        queued += 1;
      }
      continue;
    }
    const recovered = await repository.recoverExpiredReplyIntent({ workspaceId: intent.workspaceId, brandId: intent.brandId }, {
      intentId: intent.id,
      expectedVersion: intent.version,
      actorId: "originpost-private-worker",
      at: now.toISOString(),
    }, audit(intent.workspaceId, "private-conversation.reply-lease-recovered", { intentId: intent.id }, now.toISOString())).catch(() => null);
    if (!recovered || recovered.status !== "uncertain") continue;
    uncertain += 1;
    await notify({
      workspaceId: intent.workspaceId,
      kind: "private_message_reply_failed",
      severity: "error",
      title: "Check the private reply",
      body: "Reply processing stopped before OriginPost confirmed a provider result. Check the live conversation before taking another action.",
      dedupeKey: `private-message:intent:${intent.id}:expired-lease`,
      actionUrl: `/?module=Engagement&brand=${encodeURIComponent(intent.brandId)}`,
    });
  }
  const dueAccounts = providerJobsEnabled ? await repository.listAccountsNeedingSync(now.toISOString(), 250) : [];
  for (const state of dueAccounts) {
    await enqueue({ name: "sync-account", workspaceId: state.workspaceId, brandId: state.brandId, accountId: state.accountId }, {
      jobId: `private-sync-${state.accountId}-v${state.version}-${Math.floor(now.getTime() / 60_000)}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
    });
  }
  return { intents: intents.length, queued, uncertain, syncAccounts: dueAccounts.length };
}

export async function processPrivateConversationWebhookReceipts(
  dependencies: Pick<PrivateConversationWorkerDependencies, "privateConversationRepository" | "connectors">,
  notify: PrivateConversationNotificationWriter,
  now = new Date(),
  owner = `private-webhook-${crypto.randomUUID()}`,
) {
  const receipts = await dependencies.privateConversationRepository.claimWebhookReceipts(owner, 25, 120);
  let processed = 0;
  let failed = 0;
  let deleted = 0;
  for (const receipt of receipts) {
    const leaseOwner = receipt.leaseOwner;
    if (!leaseOwner) continue;
    try {
      const connector = dependencies.connectors.getPrivateConversations(receipt.connectionMode);
      if (connector.privateConversationManifest.platform !== receipt.provider) throw new Error("private_webhook_connector_mismatch");
      const eventType = typeof receipt.normalizedEvent.type === "string" ? receipt.normalizedEvent.type : "";
      const externalMessageId = typeof receipt.normalizedEvent.externalMessageId === "string" ? receipt.normalizedEvent.externalMessageId : "";
      if (eventType === "message_deleted" && externalMessageId) {
        const result = await dependencies.privateConversationRepository.applyProviderMessageDeletion(
          { workspaceId: receipt.workspaceId, brandId: receipt.brandId },
          {
            accountId: receipt.accountId,
            platform: receipt.provider,
            connectionMode: receipt.connectionMode,
            externalMessageId,
            observedAt: typeof receipt.normalizedEvent.providerSentAt === "string" ? receipt.normalizedEvent.providerSentAt : now.toISOString(),
            rawPayloadSha256: receipt.payloadSha256,
          },
          audit(receipt.workspaceId, "private-conversation.provider-message-deleted", { receiptId: receipt.id, accountId: receipt.accountId }, now.toISOString()),
        );
        if (result.found) deleted += 1;
      } else {
        const result = await syncPrivateConversationAccount(dependencies, { name: "sync-account", workspaceId: receipt.workspaceId, brandId: receipt.brandId, accountId: receipt.accountId }, notify, now);
        if ("skipped" in result) throw new Error("private_webhook_sync_state_unavailable");
      }
      await dependencies.privateConversationRepository.completeWebhookReceipt(receipt.id, leaseOwner, now.toISOString());
      processed += 1;
    } catch {
      const delaySeconds = Math.min(15 * 60, 30 * 2 ** Math.min(receipt.attempts, 5));
      const retryAt = new Date(now.getTime() + delaySeconds * 1_000).toISOString();
      await dependencies.privateConversationRepository.failWebhookReceipt(receipt.id, leaseOwner, "private_webhook_processing_failed", retryAt, 10).catch(() => undefined);
      failed += 1;
    }
  }
  return { claimed: receipts.length, processed, failed, deleted };
}

export async function purgeExpiredPrivateConversationData(
  repository: PrivateConversationRepository,
  now = new Date(),
  limit = PRIVATE_RETENTION_PURGE_LIMIT,
) {
  return repository.purgeExpired(now.toISOString(), limit);
}

export async function startPrivateConversationWorkers(dependencies: PrivateConversationWorkerDependencies) {
  const queue = new Queue<PrivateConversationJob>("originpost-private-conversations", { connection: dependencies.connection });
  const now = dependencies.now ?? (() => new Date());
  const notify: PrivateConversationNotificationWriter = async (input) => {
    await dependencies.notificationRepository.create(createNotification(input)).catch(() => undefined);
  };
  const enqueue: PrivateConversationEnqueue = async (job, options) => {
    await queue.add(job.name, job, { ...options, removeOnComplete: 500, removeOnFail: 1_000 });
  };
  const mode = privateConversationWorkerMode(dependencies.connectors);
  const providerJobsEnabled = mode === "provider";
  const worker = new Worker<PrivateConversationJob>("originpost-private-conversations", async (job) => {
    if (job.data.name === "sync-account") return providerJobsEnabled ? syncPrivateConversationAccount(dependencies, job.data, notify, now()) : { skipped: true, reason: "private-connector-disabled" };
    if (job.data.name === "execute-reply") return providerJobsEnabled ? executePrivateConversationReply(dependencies, job.data, notify, now()) : { skipped: true, reason: "private-connector-disabled" };
    if (job.data.name === "process-webhook-receipt") return providerJobsEnabled ? processPrivateConversationWebhookReceipts(dependencies, notify, now()) : { skipped: true, reason: "private-connector-disabled" };
    if (job.data.maintenance === "purge-expired") {
      const purged = await purgeExpiredPrivateConversationData(dependencies.privateConversationRepository, now());
      console.log("Private-message retention purge completed.", purged);
      return purged;
    }
    if (providerJobsEnabled) await processPrivateConversationWebhookReceipts(dependencies, notify, now());
    return recoverPendingPrivateConversations(dependencies.privateConversationRepository, enqueue, notify, now(), providerJobsEnabled);
  }, { connection: dependencies.connection, concurrency: 3, lockDuration: 180_000 });

  const retentionSchedule = privateRetentionSchedule();
  await queue.upsertJobScheduler("private-conversation-recovery", { every: 60_000 }, { name: "recover-pending", data: { name: "recover-pending" } });
  await queue.upsertJobScheduler("private-conversation-retention", { every: retentionSchedule.every }, { name: "recover-pending", data: { name: "recover-pending", maintenance: "purge-expired" } });
  await queue.add("recover-pending", { name: "recover-pending" }, { jobId: `private-recovery-startup-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
  await queue.add("recover-pending", { name: "recover-pending", maintenance: "purge-expired" }, {
    jobId: retentionSchedule.startupJobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  worker.on("completed", (job) => console.log(`Private-conversation job ${job.id} completed.`));
  worker.on("failed", (job, error) => console.error(`Private-conversation job ${job?.id} failed:`, error.message));
  worker.on("error", (error) => console.error("Private-conversation worker error:", error.message));
  return { queue, worker, mode, close: async () => Promise.all([worker.close(), queue.close()]) };
}
