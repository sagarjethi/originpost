import { describe, expect, it, vi } from "vitest";
import {
  ConnectorRegistry,
  type PrivateConversationConnector,
  type PrivateSendResult,
  type ProviderPrivateConversationPage,
} from "@originpost/connectors";
import {
  type PrivateConversation,
  type PrivateConversationRepository,
  type PrivateConversationSyncPage,
  type PrivateConversationSyncState,
  type PrivateMessage,
  type PrivateMessageWebhookReceipt,
  type PrivateReplyExecutionContext,
  type PrivateReplyIntent,
} from "@originpost/domain";
import {
  executePrivateConversationReply,
  privateConversationWorkerMode,
  PRIVATE_RETENTION_PURGE_INTERVAL_MS,
  privateRetentionSchedule,
  purgeExpiredPrivateConversationData,
  processPrivateConversationWebhookReceipts,
  recoverPendingPrivateConversations,
  syncPrivateConversationAccount,
  type PrivateConversationEnqueue,
  type PrivateConversationNotificationWriter,
} from "./private-conversation-worker.js";

const nowIso = "2026-08-31T10:10:00.000Z";
const futureIso = "2026-08-31T11:10:00.000Z";

function intent(status: PrivateReplyIntent["status"] = "queued", version = 1): PrivateReplyIntent {
  return {
    id: "intent-local-1",
    workspaceId: "workspace-1",
    brandId: "brand-1",
    conversationId: "conversation-local-1",
    inReplyToMessageId: "message-local-1",
    body: "Thanks for your message.",
    bodyIntegrityKey: "body-integrity-key",
    status,
    idempotencyKey: "idempotency-local-1",
    requestedBy: "manager-1",
    attemptCount: status === "processing" ? 1 : 0,
    ...(status === "processing" ? { leaseOwner: "worker-1:1", leaseExpiresAt: futureIso } : {}),
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: nowIso,
    version,
  };
}

function conversation(): PrivateConversation {
  return {
    id: "conversation-local-1",
    workspaceId: "workspace-1",
    brandId: "brand-1",
    accountId: "account-local-1",
    platform: "instagram",
    connectionMode: "instagram_login",
    providerConversationKey: "provider-conversation-digest",
    state: "open",
    lastActivityAt: nowIso,
    version: 1,
  };
}

function anchor(): PrivateMessage {
  return {
    id: "message-local-1",
    workspaceId: "workspace-1",
    brandId: "brand-1",
    conversationId: "conversation-local-1",
    accountId: "account-local-1",
    platform: "instagram",
    connectionMode: "instagram_login",
    providerMessageKey: "provider-message-digest",
    direction: "incoming",
    kind: "text",
    body: "Hello",
    attachments: [],
    isEcho: false,
    availability: "available",
    deliveryState: "delivered",
    providerCreatedAt: "2026-08-31T10:00:00.000Z",
    firstSeenAt: "2026-08-31T10:00:00.000Z",
    lastSeenAt: "2026-08-31T10:00:00.000Z",
    source: "reconcile",
    observationKind: "message",
  };
}

function executionContext(value = intent("processing", 2)): PrivateReplyExecutionContext {
  return {
    intent: value,
    conversation: conversation(),
    anchorMessage: anchor(),
    externalConversationId: "external-conversation-secret",
    externalRecipientId: "external-recipient-secret",
    inReplyToExternalMessageId: "external-anchor-secret",
  };
}

function connector(overrides: Partial<PrivateConversationConnector> = {}): PrivateConversationConnector {
  return {
    privateConversationManifest: {
      id: "test.private",
      name: "Test private connector",
      platform: "instagram",
      connectionMode: "instagram_login",
      version: "1",
      apiMode: "mock",
      contractVersion: "test-contract-v1",
      capabilities: { read: true, sendText: true, readAttachments: true, observations: ["message", "echo"], webhookFields: [] },
      text: { maxCharacters: 2_000, supportsReplyToMessage: true, contractVersion: "test-contract-v1" },
    },
    inspectCapability: vi.fn(async () => ({ state: "available" as const, checkedAt: nowIso, contractVersion: "test-contract-v1", text: { supportsReplyToMessage: true, contractVersion: "test-contract-v1" } })),
    subscribe: vi.fn(async () => ({ subscribed: true as const, fields: [], subscribedAt: nowIso, rawResponse: {} })),
    sync: vi.fn(async () => ({ conversations: [], fetchedAt: nowIso, complete: true, rawResponse: {} })),
    inspectReplyEligibility: vi.fn(async () => ({ state: "eligible" as const, checkedAt: nowIso, expiresAt: futureIso, contractVersion: "test-contract-v1" })),
    sendText: vi.fn(async () => ({ status: "accepted" as const, externalMessageId: "external-sent-secret", externalRecipientId: "external-recipient-secret", acceptedAt: nowIso, rawResponse: { accepted: true } })),
    ...overrides,
  };
}

function registry(value: PrivateConversationConnector): ConnectorRegistry {
  const result = new ConnectorRegistry();
  result.registerPrivateConversations(value);
  return result;
}

function repository(methods: Partial<PrivateConversationRepository>): PrivateConversationRepository {
  return methods as PrivateConversationRepository;
}

function notificationWriter() {
  return vi.fn(async () => undefined) as PrivateConversationNotificationWriter & ReturnType<typeof vi.fn>;
}

describe("private conversation worker", () => {
  it("claims a queued reply once and skips a duplicate job", async () => {
    let current = intent();
    const sendText = vi.fn(async (): Promise<PrivateSendResult> => ({ status: "accepted", externalMessageId: "external-sent-secret", externalRecipientId: "external-recipient-secret", acceptedAt: nowIso, rawResponse: { accepted: true } }));
    const privateConnector = connector({ sendText });
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent: vi.fn(async (_scope, command) => {
        current = {
          ...current,
          status: command.to,
          version: current.version + 1,
          updatedAt: command.at,
          ...(command.providerMessageKey ? { providerMessageKey: command.providerMessageKey } : {}),
          ...(command.providerAcceptedAt ? { providerAcceptedAt: command.providerAcceptedAt } : {}),
          ...(command.providerResponseSha256 ? { providerResponseSha256: command.providerResponseSha256 } : {}),
        };
        return current;
      }),
      ingestProviderObservations: vi.fn(async () => ({ conversation: conversation(), inserted: 1, updated: 0, deleted: 0, reopened: false })),
    });
    const input = { name: "execute-reply" as const, workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id };
    await expect(executePrivateConversationReply({ privateConversationRepository: repo, connectors: registry(privateConnector) }, input, notificationWriter(), new Date(nowIso), "worker-1")).resolves.toMatchObject({ status: "succeeded" });
    await expect(executePrivateConversationReply({ privateConversationRepository: repo, connectors: registry(privateConnector) }, input, notificationWriter(), new Date(nowIso), "worker-2")).resolves.toMatchObject({ skipped: true, reason: "reply-succeeded" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("checkpoints accepted evidence and uses provider read-back before success", async () => {
    let current = intent();
    const inspectMessage = vi.fn(async () => ({
      state: "found" as const,
      checkedAt: nowIso,
      rawResponse: { found: true },
      message: {
        externalMessageId: "external-sent-secret",
        direction: "outgoing" as const,
        kind: "text" as const,
        body: current.body,
        attachments: [],
        isEcho: true,
        availability: "available" as const,
        deliveryState: "sent" as const,
        providerCreatedAt: nowIso,
        observationKind: "echo" as const,
      },
    }));
    const transitionReplyIntent = vi.fn(async (_scope, command) => {
      current = {
        ...current,
        status: command.to,
        version: current.version + 1,
        updatedAt: command.at,
        ...(command.providerMessageKey ? { providerMessageKey: command.providerMessageKey } : {}),
        ...(command.providerAcceptedAt ? { providerAcceptedAt: command.providerAcceptedAt } : {}),
        ...(command.providerResponseSha256 ? { providerResponseSha256: command.providerResponseSha256 } : {}),
      };
      return current;
    });
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent,
      ingestProviderObservations: vi.fn(async () => ({ conversation: conversation(), inserted: 1, updated: 0, deleted: 0, reopened: false })),
    });

    await expect(executePrivateConversationReply(
      { privateConversationRepository: repo, connectors: registry(connector({ inspectMessage })) },
      { name: "execute-reply", workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id },
      notificationWriter(),
      new Date(nowIso),
      "worker-1",
    )).resolves.toMatchObject({ status: "succeeded" });

    expect(transitionReplyIntent.mock.calls.map((call) => call[1].to)).toEqual(["uncertain", "succeeded"]);
    expect(transitionReplyIntent.mock.calls[0]![1]).toMatchObject({ providerMessageKey: "external-sent-secret", providerAcceptedAt: nowIso });
    expect(inspectMessage).toHaveBeenCalledOnce();
  });

  it("keeps accepted evidence uncertain when provider read-back cannot confirm it", async () => {
    let current = intent();
    const transitionReplyIntent = vi.fn(async (_scope, command) => {
      current = {
        ...current,
        status: command.to,
        version: current.version + 1,
        updatedAt: command.at,
        ...(command.providerMessageKey ? { providerMessageKey: command.providerMessageKey } : {}),
        ...(command.providerAcceptedAt ? { providerAcceptedAt: command.providerAcceptedAt } : {}),
        ...(command.providerResponseSha256 ? { providerResponseSha256: command.providerResponseSha256 } : {}),
      };
      return current;
    });
    const ingestProviderObservations = vi.fn();
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent,
      ingestProviderObservations,
    });
    const inspectMessage = vi.fn(async () => ({ state: "not_found" as const, checkedAt: nowIso, rawResponse: { found: false } }));

    await expect(executePrivateConversationReply(
      { privateConversationRepository: repo, connectors: registry(connector({ inspectMessage })) },
      { name: "execute-reply", workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id },
      notificationWriter(),
      new Date(nowIso),
      "worker-1",
    )).resolves.toMatchObject({ status: "uncertain" });

    expect(transitionReplyIntent.mock.calls.map((call) => call[1].to)).toEqual(["uncertain"]);
    expect(current).toMatchObject({ status: "uncertain", providerMessageKey: "external-sent-secret", providerAcceptedAt: nowIso });
    expect(ingestProviderObservations).not.toHaveBeenCalled();
  });

  it("recovers an expired processing lease to uncertain without sending it", async () => {
    const processing = {
      ...intent("processing", 2),
      providerMessageKey: "accepted-provider-message-secret",
      providerAcceptedAt: nowIso,
      providerResponseSha256: "a".repeat(64),
    };
    const recovered = { ...processing, status: "uncertain" as const, version: 3 };
    const recoverExpiredReplyIntent = vi.fn(async () => recovered);
    const enqueue = vi.fn(async () => undefined) as PrivateConversationEnqueue & ReturnType<typeof vi.fn>;
    const notify = notificationWriter();
    const repo = repository({
      listReplyIntentsForRecovery: vi.fn(async () => [processing]),
      recoverExpiredReplyIntent,
      listAccountsNeedingSync: vi.fn(async () => []),
    });
    await expect(recoverPendingPrivateConversations(repo, enqueue, notify, new Date(nowIso))).resolves.toEqual({ intents: 1, queued: 0, uncertain: 1, syncAccounts: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(recoverExpiredReplyIntent).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(recovered).toMatchObject({ status: "uncertain", providerAcceptedAt: nowIso, providerMessageKey: "accepted-provider-message-secret" });
    expect(JSON.stringify(notify.mock.calls[0]![0])).not.toContain("accepted-provider-message-secret");
  });

  it("uses maintenance-only recovery when private connectors are disabled", async () => {
    const queued = intent("queued", 1);
    const enqueue = vi.fn(async () => undefined) as PrivateConversationEnqueue & ReturnType<typeof vi.fn>;
    const listAccountsNeedingSync = vi.fn();
    const repo = repository({
      listReplyIntentsForRecovery: vi.fn(async () => [queued]),
      listAccountsNeedingSync,
    });
    const disabledRegistry = new ConnectorRegistry();

    expect(privateConversationWorkerMode(disabledRegistry)).toBe("maintenance");
    await expect(recoverPendingPrivateConversations(repo, enqueue, notificationWriter(), new Date(nowIso), false)).resolves.toEqual({ intents: 1, queued: 0, uncertain: 0, syncAccounts: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(listAccountsNeedingSync).not.toHaveBeenCalled();
    expect(privateRetentionSchedule(Date.parse(nowIso)).every).toBe(PRIVATE_RETENTION_PURGE_INTERVAL_MS);
  });

  it("marks provider acceptance uncertain when terminal persistence fails", async () => {
    let current = intent();
    const transitionReplyIntent = vi.fn(async (_scope, command) => {
      if (command.to === "succeeded") throw new Error("database interrupted");
      current = {
        ...current,
        status: command.to,
        version: current.version + 1,
        updatedAt: command.at,
        ...(command.providerMessageKey ? { providerMessageKey: command.providerMessageKey } : {}),
        ...(command.providerAcceptedAt ? { providerAcceptedAt: command.providerAcceptedAt } : {}),
        ...(command.providerResponseSha256 ? { providerResponseSha256: command.providerResponseSha256 } : {}),
      };
      return current;
    });
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent,
      ingestProviderObservations: vi.fn(),
    });
    const notify = notificationWriter();
    const result = await executePrivateConversationReply({ privateConversationRepository: repo, connectors: registry(connector()) }, { name: "execute-reply", workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id }, notify, new Date(nowIso), "worker-1");
    expect(result).toMatchObject({ status: "uncertain" });
    expect(transitionReplyIntent.mock.calls.map((call) => call[1].to)).toEqual(["uncertain", "succeeded"]);
    expect(transitionReplyIntent.mock.calls[0]![1]).toMatchObject({
      providerMessageKey: "external-sent-secret",
      providerAcceptedAt: nowIso,
      providerResponseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      errorCode: "provider_accepted_pending_confirmation",
    });
    expect(current).toMatchObject({ status: "uncertain", providerMessageKey: "external-sent-secret", providerAcceptedAt: nowIso });
    expect(repo.ingestProviderObservations).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not persist an unvalidated provider message ID", async () => {
    let current = intent();
    const transitionReplyIntent = vi.fn(async (_scope, command) => {
      current = { ...current, status: command.to, version: current.version + 1, updatedAt: command.at };
      return current;
    });
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent,
    });
    const mismatched = connector({
      sendText: vi.fn(async () => ({
        status: "accepted" as const,
        externalMessageId: "unvalidated-provider-message-secret",
        externalRecipientId: "wrong-recipient-secret",
        acceptedAt: nowIso,
        rawResponse: { accepted: true },
      })),
    });

    await expect(executePrivateConversationReply(
      { privateConversationRepository: repo, connectors: registry(mismatched) },
      { name: "execute-reply", workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id },
      notificationWriter(),
      new Date(nowIso),
      "worker-1",
    )).resolves.toMatchObject({ status: "uncertain" });

    expect(transitionReplyIntent.mock.calls[0]![1]).toMatchObject({ to: "uncertain", errorCode: "recipient_mismatch" });
    expect(transitionReplyIntent.mock.calls[0]![1]).not.toHaveProperty("providerMessageKey");
    expect(transitionReplyIntent.mock.calls[0]![1]).not.toHaveProperty("providerAcceptedAt");
  });

  it("ingests the outgoing echo when an ambiguous terminal write reads back as succeeded", async () => {
    let current = intent();
    const ingestProviderObservations = vi.fn(async () => ({ conversation: conversation(), inserted: 1, updated: 0, deleted: 0, reopened: false }));
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent: vi.fn(async (_scope, command) => {
        if (command.to === "succeeded") {
          current = {
            ...current,
            status: "succeeded",
            providerMessageKey: command.providerMessageKey,
            providerAcceptedAt: command.providerAcceptedAt,
            providerResponseSha256: command.providerResponseSha256,
            version: current.version + 1,
            updatedAt: command.at,
          };
          throw new Error("commit acknowledgement was lost");
        }
        current = {
          ...current,
          status: command.to,
          providerMessageKey: command.providerMessageKey,
          providerAcceptedAt: command.providerAcceptedAt,
          providerResponseSha256: command.providerResponseSha256,
          version: current.version + 1,
          updatedAt: command.at,
        };
        return current;
      }),
      ingestProviderObservations,
    });

    await expect(executePrivateConversationReply(
      { privateConversationRepository: repo, connectors: registry(connector()) },
      { name: "execute-reply", workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id },
      notificationWriter(),
      new Date(nowIso),
      "worker-1",
    )).resolves.toMatchObject({ status: "succeeded" });

    expect(ingestProviderObservations).toHaveBeenCalledOnce();
  });

  it("does not call send after eligibility has expired", async () => {
    let current = intent();
    const sendText = vi.fn();
    const privateConnector = connector({
      inspectReplyEligibility: vi.fn(async () => ({ state: "eligible" as const, checkedAt: nowIso, expiresAt: nowIso, contractVersion: "test-contract-v1" })),
      sendText,
    });
    const transitionReplyIntent = vi.fn(async (_scope, command) => {
      current = { ...current, status: command.to, version: current.version + 1, updatedAt: command.at };
      return current;
    });
    const repo = repository({
      getReplyIntent: vi.fn(async () => current),
      claimReplyIntentForExecution: vi.fn(async () => {
        current = { ...intent("processing", 2), leaseOwner: "worker-1:1", leaseExpiresAt: futureIso };
        return executionContext(current);
      }),
      transitionReplyIntent,
    });
    await expect(executePrivateConversationReply({ privateConversationRepository: repo, connectors: registry(privateConnector) }, { name: "execute-reply", workspaceId: "workspace-1", brandId: "brand-1", intentId: current.id }, notificationWriter(), new Date(nowIso), "worker-1")).resolves.toMatchObject({ status: "expired" });
    expect(sendText).not.toHaveBeenCalled();
    expect(transitionReplyIntent.mock.calls[0]![1].to).toBe("expired");
  });

  it("commits an empty sync page and advances its cursor", async () => {
    const state: PrivateConversationSyncState = { workspaceId: "workspace-1", brandId: "brand-1", accountId: "account-local-1", platform: "instagram", connectionMode: "instagram_login", cursor: "cursor-old-secret", nextSyncAt: nowIso, failureCount: 0, version: 4 };
    const page: ProviderPrivateConversationPage = { conversations: [], fetchedAt: nowIso, nextCursor: "cursor-new-secret", complete: false, rawResponse: { cursor: "cursor-new-secret" } };
    const saveSyncPage = vi.fn(async (_scope: { workspaceId: string; brandId: string }, _page: PrivateConversationSyncPage) => ({ conversations: 0, inserted: 0, updated: 0, deleted: 0, reopened: 0 }));
    const repo = repository({ getSyncState: vi.fn(async () => state), saveSyncPage });
    const privateConnector = connector({ sync: vi.fn(async () => page) });
    const result = await syncPrivateConversationAccount({ privateConversationRepository: repo, connectors: registry(privateConnector) }, { name: "sync-account", workspaceId: "workspace-1", brandId: "brand-1", accountId: state.accountId }, notificationWriter(), new Date(nowIso));
    expect(result).toMatchObject({ empty: true, nextSyncAt: nowIso });
    expect(saveSyncPage).toHaveBeenCalledOnce();
    expect(saveSyncPage.mock.calls[0]![1]).toMatchObject({ batches: [], nextCursor: "cursor-new-secret", fetchedAt: nowIso });
  });

  it("never puts provider IDs, participant names, or message text into new-activity notifications", async () => {
    const state: PrivateConversationSyncState = { workspaceId: "workspace-1", brandId: "brand-1", accountId: "account-local-1", platform: "instagram", connectionMode: "instagram_login", nextSyncAt: nowIso, failureCount: 0, version: 1 };
    const secrets = ["external-conversation-secret", "external-participant-secret", "external-message-secret", "Highly private message text"];
    const page: ProviderPrivateConversationPage = {
      conversations: [{
        externalConversationId: secrets[0]!,
        participants: [{ externalParticipantId: secrets[1]!, role: "customer", displayName: "Secret Customer Name" }],
        messages: [{ externalMessageId: secrets[2]!, externalSenderId: secrets[1]!, direction: "incoming", kind: "text", body: secrets[3]!, attachments: [], isEcho: false, availability: "available", deliveryState: "delivered", providerCreatedAt: "2026-08-31T10:00:00.000Z", observationKind: "message" }],
        updatedAt: nowIso,
      }],
      fetchedAt: nowIso,
      complete: true,
      rawResponse: { secret: secrets.join("|") },
    };
    const repo = repository({
      getSyncState: vi.fn(async () => state),
      saveSyncPage: vi.fn(async () => ({ conversations: 1, inserted: 1, updated: 0, deleted: 0, reopened: 0 })),
    });
    const notify = notificationWriter();
    await syncPrivateConversationAccount({ privateConversationRepository: repo, connectors: registry(connector({ sync: vi.fn(async () => page) })) }, { name: "sync-account", workspaceId: state.workspaceId, brandId: state.brandId, accountId: state.accountId }, notify, new Date(nowIso));
    const notification = JSON.stringify(notify.mock.calls[0]![0]);
    for (const secret of [...secrets, "Secret Customer Name"]) expect(notification).not.toContain(secret);
    expect(notification).toContain("New private message activity");
  });

  it("processes a provider deletion receipt by immediately erasing the account-scoped message", async () => {
    const receipt: PrivateMessageWebhookReceipt = {
      id: "receipt-1", provider: "instagram", connectionMode: "instagram_login", workspaceId: "workspace-1", brandId: "brand-1", accountId: "account-local-1",
      payloadSha256: "a".repeat(64), normalizedEvent: { type: "message_deleted", externalMessageId: "external-message-secret", providerSentAt: nowIso }, status: "processing", attempts: 1,
      availableAt: nowIso, createdAt: nowIso, leaseOwner: "webhook-owner:1", leaseExpiresAt: futureIso,
    };
    const applyProviderMessageDeletion = vi.fn(async () => ({ found: true, alreadyDeleted: false }));
    const completeWebhookReceipt = vi.fn(async () => undefined);
    const repo = repository({
      claimWebhookReceipts: vi.fn(async () => [receipt]),
      applyProviderMessageDeletion,
      completeWebhookReceipt,
      failWebhookReceipt: vi.fn(async () => undefined),
    });

    await expect(processPrivateConversationWebhookReceipts({ privateConversationRepository: repo, connectors: registry(connector()) }, notificationWriter(), new Date(nowIso), "webhook-owner")).resolves.toEqual({ claimed: 1, processed: 1, failed: 0, deleted: 1 });
    expect(applyProviderMessageDeletion).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", brandId: "brand-1" },
      expect.objectContaining({ accountId: "account-local-1", externalMessageId: "external-message-secret", observedAt: nowIso, rawPayloadSha256: "a".repeat(64) }),
      expect.objectContaining({ action: "private-conversation.provider-message-deleted" }),
    );
    expect(completeWebhookReceipt).toHaveBeenCalledWith("receipt-1", "webhook-owner:1", nowIso);
  });

  it("keeps an unprocessed webhook receipt durable and stores only a fixed safe error", async () => {
    const receipt: PrivateMessageWebhookReceipt = {
      id: "receipt-2", provider: "instagram", connectionMode: "instagram_login", workspaceId: "workspace-1", brandId: "brand-1", accountId: "account-local-1",
      payloadSha256: "b".repeat(64), normalizedEvent: { type: "message", externalMessageId: "external-message-secret" }, status: "processing", attempts: 2,
      availableAt: nowIso, createdAt: nowIso, leaseOwner: "webhook-owner:2", leaseExpiresAt: futureIso,
    };
    const failWebhookReceipt = vi.fn(async () => undefined);
    const repo = repository({ claimWebhookReceipts: vi.fn(async () => [receipt]), getSyncState: vi.fn(async () => null), failWebhookReceipt });

    await expect(processPrivateConversationWebhookReceipts({ privateConversationRepository: repo, connectors: registry(connector()) }, notificationWriter(), new Date(nowIso), "webhook-owner")).resolves.toMatchObject({ claimed: 1, processed: 0, failed: 1 });
    expect(failWebhookReceipt).toHaveBeenCalledWith("receipt-2", "webhook-owner:2", "private_webhook_processing_failed", expect.any(String), 10);
    expect(JSON.stringify(failWebhookReceipt.mock.calls)).not.toContain("external-message-secret");
  });

  it("runs bounded retention maintenance on a six-hour cadence and surfaces repository errors", async () => {
    const purgeExpired = vi.fn(async () => ({ messages: 4, replyIntents: 2, participants: 1, receipts: 3 }));
    const repo = repository({ purgeExpired });
    await expect(purgeExpiredPrivateConversationData(repo, new Date(nowIso))).resolves.toEqual({ messages: 4, replyIntents: 2, participants: 1, receipts: 3 });
    expect(purgeExpired).toHaveBeenCalledWith(nowIso, 500);
    expect(PRIVATE_RETENTION_PURGE_INTERVAL_MS).toBe(6 * 60 * 60_000);
    expect(privateRetentionSchedule(6 * 60 * 60_000 + 123)).toEqual({ every: 6 * 60 * 60_000, startupJobId: "private-retention-startup-1" });

    const failure = new Error("retention database unavailable");
    await expect(purgeExpiredPrivateConversationData(repository({ purgeExpired: vi.fn(async () => { throw failure; }) }), new Date(nowIso))).rejects.toBe(failure);
  });
});
