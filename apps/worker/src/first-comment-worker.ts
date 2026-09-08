import { randomUUID } from "node:crypto";
import { ProviderFirstCommentError, type ConnectorRegistry } from "@originpost/connectors";
import {
  bindFirstCommentToProof,
  createNotification,
  type AuditEvent,
  type ContentItemRepository,
  type FirstCommentIntent,
  type FirstCommentRepository,
  type NotificationRepository,
} from "@originpost/domain";
import { Queue, Worker } from "bullmq";

export type FirstCommentJob = {
  name: "execute" | "recover";
  workspaceId?: string;
  contentItemId?: string;
  intentId?: string;
};

export interface FirstCommentWorkerDependencies {
  connection: { host: string; port: number; username?: string; password?: string };
  repository: ContentItemRepository;
  firstComments: FirstCommentRepository;
  connectors: ConnectorRegistry;
  notifications: NotificationRepository;
}

function audit(intent: FirstCommentIntent, action: string, detail: Record<string, unknown> = {}): AuditEvent {
  return {
    id: `audit_${randomUUID()}`,
    workspaceId: intent.workspaceId,
    contentItemId: intent.contentItemId,
    actorId: "originpost-worker",
    actorType: "system",
    action,
    detail: { intentId: intent.id, targetId: intent.targetId, bodySha256: intent.bodySha256, ...detail },
    createdAt: new Date().toISOString(),
  };
}

function providerName(intent: FirstCommentIntent) {
  return intent.platform === "facebook" ? "Facebook Page" : "Instagram";
}

function failureStatus(error: unknown): "failed" | "uncertain" {
  if (!(error instanceof ProviderFirstCommentError)) return "uncertain";
  return error.code === "permission_missing" || error.code === "unsupported" || error.code === "rate_limited" ? "failed" : "uncertain";
}

export async function executeFirstComment(
  dependencies: Omit<FirstCommentWorkerDependencies, "connection">,
  input: Required<Pick<FirstCommentJob, "workspaceId" | "contentItemId" | "intentId">>,
  owner = `first-comment-${process.pid}-${randomUUID()}`,
) {
  let record = await dependencies.firstComments.get(input.workspaceId, input.intentId);
  if (!record || record.intent.contentItemId !== input.contentItemId) throw new Error("First comment not found.");
  let intent = record.intent;
  if (["succeeded", "failed", "cancelled", "uncertain"].includes(intent.status)) return { skipped: true, reason: `intent-${intent.status}` };

  if (intent.status === "approved") {
    const item = await dependencies.repository.get(intent.workspaceId, intent.contentItemId);
    if (!item) throw new Error("First-comment content item is unavailable.");
    const target = item.targets.find((entry) => entry.id === intent.targetId);
    if (!target || target.draftId !== intent.draftId || target.accountId !== intent.accountId || target.platform !== intent.platform) {
      throw new Error("First-comment target lineage changed after approval.");
    }
    const proof = item.proofs.find((entry) =>
      entry.contentItemId === intent.contentItemId
      && entry.draftId === intent.draftId
      && entry.draftSha256 === intent.draftSha256
      && entry.platform === intent.platform
      && entry.accountId === intent.accountId,
    );
    if (!proof) {
      if (target.status === "failed" || target.status === "cancelled") {
        const failed = { ...intent, status: "failed" as const, version: intent.version + 1, lastError: "The approved post target did not publish, so its first comment was not sent.", updatedAt: new Date().toISOString() };
        await dependencies.firstComments.compareAndSet(failed, intent.version, ["approved"], audit(intent, "first_comment.post_failed"));
        return { intentId: intent.id, status: "failed" as const };
      }
      return { skipped: true, reason: "waiting-for-publication-proof" };
    }
    const queued = bindFirstCommentToProof(intent, proof);
    const saved = await dependencies.firstComments.compareAndSet(queued, intent.version, ["approved"], audit(intent, "first_comment.proof-bound", { publishProofId: proof.id }));
    if (!saved) return { skipped: true, reason: "intent-changed-before-proof-bind" };
    intent = queued;
  }

  if (intent.status !== "queued") return { skipped: true, reason: `intent-${intent.status}` };
  const context = await dependencies.firstComments.claimForExecution(intent.workspaceId, intent.id, owner, 180, audit(intent, "first_comment.processing", { executionMode: intent.executionMode }));
  if (!context) return { skipped: true, reason: "intent-not-claimable" };
  intent = context.intent;
  const connector = dependencies.connectors.getFirstComment(intent.platform);
  const request = {
    workspaceId: intent.workspaceId,
    accountId: intent.accountId,
    platform: intent.platform,
    externalPostId: context.publishProof.externalPostId,
    body: intent.body,
    bodySha256: intent.bodySha256,
    idempotencyKey: intent.immutableIntentSha256,
    publishedAt: context.publishProof.publishedAt,
  };

  try {
    if (intent.executionMode === "write") {
      const capability = await connector.firstCommentCapability({ workspaceId: intent.workspaceId, accountId: intent.accountId, platform: intent.platform });
      if (capability.state !== "supported") throw new ProviderFirstCommentError(capability.reason, capability.state);
      const created = await connector.createFirstComment(request);
      const checkpointed = await dependencies.firstComments.checkpointProviderEvidence(intent.workspaceId, intent.id, owner, created, new Date().toISOString());
      if (!checkpointed) throw new ProviderFirstCommentError(`${providerName(intent)} accepted the comment, but OriginPost could not durably checkpoint the result.`, "uncertain");
      intent = { ...intent, ...created };
    }

    const observed = await connector.inspectFirstComment({
      ...request,
      ...(intent.providerCommentId ? { providerCommentId: intent.providerCommentId } : {}),
      earliestCreatedAt: context.publishProof.publishedAt,
    });
    if (observed.state !== "matched") {
      const reason = observed.state === "ambiguous"
        ? `${providerName(intent)} returned more than one matching comment. A human must verify the live post.`
        : `${providerName(intent)} did not yet return one exact matching comment. Inspect again before any new write.`;
      const uncertain = await dependencies.firstComments.finishExecution(intent.workspaceId, intent.id, owner, "uncertain", reason, audit(intent, "first_comment.uncertain", { observation: observed.state }));
      if (uncertain) await notifyAttention(dependencies, uncertain, reason);
      return { intentId: intent.id, status: "uncertain" as const, observation: observed.state };
    }

    const resolvedAt = new Date().toISOString();
    const resolved = await dependencies.firstComments.resolveWithProof({
      workspaceId: intent.workspaceId,
      intentId: intent.id,
      owner,
      proofId: `first_comment_proof_${randomUUID()}`,
      resolvedAt,
      evidence: {
        grade: intent.executionMode === "write" ? "provider_confirmed" : "provider_reconciled",
        providerCommentId: observed.providerCommentId,
        providerAcceptedAt: observed.providerAcceptedAt,
        providerResponseSha256: observed.providerResponseSha256,
        observedAt: observed.observedAt,
      },
    }, audit(intent, intent.executionMode === "write" ? "first_comment.provider-confirmed" : "first_comment.provider-reconciled", { providerCommentId: observed.providerCommentId }));
    if (!resolved) {
      await notifyAttention(dependencies, intent, `${providerName(intent)} returned an exact comment, but OriginPost could not save its proof. Do not send it again.`);
      return { intentId: intent.id, status: "uncertain" as const, reason: "proof-persistence-interrupted" };
    }
    return { intentId: intent.id, status: "succeeded" as const, proofId: resolved.proof.id };
  } catch (error) {
    const status = failureStatus(error);
    const message = (error instanceof Error ? error.message : `${providerName(intent)} first-comment processing failed.`).slice(0, 500);
    const finished = await dependencies.firstComments.finishExecution(intent.workspaceId, intent.id, owner, status, message, audit(intent, `first_comment.${status}`, { errorCode: error instanceof ProviderFirstCommentError ? error.code : "unknown" }));
    if (finished) await notifyAttention(dependencies, finished, message);
    return { intentId: intent.id, status, error: message };
  }
}

async function notifyAttention(dependencies: Omit<FirstCommentWorkerDependencies, "connection">, intent: FirstCommentIntent, message: string) {
  await dependencies.notifications.create(createNotification({
    workspaceId: intent.workspaceId,
    kind: intent.status === "failed" ? "publish_failed" : "action_required",
    severity: intent.status === "failed" ? "error" : "warning",
    title: intent.status === "failed" ? `${providerName(intent)} first comment failed` : `Check the ${providerName(intent)} first comment`,
    body: message,
    dedupeKey: `first-comment:${intent.id}:${intent.status}:v${intent.version}`,
    accountId: intent.accountId,
    contentItemId: intent.contentItemId,
    targetId: intent.targetId,
    actionUrl: `/?module=Content&item=${encodeURIComponent(intent.contentItemId)}`,
  })).catch((error) => console.error("First-comment notification failed:", error instanceof Error ? error.message : "Unknown error"));
}

export async function startFirstCommentWorkers(dependencies: FirstCommentWorkerDependencies) {
  const queue = new Queue<FirstCommentJob>("originpost-first-comment", { connection: dependencies.connection });
  const runtimeDependencies = {
    repository: dependencies.repository,
    firstComments: dependencies.firstComments,
    connectors: dependencies.connectors,
    notifications: dependencies.notifications,
  };

  const recover = async () => {
    await dependencies.firstComments.recoverExpiredProcessing(100);
    const intents = await dependencies.firstComments.listForRecovery(250);
    for (const intent of intents) {
      if (intent.status !== "approved" && intent.status !== "queued") continue;
      await queue.add("execute", { name: "execute", workspaceId: intent.workspaceId, contentItemId: intent.contentItemId, intentId: intent.id }, {
        jobId: `first-comment-${intent.id}-v${intent.version}`,
        attempts: 1,
        removeOnComplete: 250,
        removeOnFail: 500,
      });
    }
    return intents.length;
  };

  const worker = new Worker<FirstCommentJob>("originpost-first-comment", async (job) => {
    if (job.data.name === "recover") return { recovered: await recover() };
    if (!job.data.workspaceId || !job.data.contentItemId || !job.data.intentId) throw new Error("First-comment job payload is incomplete.");
    return executeFirstComment(runtimeDependencies, { workspaceId: job.data.workspaceId, contentItemId: job.data.contentItemId, intentId: job.data.intentId });
  }, { connection: dependencies.connection, concurrency: 3, lockDuration: 240_000 });

  await recover();
  const timer = setInterval(() => { void recover().catch((error) => console.error("First-comment recovery failed:", error instanceof Error ? error.message : "Unknown error")); }, 60_000);
  timer.unref();
  return {
    queue,
    worker,
    close: async () => {
      clearInterval(timer);
      await Promise.all([worker.close(), queue.close()]);
    },
  };
}
