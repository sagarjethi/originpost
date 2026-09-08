import { createHash } from "node:crypto";
import { ProviderEngagementError, type ConnectorRegistry } from "@originpost/connectors";
import {
  createNotification,
  engagementBodySha256,
  type AuditEvent,
  type ConnectedAccountRepository,
  type ContentItem,
  type ContentItemRepository,
  type EngagementComment,
  type EngagementPlatform,
  type EngagementRepository,
  type EngagementThread,
  type EngagementWebhookReceipt,
  type NotificationRepository,
} from "@originpost/domain";
import { Queue, Worker } from "bullmq";

export type EngagementJob =
  | { name: "subscribe-account"; workspaceId: string; brandId: string; accountId: string }
  | { name: "process-webhook-receipt"; receiptId: string }
  | { name: "reconcile-proof"; workspaceId: string; brandId: string; contentItemId: string; proofId: string }
  | { name: "execute-action"; workspaceId: string; brandId: string; actionId: string }
  | { name: "recover-pending" }
  | { name: "reconcile-stale" };

export interface EngagementWorkerDependencies {
  connection: { host: string; port: number; username?: string; password?: string };
  repository: ContentItemRepository;
  engagementRepository: EngagementRepository;
  connectedAccountRepository: ConnectedAccountRepository;
  notificationRepository: NotificationRepository;
  connectors: ConnectorRegistry;
}

export type EngagementNotificationWriter = (input: Parameters<typeof createNotification>[0]) => Promise<void>;

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function commentId(accountId: string, externalCommentId: string): string { return `engagement_comment_${sha256(`${accountId}:${externalCommentId}`).slice(0, 32)}`; }
function threadId(proofId: string): string { return `engagement_thread_${sha256(proofId).slice(0, 32)}`; }
function platformName(platform: EngagementPlatform): string { return platform === "facebook" ? "Facebook Page" : "Instagram"; }

export function findEngagementProof(item: ContentItem, proofId: string) {
  return item.proofs.find((proof) => proof.id === proofId && (proof.platform === "instagram" || proof.platform === "facebook"));
}

export function findReceiptProof(item: ContentItem, receipt: Pick<EngagementWebhookReceipt, "provider" | "accountId">, externalMediaId: string) {
  return item.proofs.find((proof) => proof.platform === receipt.provider && proof.accountId === receipt.accountId && proof.externalPostId === externalMediaId);
}

function audit(workspaceId: string, action: string, detail: Record<string, unknown>, contentItemId?: string): AuditEvent {
  return { id: `audit_${crypto.randomUUID()}`, workspaceId, ...(contentItemId ? { contentItemId } : {}), actorId: "originpost-worker", actorType: "system", action, detail, createdAt: new Date().toISOString() };
}

function replyFailureIsAmbiguous(error: unknown): boolean {
  return !(error instanceof ProviderEngagementError)
    || error.code === "uncertain"
    || error.code === "provider_failed";
}

export async function executeEngagementReply(
  dependencies: EngagementWorkerDependencies,
  input: Extract<EngagementJob, { name: "execute-action" }>,
  notify: EngagementNotificationWriter,
) {
  const scope = { workspaceId: input.workspaceId, brandId: input.brandId };
  let action = await dependencies.engagementRepository.getAction(scope, input.actionId);
  if (!action) throw new Error("Engagement reply action not found.");
  if (action.status === "succeeded" || action.status === "cancelled" || action.status === "uncertain") return { skipped: true, reason: `action-${action.status}` };
  if (action.status !== "queued") throw new Error(`Engagement reply is ${action.status}, not queued.`);
  const comment = await dependencies.engagementRepository.getComment(scope, action.commentId);
  const view = await dependencies.engagementRepository.getThread(scope, action.threadId);
  if (!comment || !view) throw new Error("Engagement reply lineage is unavailable.");
  const platform = view.thread.platform;
  const providerName = platformName(platform);
  const account = await dependencies.connectedAccountRepository.get(input.workspaceId, view.thread.accountId);
  if (!account || account.brandId !== input.brandId || account.platform !== platform || !account.capabilities.includes("comment_reply")) throw new Error(`${providerName} reply access is unavailable. Reconnect the account.`);
  const processingAt = new Date().toISOString();
  const processing = await dependencies.engagementRepository.transitionAction(scope, { actionId: action.id, expectedVersion: action.version, to: "processing", actorId: "originpost-worker", at: processingAt }, audit(input.workspaceId, "engagement.reply-processing", { actionId: action.id, bodySha256: action.bodySha256 }, view.thread.contentItemId));
  if (!processing) throw new Error("Engagement reply action disappeared before provider dispatch.");
  action = processing;
  const connector = dependencies.connectors.getEngagement(platform);
  let result: Awaited<ReturnType<typeof connector.replyToComment>>;
  try {
    result = await connector.replyToComment({ workspaceId: input.workspaceId, brandId: input.brandId, accountId: account.id, platform, externalCommentId: comment.externalCommentId, body: action.body, idempotencyKey: action.idempotencyKey });
  } catch (error) {
    const code = error instanceof ProviderEngagementError ? error.code : "provider_failed";
    const next = replyFailureIsAmbiguous(error) ? "uncertain" as const : "failed" as const;
    const at = new Date().toISOString();
    await dependencies.engagementRepository.transitionAction(scope, { actionId: action.id, expectedVersion: action.version, to: next, actorId: "originpost-worker", at, errorCode: code, errorSummary: error instanceof Error ? error.message : `${providerName} reply failed.` }, audit(input.workspaceId, next === "uncertain" ? "engagement.reply-uncertain" : "engagement.reply-failed", { actionId: action.id, errorCode: code, platform }, view.thread.contentItemId));
    await notify({ workspaceId: input.workspaceId, kind: code === "permission_missing" || code === "expired" || code === "unsupported" ? "engagement_permission_missing" : "engagement_reply_failed", severity: code === "unsupported" ? "warning" : "error", title: next === "uncertain" ? `Check the ${providerName} reply` : `${providerName} reply failed`, body: next === "uncertain" ? `${providerName} may have received this reply. Check the live comment before taking another action.` : (error instanceof Error ? error.message : `${providerName} did not accept the reply.`), dedupeKey: `engagement:action:${action.id}:${next}`, accountId: account.id, contentItemId: view.thread.contentItemId, actionUrl: `/?module=Engagement&brand=${encodeURIComponent(input.brandId)}&thread=${encodeURIComponent(view.thread.id)}` });
    return { actionId: action.id, status: next };
  }

  const completedAt = result.createdAt;
  let completed;
  try {
    completed = await dependencies.engagementRepository.transitionAction(scope, { actionId: action.id, expectedVersion: action.version, to: "succeeded", actorId: "originpost-worker", at: completedAt, providerReplyId: result.externalReplyId, providerResponseSha256: sha256(JSON.stringify(result.rawResponse)) }, audit(input.workspaceId, "engagement.reply-succeeded", { actionId: action.id, providerReplyId: result.externalReplyId, providerResponseSha256: sha256(JSON.stringify(result.rawResponse)) }, view.thread.contentItemId));
    if (!completed) throw new Error("Engagement reply action disappeared after provider success.");
  } catch (persistenceError) {
    let current = null;
    try { current = await dependencies.engagementRepository.getAction(scope, action.id); } catch { /* recovery will fence stale processing */ }
    if (current?.status === "succeeded") return { actionId: action.id, status: "succeeded", providerReplyId: current.providerReplyId };
    if (current?.status === "processing") {
      await dependencies.engagementRepository.transitionAction(scope, { actionId: action.id, expectedVersion: current.version, to: "uncertain", actorId: "originpost-worker", at: new Date().toISOString(), errorCode: "result_persistence_uncertain", errorSummary: "The provider accepted this reply, but saving its result was interrupted. Check the live conversation." }, audit(input.workspaceId, "engagement.reply-uncertain", { actionId: action.id, platform, reason: "provider-success-persistence-window" }, view.thread.contentItemId)).catch(() => null);
    }
    await notify({ workspaceId: input.workspaceId, kind: "engagement_reply_failed", severity: "error", title: `Check the ${providerName} reply`, body: `${providerName} accepted the send request, but OriginPost could not confirm the saved result. Check the live comment before taking another action.`, dedupeKey: `engagement:action:${action.id}:uncertain`, accountId: account.id, contentItemId: view.thread.contentItemId, actionUrl: `/?module=Engagement&brand=${encodeURIComponent(input.brandId)}&thread=${encodeURIComponent(view.thread.id)}` });
    console.error("Engagement provider result persistence is uncertain:", persistenceError instanceof Error ? persistenceError.message : "Unknown error");
    return { actionId: action.id, status: "uncertain" as const };
  }

  const outgoing: EngagementComment = { id: commentId(account.id, result.externalReplyId), workspaceId: input.workspaceId, brandId: input.brandId, threadId: view.thread.id, accountId: account.id, externalMediaId: view.thread.externalMediaId, externalCommentId: result.externalReplyId, parentExternalCommentId: comment.externalCommentId, authorScopedId: account.externalAccountId, body: action.body, bodySha256: action.bodySha256, direction: "outgoing", visibility: "visible", providerCreatedAt: completedAt, firstSeenAt: completedAt, lastSeenAt: completedAt, source: "action", rawPayloadSha256: sha256(JSON.stringify(result.rawResponse)) };
  try {
    await dependencies.engagementRepository.ingest(scope, { thread: { ...view.thread, lastActivityAt: completedAt }, comments: [outgoing], syncedAt: completedAt }, audit(input.workspaceId, "engagement.reply-recorded", { actionId: action.id, providerReplyId: result.externalReplyId }, view.thread.contentItemId));
  } catch (error) {
    await notify({ workspaceId: input.workspaceId, kind: "engagement_reply_failed", severity: "warning", title: `${providerName} reply needs a refresh`, body: "The reply was sent, but the local conversation could not be refreshed. Refresh the proof; do not send it again.", dedupeKey: `engagement:action:${action.id}:recording`, accountId: account.id, contentItemId: view.thread.contentItemId, actionUrl: `/?module=Engagement&brand=${encodeURIComponent(input.brandId)}&thread=${encodeURIComponent(view.thread.id)}` });
    console.error("Engagement outgoing comment recording failed:", error instanceof Error ? error.message : "Unknown error");
  }
  return { actionId: action.id, status: "succeeded" as const, providerReplyId: result.externalReplyId };
}

export async function startEngagementWorkers(dependencies: EngagementWorkerDependencies) {
  const queue = new Queue<EngagementJob>("originpost-engagement", { connection: dependencies.connection });
  const notify = async (input: Parameters<typeof createNotification>[0]) => {
    await dependencies.notificationRepository.create(createNotification(input)).catch((error) => {
      console.error("Engagement notification failed:", error instanceof Error ? error.message : "Unknown error");
    });
  };

  const applyFacebookWebhookMutation = async (receipt: EngagementWebhookReceipt, item: ContentItem, proof: ContentItem["proofs"][number]) => {
    if (receipt.provider !== "facebook") return;
    const event = receipt.normalizedEvent;
    const verb = typeof event.verb === "string" ? event.verb : undefined;
    if (!verb || verb === "add") return;
    const externalCommentId = typeof event.externalCommentId === "string" ? event.externalCommentId : undefined;
    const visibility = event.visibility === "visible" || event.visibility === "hidden" || event.visibility === "deleted" ? event.visibility : undefined;
    if (!externalCommentId || !visibility) return;
    const account = await dependencies.connectedAccountRepository.get(receipt.workspaceId, receipt.accountId);
    if (!account || account.brandId !== receipt.brandId || account.platform !== "facebook") throw new Error("Facebook Page webhook account lineage is unavailable.");
    const scope = { workspaceId: receipt.workspaceId, brandId: receipt.brandId };
    const id = commentId(account.id, externalCommentId);
    const prior = await dependencies.engagementRepository.getComment(scope, id);
    const eventBody = typeof event.body === "string" ? event.body.normalize("NFC") : undefined;
    const body = eventBody ?? prior?.body ?? "";
    const providerCreatedAt = typeof event.providerCreatedAt === "string" && !Number.isNaN(Date.parse(event.providerCreatedAt)) ? event.providerCreatedAt : undefined;
    const observedAt = receipt.createdAt;
    const known = await dependencies.engagementRepository.getThread(scope, threadId(proof.id));
    const thread: EngagementThread = known?.thread ?? {
      id: threadId(proof.id), workspaceId: item.workspaceId, brandId: item.brandId, contentItemId: item.id, proofId: proof.id,
      accountId: account.id, platform: "facebook", externalMediaId: proof.externalPostId, state: "open", lastActivityAt: observedAt, version: 1,
    };
    const comment: EngagementComment = {
      id,
      workspaceId: item.workspaceId,
      brandId: item.brandId,
      threadId: thread.id,
      accountId: account.id,
      externalMediaId: proof.externalPostId,
      externalCommentId,
      ...(typeof event.parentExternalCommentId === "string" ? { parentExternalCommentId: event.parentExternalCommentId } : prior?.parentExternalCommentId ? { parentExternalCommentId: prior.parentExternalCommentId } : {}),
      ...(typeof event.authorScopedId === "string" ? { authorScopedId: event.authorScopedId } : prior?.authorScopedId ? { authorScopedId: prior.authorScopedId } : {}),
      ...(typeof event.authorUsername === "string" ? { authorUsername: event.authorUsername } : prior?.authorUsername ? { authorUsername: prior.authorUsername } : {}),
      body,
      bodySha256: engagementBodySha256(body),
      direction: (typeof event.authorScopedId === "string" ? event.authorScopedId : prior?.authorScopedId) === account.externalAccountId ? "outgoing" : "incoming",
      visibility,
      ...(providerCreatedAt ? { providerCreatedAt } : prior?.providerCreatedAt ? { providerCreatedAt: prior.providerCreatedAt } : {}),
      firstSeenAt: prior?.firstSeenAt ?? observedAt,
      lastSeenAt: observedAt,
      source: "webhook",
      rawPayloadSha256: receipt.payloadSha256,
    };
    await dependencies.engagementRepository.ingest(scope, {
      thread: { ...thread, lastActivityAt: observedAt },
      comments: [comment],
      syncedAt: observedAt,
    }, audit(item.workspaceId, "engagement.facebook-webhook-applied", { receiptId: receipt.id, proofId: proof.id, verb, visibility, externalCommentId }, item.id));
  };

  const reconcile = async (input: Extract<EngagementJob, { name: "reconcile-proof" }>) => {
    const item = await dependencies.repository.get(input.workspaceId, input.contentItemId);
    if (!item || item.brandId !== input.brandId) throw new Error("Engagement content item not found in this brand.");
    const proof = findEngagementProof(item, input.proofId);
    if (!proof || (proof.platform !== "instagram" && proof.platform !== "facebook")) throw new Error("Meta publish proof not found.");
    const platform = proof.platform;
    const providerName = platformName(platform);
    const account = await dependencies.connectedAccountRepository.get(input.workspaceId, proof.accountId);
    if (!account || account.brandId !== input.brandId || account.platform !== platform) throw new Error(`${providerName} account not found in this brand.`);
    if (!account.capabilities.includes("comment_read")) {
      await notify({
        workspaceId: input.workspaceId,
        kind: "engagement_permission_missing",
        severity: "warning",
        title: `Reconnect ${providerName} to read comments`,
        body: "This account was connected before comment access was enabled. Reconnect it and grant comment access.",
        dedupeKey: `engagement:account:${account.id}:permission-missing:${new Date().toISOString().slice(0, 10)}`,
        accountId: account.id,
        contentItemId: item.id,
        actionUrl: "/?module=Channels",
      });
      return { skipped: true, reason: "comment-permission-missing" };
    }
    const connector = dependencies.connectors.getEngagement(platform);
    let result;
    try {
      result = await connector.readComments({ workspaceId: item.workspaceId, brandId: item.brandId, accountId: account.id, platform, externalMediaId: proof.externalPostId });
    } catch (error) {
      const code = error instanceof ProviderEngagementError ? error.code : "provider_failed";
      if (code === "permission_missing" || code === "expired") {
        await notify({ workspaceId: item.workspaceId, kind: "engagement_permission_missing", severity: "warning", title: `${providerName} comment access needs attention`, body: error instanceof Error ? error.message : `Reconnect ${providerName} comment access.`, dedupeKey: `engagement:account:${account.id}:${code}:${new Date().toISOString().slice(0, 10)}`, accountId: account.id, contentItemId: item.id, actionUrl: "/?module=Channels" });
      }
      throw error;
    }
    const now = result.fetchedAt;
    const known = await dependencies.engagementRepository.getThread({ workspaceId: item.workspaceId, brandId: item.brandId }, threadId(proof.id));
    const actionReplyIds = new Set(known?.actions.flatMap((action) => action.providerReplyId ? [action.providerReplyId] : []) ?? []);
    const comments: EngagementComment[] = result.comments.map((comment) => {
      const direction = comment.authorScopedId === account.externalAccountId || actionReplyIds.has(comment.externalCommentId) ? "outgoing" as const : "incoming" as const;
      return {
        id: commentId(account.id, comment.externalCommentId),
        workspaceId: item.workspaceId,
        brandId: item.brandId,
        threadId: threadId(proof.id),
        accountId: account.id,
        externalMediaId: proof.externalPostId,
        externalCommentId: comment.externalCommentId,
        ...(comment.parentExternalCommentId ? { parentExternalCommentId: comment.parentExternalCommentId } : {}),
        ...(comment.authorScopedId ? { authorScopedId: comment.authorScopedId } : {}),
        ...(comment.authorUsername ? { authorUsername: comment.authorUsername } : {}),
        body: comment.body.normalize("NFC"),
        bodySha256: engagementBodySha256(comment.body),
        direction,
        visibility: comment.visibility,
        ...(comment.providerCreatedAt ? { providerCreatedAt: comment.providerCreatedAt } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
        source: "reconcile",
        rawPayloadSha256: sha256(JSON.stringify(result.rawResponse)),
      };
    });
    const latest = comments.map((comment) => comment.providerCreatedAt ?? comment.firstSeenAt).sort().at(-1);
    const thread: EngagementThread = known?.thread ?? {
      id: threadId(proof.id), workspaceId: item.workspaceId, brandId: item.brandId, contentItemId: item.id, proofId: proof.id, accountId: account.id,
      platform, externalMediaId: proof.externalPostId, state: "open", lastActivityAt: latest ?? proof.publishedAt, version: 1,
    };
    const ingested = await dependencies.engagementRepository.ingest({ workspaceId: item.workspaceId, brandId: item.brandId }, { thread: { ...thread, lastActivityAt: latest ?? thread.lastActivityAt, lastSyncedAt: now }, comments, syncedAt: now }, audit(item.workspaceId, "engagement.comments-reconciled", { proofId: proof.id, accountId: account.id, commentCount: comments.length, rawPayloadSha256: sha256(JSON.stringify(result.rawResponse)) }, item.id));
    if (ingested.inserted > 0) {
      await notify({ workspaceId: item.workspaceId, kind: "engagement_new_activity", severity: "info", title: `New ${providerName} comments`, body: `${ingested.inserted} new comment${ingested.inserted === 1 ? "" : "s"} arrived on “${item.title}”.`, dedupeKey: `engagement:${platform}:${account.id}:new:${Math.floor(Date.now() / 900_000)}`, accountId: account.id, contentItemId: item.id, actionUrl: `/?module=Engagement&brand=${encodeURIComponent(item.brandId)}&thread=${encodeURIComponent(ingested.thread.id)}` });
    }
    return { threadId: ingested.thread.id, inserted: ingested.inserted, updated: ingested.updated };
  };

  const worker = new Worker<EngagementJob>("originpost-engagement", async (job) => {
    const data = job.data;
    if (data.name === "reconcile-proof") return reconcile(data);
    if (data.name === "execute-action") return executeEngagementReply(dependencies, data, notify);
    if (data.name === "subscribe-account") {
      const account = await dependencies.connectedAccountRepository.get(data.workspaceId, data.accountId);
      if (!account || account.brandId !== data.brandId || (account.platform !== "instagram" && account.platform !== "facebook")) throw new Error("Meta account is not available for comment subscription.");
      const platform = account.platform;
      const result = await dependencies.connectors.getEngagement(platform).subscribeToComments({ workspaceId: data.workspaceId, brandId: data.brandId, accountId: data.accountId, platform, externalAccountId: account.externalAccountId });
      const now = new Date().toISOString();
      await dependencies.connectedAccountRepository.save({ ...account, lastCheckedAt: now, lastHealthyAt: now, updatedAt: now }, audit(account.workspaceId, "engagement.subscription-confirmed", { accountId: account.id, fields: result.fields }));
      return { accountId: account.id, subscribed: true };
    }
    if (data.name === "process-webhook-receipt") {
      const owner = `engagement-${crypto.randomUUID()}`;
      const receipts = await dependencies.engagementRepository.claimWebhookReceipts(owner, 25, 300);
      for (const receipt of receipts) {
        try {
          const mediaId = typeof receipt.normalizedEvent.externalMediaId === "string" ? receipt.normalizedEvent.externalMediaId : undefined;
          if (mediaId) {
            const item = (await dependencies.repository.list(receipt.workspaceId, receipt.brandId)).find((candidate) => Boolean(findReceiptProof(candidate, receipt, mediaId)));
            const proof = item ? findReceiptProof(item, receipt, mediaId) : undefined;
            if (item && proof) {
              await applyFacebookWebhookMutation(receipt, item, proof);
              await reconcile({ name: "reconcile-proof", workspaceId: receipt.workspaceId, brandId: receipt.brandId, contentItemId: item.id, proofId: proof.id });
            }
          }
          await dependencies.engagementRepository.completeWebhookReceipt(receipt.id, owner, new Date().toISOString());
        } catch (error) {
          await dependencies.engagementRepository.failWebhookReceipt(receipt.id, owner, error instanceof Error ? error.message : "Webhook receipt processing failed.", new Date(Date.now() + 60_000).toISOString());
        }
      }
      return { processed: receipts.length };
    }
    if (data.name === "recover-pending") {
      const actions = await dependencies.engagementRepository.listActionsForRecovery(["queued", "processing"], 500);
      const staleBefore = Date.now() - 5 * 60_000;
      let queued = 0;
      let uncertain = 0;
      for (const action of actions) {
        if (action.status === "queued") {
          await queue.add("execute-action", { name: "execute-action", workspaceId: action.workspaceId, brandId: action.brandId, actionId: action.id }, {
            jobId: `engagement-action-recovery-${action.id}-${Math.floor(Date.now() / 60_000)}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1000,
          });
          queued += 1;
          continue;
        }
        if (Date.parse(action.updatedAt) > staleBefore) continue;
        const scope = { workspaceId: action.workspaceId, brandId: action.brandId };
        const view = await dependencies.engagementRepository.getThread(scope, action.threadId);
        const at = new Date().toISOString();
        const changed = await dependencies.engagementRepository.transitionAction(scope, {
          actionId: action.id, expectedVersion: action.version, to: "uncertain", actorId: "originpost-worker", at,
          errorCode: "processing_lease_lost", errorSummary: "Reply processing stopped before its provider result was saved. Check the live conversation before taking another action.",
        }, audit(action.workspaceId, "engagement.reply-uncertain", { actionId: action.id, reason: "stale-processing-recovery" }, view?.thread.contentItemId)).catch(() => null);
        if (!changed) continue;
        uncertain += 1;
        await notify({ workspaceId: action.workspaceId, kind: "engagement_reply_failed", severity: "error", title: "Check the public reply", body: "Reply processing stopped before OriginPost could confirm the provider result. Check the live conversation before taking another action.", dedupeKey: `engagement:action:${action.id}:uncertain`, ...(view ? { contentItemId: view.thread.contentItemId, accountId: view.thread.accountId, actionUrl: `/?module=Engagement&brand=${encodeURIComponent(action.brandId)}&thread=${encodeURIComponent(action.threadId)}` } : {}) });
      }
      return { recovered: actions.length, queued, uncertain };
    }
    const stale = await dependencies.engagementRepository.listThreadsNeedingSync(new Date(Date.now() - 15 * 60_000).toISOString(), 250);
    for (const thread of stale) {
      await queue.add("reconcile-proof", { name: "reconcile-proof", workspaceId: thread.workspaceId, brandId: thread.brandId, contentItemId: thread.contentItemId, proofId: thread.proofId }, { jobId: `engagement-sync-${thread.proofId}-${Math.floor(Date.now() / 300_000)}`, attempts: 3, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 });
    }
    return { queued: stale.length };
  }, { connection: dependencies.connection, concurrency: 3, lockDuration: 120_000 });

  await queue.upsertJobScheduler("engagement-reconcile", { every: 15 * 60_000 }, { name: "reconcile-stale", data: { name: "reconcile-stale" } });
  await queue.upsertJobScheduler("engagement-webhook-poll", { every: 60_000 }, { name: "process-webhook-receipt", data: { name: "process-webhook-receipt", receiptId: "poll" } });
  await queue.upsertJobScheduler("engagement-action-recovery", { every: 60_000 }, { name: "recover-pending", data: { name: "recover-pending" } });
  await queue.add("recover-pending", { name: "recover-pending" }, { jobId: `engagement-recovery-startup-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
  await queue.add("process-webhook-receipt", { name: "process-webhook-receipt", receiptId: "startup" }, { jobId: `engagement-webhook-startup-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });

  worker.on("completed", (job) => console.log(`Engagement job ${job.id} completed.`));
  worker.on("failed", (job, error) => console.error(`Engagement job ${job?.id} failed:`, error.message));
  worker.on("error", (error) => console.error("Engagement worker error:", error.message));
  return { queue, worker, close: async () => Promise.all([worker.close(), queue.close()]) };
}
