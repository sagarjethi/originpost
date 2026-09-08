import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  can,
  DomainError,
  engagementBodySha256,
  type Actor,
  type AuditEvent,
  type EngagementAction,
} from "@originpost/domain";
import { resolveActiveBrand } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { CreateReplyDraftDto, EngagementListQueryDto, ReconcileEngagementActionDto, UpdateEngagementThreadDto } from "./dto/engagement.dto.js";

const activeReplyStatuses = new Set<EngagementAction["status"]>(["queued", "processing", "uncertain"]);

@Injectable()
export class EngagementService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly config: ConfigService,
  ) {}

  private authorize(actor: Actor, permission: "engagement:read" | "engagement:draft" | "engagement:send"): void {
    if (!can(actor.role, permission)) throw new ForbiddenException("You do not have permission to perform this engagement action.");
  }

  private async scope(workspaceId: string, requestedBrandId?: string) {
    return { workspaceId, brandId: await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, requestedBrandId) };
  }

  async list(workspaceId: string, query: EngagementListQueryDto, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, query.brandId);
    const page = await this.infrastructure.engagementRepository.listThreads(scope, {
      viewerId: actor.id,
      ...(query.state ? { state: query.state } : {}),
      ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.query ? { query: query.query } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    const items = await Promise.all(page.items.map(async (item) => {
      const account = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, item.thread.accountId);
      const health = {
        replySupported: Boolean(account?.capabilities.includes("comment_reply") && this.replyContractSupported(item.thread.platform)),
        subscriptionStatus: !account ? "missing" as const : account.capabilities.includes("comment_read") ? "active" as const : "permission_missing" as const,
        reconciliationStatus: this.reconciliationStatus(item.thread.lastSyncedAt),
      };
      return {
        ...item,
        ...health,
        thread: { ...item.thread, ...health },
      };
    }));
    return {
      brandId: scope.brandId,
      ...page,
      items,
    };
  }

  async get(workspaceId: string, requestedBrandId: string | undefined, threadId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const view = await this.infrastructure.engagementRepository.getThread(scope, threadId);
    if (!view) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
    const account = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, view.thread.accountId);
    const health = {
      replySupported: Boolean(account?.capabilities.includes("comment_reply") && this.replyContractSupported(view.thread.platform)),
      subscriptionStatus: !account ? "missing" as const : account.capabilities.includes("comment_read") ? "active" as const : "permission_missing" as const,
      reconciliationStatus: this.reconciliationStatus(view.thread.lastSyncedAt),
    };
    return {
      ...view,
      ...health,
      thread: { ...view.thread, ...health },
    };
  }

  async updateThread(workspaceId: string, requestedBrandId: string | undefined, threadId: string, input: UpdateEngagementThreadDto, actor: Actor) {
    this.authorize(actor, "engagement:send");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const at = new Date().toISOString();
    const event = this.audit(scope.workspaceId, actor, "engagement.thread-updated", { threadId, state: input.state ?? null, assignedTo: input.assignedTo ?? null }, at);
    const updated = await this.infrastructure.engagementRepository.updateThread(scope, threadId, {
      expectedVersion: input.version,
      actorId: actor.id,
      at,
      ...(input.state ? { state: input.state } : {}),
      ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo || null } : {}),
    }, event);
    if (!updated) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
    return updated;
  }

  async markRead(workspaceId: string, requestedBrandId: string | undefined, threadId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const view = await this.infrastructure.engagementRepository.getThread(scope, threadId);
    if (!view) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
    const latest = view.comments.at(-1);
    await this.infrastructure.engagementRepository.markRead(scope, threadId, actor.id, {
      lastReadAt: new Date().toISOString(),
      ...(latest ? { lastReadCommentId: latest.id } : {}),
    });
    return { read: true, threadId };
  }

  async createReplyDraft(workspaceId: string, requestedBrandId: string | undefined, commentId: string, input: CreateReplyDraftDto, actor: Actor) {
    this.authorize(actor, "engagement:draft");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const comment = await this.infrastructure.engagementRepository.getComment(scope, commentId);
    if (!comment || comment.direction !== "incoming" || comment.visibility !== "visible") {
      throw new DomainError("This comment is not available for a reply.", "engagement_comment_not_replyable", 409);
    }
    const view = await this.infrastructure.engagementRepository.getThread(scope, comment.threadId);
    if (!view) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
    this.assertNoReplyInFlight(view.actions);
    const body = input.body.normalize("NFC").trim();
    if (!body) throw new DomainError("Reply text is required.", "engagement_reply_empty", 400);
    const now = new Date().toISOString();
    const id = `engagement_action_${crypto.randomUUID()}`;
    const bodySha256 = engagementBodySha256(body);
    const action: EngagementAction = {
      id,
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      threadId: comment.threadId,
      commentId: comment.id,
      type: "reply",
      body,
      bodySha256,
      status: "pending_approval",
      idempotencyKey: `engagement:reply:${id}:v1:${bodySha256}`,
      requestedBy: actor.id,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.infrastructure.engagementRepository.saveAction(action, this.audit(scope.workspaceId, actor, "engagement.reply-drafted", { actionId: action.id, threadId: action.threadId, commentId: action.commentId, bodySha256 }, now));
    return action;
  }

  async approve(workspaceId: string, requestedBrandId: string | undefined, actionId: string, version: number, actor: Actor) {
    this.authorize(actor, "engagement:send");
    if (!this.infrastructure.engagementQueue) throw new ServiceUnavailableException("Redis is required to send replies.");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const action = await this.infrastructure.engagementRepository.getAction(scope, actionId);
    if (!action) throw new DomainError("Reply draft not found.", "engagement_action_not_found", 404);
    const view = await this.infrastructure.engagementRepository.getThread(scope, action.threadId);
    if (!view) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
    this.assertNoReplyInFlight(view.actions, action.id);
    if (!this.replyContractSupported(view.thread.platform)) {
      throw new DomainError("Facebook Page replies need a verified provider contract before they can be sent. Keep this reply as a draft for now.", "facebook_reply_contract_unverified", 409);
    }
    const account = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, view.thread.accountId);
    if (!account?.capabilities.includes("comment_reply")) throw new DomainError("Reply permission is missing. Reconnect this account before sending.", "engagement_reply_permission_missing", 409);
    if (action.requestedBy === actor.id && actor.role === "creator") throw new ForbiddenException("A manager or owner must approve this reply.");
    const at = new Date().toISOString();
    const queued = await this.infrastructure.engagementRepository.transitionAction(scope, { actionId, expectedVersion: version, to: "queued", actorId: actor.id, approvedBy: actor.id, at }, this.audit(scope.workspaceId, actor, "engagement.reply-approved", { actionId, bodySha256: action.bodySha256 }, at));
    if (!queued) throw new DomainError("Reply draft not found.", "engagement_action_not_found", 404);
    await this.infrastructure.engagementQueue.add("execute-action", { name: "execute-action", workspaceId: scope.workspaceId, brandId: scope.brandId, actionId }, {
      jobId: `engagement-action-${actionId}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1000,
    }).catch((error) => console.error("Engagement reply is durably queued but Redis dispatch failed:", error instanceof Error ? error.message : "Unknown error"));
    return queued;
  }

  async cancel(workspaceId: string, requestedBrandId: string | undefined, actionId: string, version: number, actor: Actor) {
    const scope = await this.scope(workspaceId, requestedBrandId);
    const action = await this.infrastructure.engagementRepository.getAction(scope, actionId);
    if (!action) throw new DomainError("Reply draft not found.", "engagement_action_not_found", 404);
    if (actor.role === "creator") {
      this.authorize(actor, "engagement:draft");
      if (action.requestedBy !== actor.id || (action.status !== "draft" && action.status !== "pending_approval")) {
        throw new ForbiddenException("Creators can only cancel their own reply before approval.");
      }
    } else {
      this.authorize(actor, "engagement:send");
    }
    if (action.status === "processing") throw new DomainError("A reply being sent cannot be cancelled. Check the provider result first.", "engagement_action_processing", 409);
    if (action.status === "uncertain") throw new DomainError("Check the live conversation and confirm whether this reply was sent before continuing.", "engagement_action_reconciliation_required", 409);
    const at = new Date().toISOString();
    const cancelled = await this.infrastructure.engagementRepository.transitionAction(scope, { actionId, expectedVersion: version, to: "cancelled", actorId: actor.id, at }, this.audit(scope.workspaceId, actor, "engagement.reply-cancelled", { actionId }, at));
    if (!cancelled) throw new DomainError("Reply draft not found.", "engagement_action_not_found", 404);
    return cancelled;
  }

  async reconcileAction(workspaceId: string, requestedBrandId: string | undefined, actionId: string, input: ReconcileEngagementActionDto, actor: Actor) {
    this.authorize(actor, "engagement:send");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const action = await this.infrastructure.engagementRepository.getAction(scope, actionId);
    if (!action) throw new DomainError("Reply action not found.", "engagement_action_not_found", 404);
    if (action.status !== "uncertain") throw new DomainError("Only a reply that needs checking can be reconciled.", "engagement_action_not_uncertain", 409);
    const providerReplyId = input.providerReplyId?.normalize("NFC").trim();
    if (input.outcome === "confirmed_sent" && !providerReplyId) {
      throw new DomainError("Add the provider reply ID before confirming this reply was sent.", "engagement_provider_reply_id_required", 400);
    }
    const at = new Date().toISOString();
    const to = input.outcome === "confirmed_sent" ? "succeeded" as const : "failed" as const;
    const reconciled = await this.infrastructure.engagementRepository.transitionAction(scope, {
      actionId, expectedVersion: input.version, to, actorId: actor.id, at,
      ...(providerReplyId ? { providerReplyId } : {}),
      ...(to === "failed" ? { errorCode: "operator_confirmed_not_sent", errorSummary: "A manager checked the live conversation and confirmed this reply was not sent." } : {}),
    }, this.audit(scope.workspaceId, actor, "engagement.reply-reconciled", { actionId, outcome: input.outcome, providerReplyId: providerReplyId ?? null }, at));
    if (!reconciled) throw new DomainError("Reply action not found.", "engagement_action_not_found", 404);
    return reconciled;
  }

  async refreshProof(workspaceId: string, requestedBrandId: string | undefined, proofId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    if (!this.infrastructure.engagementQueue) throw new ServiceUnavailableException("Redis is required to refresh comments.");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const item = (await this.infrastructure.repository.list(workspaceId, scope.brandId)).find((entry) => entry.proofs.some((proof) => proof.id === proofId && (proof.platform === "instagram" || proof.platform === "facebook")));
    const proof = item?.proofs.find((entry) => entry.id === proofId && (entry.platform === "instagram" || entry.platform === "facebook"));
    if (!item || !proof) throw new DomainError("Meta publish proof not found.", "engagement_proof_not_found", 404);
    await this.infrastructure.engagementQueue.add("reconcile-proof", { name: "reconcile-proof", workspaceId, brandId: scope.brandId, contentItemId: item.id, proofId }, {
      jobId: `engagement-sync-${proofId}-${Math.floor(Date.now() / 300_000)}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
    return { queued: true, proofId, platform: proof.platform };
  }

  private replyContractSupported(platform: "instagram" | "facebook"): boolean {
    if (platform === "instagram") return true;
    let connectorMode = this.config.get<string>("FACEBOOK_CONNECTOR_MODE") ?? "mock";
    try { connectorMode = this.infrastructure.connectors.getEngagement("facebook").manifest.apiMode; }
    catch { return false; }
    if (connectorMode === "mock") return true;
    const apiVersion = this.config.get<string>("META_GRAPH_API_VERSION");
    const probeVersion = this.config.get<string>("FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_API_VERSION");
    const verifiedAt = this.config.get<string>("FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT");
    return Boolean(apiVersion && probeVersion === apiVersion && verifiedAt && Number.isFinite(Date.parse(verifiedAt)));
  }

  private reconciliationStatus(lastSyncedAt?: string): "current" | "stale" | "unknown" {
    if (!lastSyncedAt || Number.isNaN(Date.parse(lastSyncedAt))) return "unknown";
    return Date.parse(lastSyncedAt) >= Date.now() - 15 * 60_000 ? "current" : "stale";
  }

  private assertNoReplyInFlight(actions: EngagementAction[], exceptActionId?: string): void {
    if (actions.some((action) => action.id !== exceptActionId && activeReplyStatuses.has(action.status))) {
      throw new DomainError("A reply is already queued, sending, or needs a live check. Resolve it before preparing another reply.", "engagement_reply_in_flight", 409);
    }
  }

  private audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>, createdAt: string): AuditEvent {
    return { id: `audit_${crypto.randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action, detail, createdAt };
  }
}
