import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConnectorRegistry, PrivateConversationConnector } from "@originpost/connectors";
import {
  can,
  DomainError,
  privateConversationBodyIntegrityKey,
  revisePrivateReplyIntent,
  type Actor,
  type AuditEvent,
  type ConnectedAccount,
  type ConnectedAccountRepository,
  type OrganizationRepository,
  type PrivateConversationRepository,
  type PrivateConversationConnectionMode,
  type PrivateReplyIntent,
  type PrivateTextContract,
} from "@originpost/domain";
import type { Queue } from "bullmq";
import { resolveActiveBrand } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type {
  CreatePrivateReplyDraftDto,
  PrivateConversationListQueryDto,
  ReconcilePrivateReplyIntentDto,
  RevisePrivateReplyDraftDto,
  UpdatePrivateConversationDto,
} from "./dto/private-conversations.dto.js";
import {
  privateConversationRecordResponse,
  privateConversationSummaryResponse,
  privateConversationViewResponse,
  privateReplyIntentResponse,
} from "./private-conversation-response.js";

type PrivateConversationQueue = Pick<Queue, "add">;

export interface PrivateConversationsInfrastructure {
  privateConversationRepository: PrivateConversationRepository | null;
  organizationRepository: OrganizationRepository;
  connectedAccountRepository: ConnectedAccountRepository;
  connectors: ConnectorRegistry;
  privateConversationQueue: PrivateConversationQueue | null;
}

const inFlightStatuses = new Set<PrivateReplyIntent["status"]>(["queued", "processing", "uncertain"]);

@Injectable()
export class PrivateConversationsService {
  private readonly logger = new Logger(PrivateConversationsService.name);

  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: PrivateConversationsInfrastructure,
    private readonly config: ConfigService,
  ) {}

  async readiness(workspaceId: string, requestedBrandId: string | undefined, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const demo = this.demoEnabled();
    const repository = this.infrastructure.privateConversationRepository;
    const queueConfigured = Boolean(this.infrastructure.privateConversationQueue);
    if (!demo) {
      return {
        demo: false,
        state: "disabled" as const,
        canProvision: false,
        reason: "demo_disabled" as const,
        brandId: scope.brandId,
        accounts: [],
      };
    }

    const candidates = (await this.infrastructure.connectedAccountRepository.list(scope.workspaceId, scope.brandId))
      .filter((account) => account.platform === "instagram" || account.platform === "facebook");
    const accounts = await Promise.all(candidates.map(async (account) => {
      const connectionMode = this.connectionMode(account);
      const syncState = repository ? await repository.getSyncState(scope, account.id) : null;
      const permissionsReady = account.capabilities.includes("private_message_read") && account.capabilities.includes("private_message_send");
      const syncReady = Boolean(syncState
        && syncState.platform === account.platform
        && syncState.connectionMode === connectionMode);
      return {
        accountId: account.id,
        displayName: account.displayName,
        platform: account.platform,
        connectionMode,
        accountStatus: account.status,
        accountUpdatedAt: account.updatedAt,
        state: account.status === "healthy" && permissionsReady && syncReady ? "ready" as const : "setup_required" as const,
      };
    }));
    const ready = accounts.some((account) => account.state === "ready");
    const hasHealthyAccount = accounts.some((account) => account.accountStatus === "healthy");
    const canProvision = this.isHumanOwner(actor) && Boolean(repository) && queueConfigured && hasHealthyAccount;
    return {
      demo: true,
      state: ready ? "ready" as const : "setup_required" as const,
      canProvision,
      ...(!repository
        ? { reason: "storage_unavailable" as const }
        : !queueConfigured
          ? { reason: "queue_unavailable" as const }
          : !hasHealthyAccount
            ? { reason: "healthy_account_required" as const }
            : {}),
      brandId: scope.brandId,
      accounts,
    };
  }

  async provisionDemoAccount(
    workspaceId: string,
    requestedBrandId: string | undefined,
    accountId: string,
    expectedAccountUpdatedAt: string,
    actor: Actor,
  ) {
    this.assertDemoEnabled();
    this.authorizeDemoOwner(actor);
    const queue = this.infrastructure.privateConversationQueue;
    if (!queue) throw new ServiceUnavailableException("Redis is required to provision the private-message demo.");
    const repository = this.repository();
    const scope = await this.scope(workspaceId, requestedBrandId);
    const current = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, accountId);
    if (!current || current.brandId !== scope.brandId || (current.platform !== "instagram" && current.platform !== "facebook")) {
      throw new DomainError("Private-message demo account not found.", "private_message_demo_account_not_found", 404);
    }
    if (current.status !== "healthy") {
      throw new DomainError("Run Connection Doctor and fix this account before enabling the private-message demo.", "private_message_demo_account_unhealthy", 409);
    }
    if (current.updatedAt !== expectedAccountUpdatedAt) {
      throw new DomainError("This connected account changed. Refresh it and try again.", "private_message_demo_account_version_conflict", 409);
    }

    const platform = current.platform;
    const connectionMode = this.connectionMode(current);
    const connector = this.optionalConnector(connectionMode);
    if (!connector) throw new NotFoundException("The private-message demo is not available.");
    if (connector.privateConversationManifest.apiMode !== "mock"
      || connector.privateConversationManifest.platform !== current.platform
      || !connector.privateConversationManifest.capabilities.read
      || !connector.privateConversationManifest.capabilities.sendText) {
      throw new NotFoundException("The private-message demo is not available.");
    }
    const existingSync = await repository.getSyncState(scope, current.id);
    if (existingSync && (existingSync.platform !== current.platform || existingSync.connectionMode !== connectionMode)) {
      throw new DomainError("This account already has a different private-message connection mode.", "private_message_demo_mode_conflict", 409);
    }

    // ConnectedAccountRepository has no cross-repository transaction or CAS seam. A final
    // reread plus compensating save keeps the only partial failure dormant: capabilities
    // without a sync row cannot be discovered by the recovery worker.
    const latest = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, current.id);
    if (!latest || latest.brandId !== scope.brandId || latest.platform !== platform || latest.updatedAt !== current.updatedAt || latest.status !== "healthy") {
      throw new DomainError("This connected account changed. Refresh it and try again.", "private_message_demo_account_version_conflict", 409);
    }
    const addedCapabilities = (["private_message_read", "private_message_send"] as const)
      .filter((capability) => !latest.capabilities.includes(capability));
    const accountSavedAt = new Date().toISOString();
    const provisionedAccount: ConnectedAccount = {
      ...latest,
      capabilities: [...new Set([...latest.capabilities, ...addedCapabilities])],
      updatedAt: accountSavedAt,
    };

    if (addedCapabilities.length > 0) {
      await this.infrastructure.connectedAccountRepository.save(provisionedAccount, this.audit(scope.workspaceId, actor, "private-conversation.demo-capabilities-enabled", {
        accountId: provisionedAccount.id,
        brandId: scope.brandId,
        platform: provisionedAccount.platform,
        connectionMode,
        addedCapabilities,
        previousAccountUpdatedAt: latest.updatedAt,
        accountUpdatedAt: provisionedAccount.updatedAt,
      }, accountSavedAt));
    }

    let effectiveSync = existingSync;
    try {
      if (!existingSync) {
        const fetchedAt = new Date().toISOString();
        const initialSyncState = {
          workspaceId: scope.workspaceId,
          brandId: scope.brandId,
          accountId: provisionedAccount.id,
          platform,
          connectionMode,
          nextSyncAt: fetchedAt,
          failureCount: 0,
          version: 1,
        } as const;
        await repository.saveSyncPage(scope, {
          syncState: initialSyncState,
          batches: [],
          fetchedAt,
        }, this.audit(scope.workspaceId, actor, "private-conversation.demo-sync-initialized", {
          accountId: provisionedAccount.id,
          brandId: scope.brandId,
          platform: provisionedAccount.platform,
          connectionMode,
        }, fetchedAt));
        effectiveSync = initialSyncState;
      }
    } catch (error) {
      const racedSync = await repository.getSyncState(scope, provisionedAccount.id).catch(() => null);
      if (racedSync && racedSync.platform === platform && racedSync.connectionMode === connectionMode) {
        // A concurrent/replayed owner request completed the same idempotent setup.
        // Keep capabilities and use the same deterministic queue key.
        effectiveSync = racedSync;
      } else {
        if (addedCapabilities.length > 0) await this.compensateDemoCapabilities(scope.workspaceId, latest, provisionedAccount, actor, connectionMode);
        throw error;
      }
    }

    await queue.add("sync-account", {
      name: "sync-account",
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      accountId: provisionedAccount.id,
    }, {
      jobId: `private-demo-sync-${provisionedAccount.id}-v${effectiveSync?.version ?? 1}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    });

    return {
      demo: true,
      state: "ready" as const,
      queued: true,
      account: {
        accountId: provisionedAccount.id,
        displayName: provisionedAccount.displayName,
        platform: provisionedAccount.platform,
        connectionMode,
        accountStatus: provisionedAccount.status,
        accountUpdatedAt: addedCapabilities.length > 0 ? provisionedAccount.updatedAt : latest.updatedAt,
      },
    };
  }

  async list(workspaceId: string, query: PrivateConversationListQueryDto, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, query.brandId);
    const page = await this.repository().list(scope, {
      viewerId: actor.id,
      ...(query.state ? { state: query.state } : {}),
      ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.connectionMode ? { connectionMode: query.connectionMode } : {}),
      ...(query.attention ? { attention: query.attention } : {}),
      ...(query.eligibility ? { eligibility: query.eligibility } : {}),
      ...(query.query ? { query: query.query.normalize("NFC").trim() } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return {
      brandId: scope.brandId,
      items: page.items.map(privateConversationSummaryResponse),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async get(workspaceId: string, requestedBrandId: string | undefined, conversationId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const view = await this.repository().get(scope, conversationId, actor.id);
    if (!view) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    return privateConversationViewResponse(view);
  }

  async update(workspaceId: string, requestedBrandId: string | undefined, conversationId: string, input: UpdatePrivateConversationDto, actor: Actor) {
    this.authorizeHuman(actor, "engagement:send");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const at = new Date().toISOString();
    const updated = await this.repository().updateConversation(scope, conversationId, {
      expectedVersion: input.version,
      actorId: actor.id,
      at,
      ...(input.state ? { state: input.state } : {}),
      ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo || null } : {}),
    }, this.audit(scope.workspaceId, actor, "private-conversation.updated", {
      conversationId,
      state: input.state ?? null,
      assignedTo: input.assignedTo || null,
    }, at));
    if (!updated) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    return privateConversationRecordResponse(updated);
  }

  async markRead(workspaceId: string, requestedBrandId: string | undefined, conversationId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const view = await repository.get(scope, conversationId, actor.id);
    if (!view) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    const latest = view.messages.at(-1);
    await repository.markRead(scope, conversationId, actor.id, {
      lastReadAt: new Date().toISOString(),
      ...(latest ? { lastReadMessageId: latest.id } : {}),
    });
    return { read: true, conversationId };
  }

  async createReplyDraft(workspaceId: string, requestedBrandId: string | undefined, messageId: string, input: CreatePrivateReplyDraftDto, actor: Actor) {
    this.authorize(actor, "engagement:draft");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const anchor = await repository.getMessage(scope, messageId);
    if (!anchor || anchor.direction !== "incoming" || anchor.availability !== "available") {
      throw new DomainError("This private message is not available for a reply.", "private_message_not_replyable", 409);
    }
    const view = await repository.get(scope, anchor.conversationId, actor.id);
    if (!view) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    if (view.replyIntents.some((entry) => inFlightStatuses.has(entry.status))) {
      throw new DomainError("A private reply is already queued, sending, or needs a live check.", "private_reply_in_flight", 409);
    }
    const body = input.body.normalize("NFC").trim();
    if (!body) throw new DomainError("Reply text is required.", "private_reply_empty", 400);
    const connector = this.optionalConnector(anchor.connectionMode);
    if (connector) this.assertTextContract(body, connector.privateConversationManifest.text);

    const id = input.clientRequestId ? `private_reply_${input.clientRequestId}` : `private_reply_${crypto.randomUUID()}`;
    const bodyIntegrityKey = privateConversationBodyIntegrityKey(body, this.integrityKey());
    const existing = await repository.getReplyIntent(scope, id);
    if (existing) {
      if (existing.requestedBy === actor.id && existing.inReplyToMessageId === anchor.id && existing.bodyIntegrityKey === bodyIntegrityKey) {
        return privateReplyIntentResponse(existing);
      }
      throw new DomainError("This draft request ID is already in use.", "private_reply_request_conflict", 409);
    }

    const now = new Date().toISOString();
    const intent: PrivateReplyIntent = {
      id,
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      conversationId: anchor.conversationId,
      inReplyToMessageId: anchor.id,
      body,
      bodyIntegrityKey,
      status: "draft",
      idempotencyKey: `private-message:reply:${id}:v1:${bodyIntegrityKey}`,
      requestedBy: actor.id,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await repository.saveReplyIntent(intent, this.audit(scope.workspaceId, actor, "private-conversation.reply-drafted", {
      intentId: intent.id,
      conversationId: intent.conversationId,
      messageId: anchor.id,
    }, now));
    return privateReplyIntentResponse(intent);
  }

  async reviseReplyDraft(workspaceId: string, requestedBrandId: string | undefined, intentId: string, input: RevisePrivateReplyDraftDto, actor: Actor) {
    this.authorize(actor, "engagement:draft");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const current = await repository.getReplyIntent(scope, intentId);
    if (!current) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    if (actor.role === "creator" && current.requestedBy !== actor.id) {
      throw new ForbiddenException("Creators can revise only their own private reply drafts.");
    }
    if (current.version !== input.version) {
      throw new DomainError("This private reply changed while you were working. Refresh it and try again.", "private_reply_version_conflict", 409);
    }
    const conversationView = await repository.get(scope, current.conversationId, actor.id);
    if (!conversationView) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    const connector = this.optionalConnector(conversationView.conversation.connectionMode);
    if (connector) this.assertTextContract(input.body.normalize("NFC").trim(), connector.privateConversationManifest.text);
    const at = new Date().toISOString();
    const revised = revisePrivateReplyIntent(current, input.body, actor.id, at, this.integrityKey());
    const saved = await repository.reviseReplyIntent(scope, revised, this.audit(scope.workspaceId, actor, "private-conversation.reply-revised", {
      intentId,
      version: revised.version,
    }, at));
    if (!saved) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    return privateReplyIntentResponse(saved);
  }

  async submitReplyDraft(workspaceId: string, requestedBrandId: string | undefined, intentId: string, version: number, actor: Actor) {
    this.authorize(actor, "engagement:draft");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const current = await repository.getReplyIntent(scope, intentId);
    if (!current) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    if (actor.role === "creator" && current.requestedBy !== actor.id) {
      throw new ForbiddenException("Creators can submit only their own private reply drafts.");
    }
    if (current.status !== "draft") throw new DomainError("Only a draft can be submitted for approval.", "private_reply_not_draft", 409);
    const at = new Date().toISOString();
    const submitted = await repository.transitionReplyIntent(scope, {
      intentId,
      expectedVersion: version,
      to: "pending_approval",
      actorId: actor.id,
      at,
    }, this.audit(scope.workspaceId, actor, "private-conversation.reply-submitted", { intentId }, at));
    if (!submitted) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    return privateReplyIntentResponse(submitted);
  }

  async approve(workspaceId: string, requestedBrandId: string | undefined, intentId: string, version: number, actor: Actor) {
    this.authorizeHuman(actor, "engagement:send");
    if (!this.infrastructure.privateConversationQueue) throw new ServiceUnavailableException("Redis is required to send private replies.");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const context = await repository.getReplyApprovalContext(scope, intentId);
    if (!context) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    if (context.intent.status !== "pending_approval") {
      throw new DomainError("Only a reply awaiting approval can be queued.", "private_reply_not_pending_approval", 409);
    }
    const account = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, context.conversation.accountId);
    if (!account || account.brandId !== scope.brandId || account.platform !== context.conversation.platform || !account.capabilities.includes("private_message_send")) {
      throw new DomainError("Private-message send access is missing. Reconnect this account.", "private_message_send_permission_missing", 409);
    }
    const connector = this.requiredConnector(context.conversation.connectionMode);
    if (!connector.privateConversationManifest.capabilities.sendText) {
      throw new DomainError("This connector cannot send private text messages.", "private_message_send_unsupported", 409);
    }
    const eligibility = await connector.inspectReplyEligibility({
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      accountId: account.id,
      platform: context.conversation.platform,
      connectionMode: context.conversation.connectionMode,
      externalConversationId: context.externalConversationId,
      qualifyingEventAt: context.anchorMessage.providerCreatedAt ?? context.anchorMessage.firstSeenAt,
      policyPreference: "standard",
    });
    if (eligibility.state !== "eligible" || (eligibility.expiresAt && Date.parse(eligibility.expiresAt) <= Date.now())) {
      throw new DomainError("The provider reply window is not open.", eligibility.reason === "permission_missing" ? "private_message_send_permission_missing" : "private_reply_window_closed", 409);
    }
    this.assertTextContract(context.intent.body, connector.privateConversationManifest.text);
    const at = new Date().toISOString();
    const queued = await repository.transitionReplyIntent(scope, {
      intentId,
      expectedVersion: version,
      to: "queued",
      actorId: actor.id,
      approvedBy: actor.id,
      eligibilityAtApproval: eligibility,
      at,
    }, this.audit(scope.workspaceId, actor, "private-conversation.reply-approved", {
      intentId,
      eligibilityState: eligibility.state,
      eligibilityExpiresAt: eligibility.expiresAt ?? null,
      contractVersion: eligibility.contractVersion,
    }, at));
    if (!queued) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    await this.infrastructure.privateConversationQueue.add("execute-reply", {
      name: "execute-reply",
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      intentId,
    }, {
      jobId: `private-reply-${intentId}`,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1_000,
    }).catch((error: unknown) => {
      console.error("Private reply is durably queued but Redis dispatch failed:", error instanceof Error ? error.message : "Unknown error");
    });
    return privateReplyIntentResponse(queued);
  }

  async cancel(workspaceId: string, requestedBrandId: string | undefined, intentId: string, version: number, actor: Actor) {
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const intent = await repository.getReplyIntent(scope, intentId);
    if (!intent) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    if (actor.role === "creator") {
      this.authorize(actor, "engagement:draft");
      if (intent.requestedBy !== actor.id || (intent.status !== "draft" && intent.status !== "pending_approval")) {
        throw new ForbiddenException("Creators can cancel only their own unapproved private reply.");
      }
    } else {
      this.authorizeHuman(actor, "engagement:send");
    }
    if (intent.status === "processing" || intent.status === "uncertain") {
      throw new DomainError("Check the provider conversation before changing this reply.", "private_reply_reconciliation_required", 409);
    }
    const at = new Date().toISOString();
    const cancelled = await repository.transitionReplyIntent(scope, {
      intentId,
      expectedVersion: version,
      to: "cancelled",
      actorId: actor.id,
      at,
    }, this.audit(scope.workspaceId, actor, "private-conversation.reply-cancelled", { intentId }, at));
    if (!cancelled) throw new DomainError("Private reply draft not found.", "private_reply_not_found", 404);
    return privateReplyIntentResponse(cancelled);
  }

  async reconcile(workspaceId: string, requestedBrandId: string | undefined, intentId: string, input: ReconcilePrivateReplyIntentDto, actor: Actor) {
    this.authorizeHuman(actor, "engagement:send");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const repository = this.repository();
    const intent = await repository.getReplyIntent(scope, intentId);
    if (!intent) throw new DomainError("Private reply not found.", "private_reply_not_found", 404);
    if (intent.status !== "uncertain") throw new DomainError("Only an uncertain reply can be reconciled.", "private_reply_not_uncertain", 409);
    if (input.outcome === "confirmed_sent" && (!intent.providerMessageKey || !intent.providerAcceptedAt)) {
      throw new DomainError("Exact provider send evidence is not available yet. Refresh the conversation before confirming sent.", "private_reply_provider_evidence_required", 409);
    }
    const at = new Date().toISOString();
    const to = input.outcome === "confirmed_sent" ? "succeeded" as const : "failed" as const;
    const reconciled = await repository.transitionReplyIntent(scope, {
      intentId,
      expectedVersion: input.version,
      to,
      actorId: actor.id,
      at,
      ...(to === "succeeded" ? {
        providerMessageKey: intent.providerMessageKey,
        providerAcceptedAt: intent.providerAcceptedAt,
        ...(intent.providerResponseSha256 ? { providerResponseSha256: intent.providerResponseSha256 } : {}),
      } : {
        errorCode: "operator_confirmed_not_sent",
        errorSummary: "A manager checked the provider conversation and confirmed this reply was not sent.",
      }),
    }, this.audit(scope.workspaceId, actor, "private-conversation.reply-reconciled", {
      intentId,
      outcome: input.outcome,
    }, at));
    if (!reconciled) throw new DomainError("Private reply not found.", "private_reply_not_found", 404);
    return privateReplyIntentResponse(reconciled);
  }

  async syncAccount(workspaceId: string, requestedBrandId: string | undefined, accountId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    if (!this.infrastructure.privateConversationQueue) throw new ServiceUnavailableException("Redis is required to sync private conversations.");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const account = await this.infrastructure.connectedAccountRepository.get(scope.workspaceId, accountId);
    if (!account || account.brandId !== scope.brandId || (account.platform !== "instagram" && account.platform !== "facebook")) {
      throw new DomainError("Private-message account not found.", "private_message_account_not_found", 404);
    }
    if (!account.capabilities.includes("private_message_read")) {
      throw new DomainError("Private-message read access is missing. Reconnect this account.", "private_message_read_permission_missing", 409);
    }
    const syncState = await this.repository().getSyncState(scope, account.id);
    if (!syncState) throw new DomainError("Private messaging is not configured for this account.", "private_message_setup_required", 409);
    const connector = this.requiredConnector(syncState.connectionMode);
    const capability = await connector.inspectCapability({
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      accountId: account.id,
      platform: syncState.platform,
      connectionMode: syncState.connectionMode,
    });
    if (capability.state !== "available") {
      throw new DomainError("Private messaging needs account setup before it can sync.", `private_message_${capability.reason}`, 409);
    }
    await this.infrastructure.privateConversationQueue.add("sync-account", {
      name: "sync-account",
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      accountId: account.id,
      reason: "manual",
    }, {
      jobId: `private-sync-${account.id}-${Math.floor(Date.now() / 300_000)}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    });
    return { queued: true, accountId: account.id, connectionMode: syncState.connectionMode };
  }

  async refreshConversation(workspaceId: string, requestedBrandId: string | undefined, conversationId: string, actor: Actor) {
    this.authorize(actor, "engagement:read");
    const scope = await this.scope(workspaceId, requestedBrandId);
    const view = await this.repository().get(scope, conversationId, actor.id);
    if (!view) throw new DomainError("Private conversation not found.", "private_conversation_not_found", 404);
    return this.syncAccount(workspaceId, scope.brandId, view.conversation.accountId, actor);
  }

  private authorize(actor: Actor, permission: "engagement:read" | "engagement:draft" | "engagement:send"): void {
    if (!can(actor.role, permission)) throw new ForbiddenException("You do not have permission to perform this private-message action.");
  }

  private repository(): PrivateConversationRepository {
    if (!this.infrastructure.privateConversationRepository) {
      throw new ServiceUnavailableException("Private-message storage is not configured.");
    }
    return this.infrastructure.privateConversationRepository;
  }

  private optionalConnector(connectionMode: PrivateConversationConnectionMode): PrivateConversationConnector | null {
    return this.infrastructure.connectors.listPrivateConversations()
      .find((connector) => connector.privateConversationManifest.connectionMode === connectionMode) ?? null;
  }

  private requiredConnector(connectionMode: PrivateConversationConnectionMode): PrivateConversationConnector {
    const connector = this.optionalConnector(connectionMode);
    if (!connector) throw new ServiceUnavailableException("The private-message provider connector is disabled.");
    return connector;
  }

  private authorizeHuman(actor: Actor, permission: "engagement:send"): void {
    this.authorize(actor, permission);
    if (actor.actorType && actor.actorType !== "human") throw new ForbiddenException("A human manager or owner must perform this private-message action.");
  }

  private demoEnabled(): boolean {
    return this.config.get<string>("PRIVATE_MESSAGE_CONNECTOR_MODE") === "mock"
      && this.config.get<string>("NODE_ENV") !== "production";
  }

  private assertDemoEnabled(): void {
    if (!this.demoEnabled()) throw new NotFoundException("The private-message demo is not available.");
  }

  private isHumanOwner(actor: Actor): boolean {
    // Authenticated browser sessions are human and currently omit actorType.
    return actor.role === "owner" && (!actor.actorType || actor.actorType === "human");
  }

  private authorizeDemoOwner(actor: Actor): void {
    if (!this.isHumanOwner(actor)) throw new ForbiddenException("Only a human workspace owner can provision the private-message demo.");
  }

  private connectionMode(account: Pick<ConnectedAccount, "platform">): PrivateConversationConnectionMode {
    if (account.platform === "facebook") return "facebook_page_messenger";
    if (account.platform === "instagram") return "instagram_linked_page";
    throw new DomainError("Private-message demo account not found.", "private_message_demo_account_not_found", 404);
  }

  private async compensateDemoCapabilities(
    workspaceId: string,
    original: ConnectedAccount,
    provisioned: ConnectedAccount,
    actor: Actor,
    connectionMode: PrivateConversationConnectionMode,
  ): Promise<void> {
    try {
      const current = await this.infrastructure.connectedAccountRepository.get(workspaceId, provisioned.id);
      if (!current || current.updatedAt !== provisioned.updatedAt) {
        this.logger.error(`Could not compensate private-message demo capabilities for ${provisioned.id}: the account changed after provisioning.`);
        return;
      }
      const at = new Date().toISOString();
      await this.infrastructure.connectedAccountRepository.save({
        ...current,
        capabilities: [...original.capabilities],
        updatedAt: at,
      }, this.audit(workspaceId, actor, "private-conversation.demo-capabilities-rolled-back", {
        accountId: provisioned.id,
        brandId: provisioned.brandId,
        platform: provisioned.platform,
        connectionMode,
        reason: "sync_state_initialization_failed",
      }, at));
    } catch (compensationError) {
      this.logger.error(
        `Could not compensate private-message demo capabilities for ${provisioned.id}: ${compensationError instanceof Error ? compensationError.message : "Unknown error"}`,
      );
    }
  }

  private async scope(workspaceId: string, requestedBrandId?: string) {
    return { workspaceId, brandId: await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, requestedBrandId) };
  }

  private integrityKey(): Uint8Array {
    const value = this.config.get<string>("PRIVATE_MESSAGE_HASH_KEY")?.trim();
    if (!value) throw new ServiceUnavailableException("PRIVATE_MESSAGE_HASH_KEY is required for private-message drafts.");
    const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    if (decoded.byteLength < 32) throw new ServiceUnavailableException("PRIVATE_MESSAGE_HASH_KEY must decode to at least 32 bytes.");
    return decoded;
  }

  private assertTextContract(body: string, contract: Pick<PrivateTextContract, "maxUtf8Bytes" | "maxCharacters">): void {
    if ((contract.maxUtf8Bytes !== undefined && Buffer.byteLength(body, "utf8") > contract.maxUtf8Bytes)
      || (contract.maxCharacters !== undefined && [...body].length > contract.maxCharacters)) {
      throw new DomainError("Reply text exceeds the verified provider limit.", "private_reply_too_long", 400);
    }
  }

  private audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>, createdAt: string): AuditEvent {
    return { id: `audit_${crypto.randomUUID()}`, workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human", action, detail, createdAt };
  }
}
