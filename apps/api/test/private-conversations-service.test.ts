import { ConfigService } from "@nestjs/config";
import { ConnectorRegistry, MockPrivateConversationConnector, createSafeConnectorRegistry } from "@originpost/connectors";
import type {
  Actor,
  ConnectedAccount,
  PrivateConversation,
  PrivateConversationRepository,
  PrivateConversationSyncState,
  PrivateConversationView,
  PrivateMessage,
  PrivateReplyIntent,
} from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { privateConversationViewResponse } from "../src/private-conversations/private-conversation-response.js";
import { PrivateConversationsService, type PrivateConversationsInfrastructure } from "../src/private-conversations/private-conversations.service.js";

const now = new Date().toISOString();
const integrityKey = Buffer.alloc(32, 7).toString("base64");
const scope = { workspaceId: "workspace-1", brandId: "brand-1" };
const conversation: PrivateConversation = {
  id: "conversation-1",
  ...scope,
  accountId: "account-1",
  platform: "instagram",
  connectionMode: "instagram_login",
  providerConversationKey: "provider-conversation-key-secret",
  state: "open",
  lastInboundAt: now,
  lastActivityAt: now,
  lastSyncedAt: now,
  version: 1,
};
const anchor: PrivateMessage = {
  id: "message-1",
  ...scope,
  conversationId: conversation.id,
  accountId: conversation.accountId,
  platform: conversation.platform,
  connectionMode: conversation.connectionMode,
  providerMessageKey: "provider-message-key-secret",
  senderParticipantId: "participant-1",
  direction: "incoming",
  kind: "text",
  body: "Can you help?",
  bodyIntegrityKey: "body-integrity-secret",
  attachments: [],
  isEcho: false,
  availability: "available",
  deliveryState: "delivered",
  providerCreatedAt: now,
  firstSeenAt: now,
  lastSeenAt: now,
  source: "webhook",
  observationKind: "message",
  rawPayloadSha256: "raw-payload-secret",
};

function safeConversation() {
  const { providerConversationKey: _providerConversationKey, ...value } = conversation;
  return value;
}

function safeMessage() {
  const { providerMessageKey: _providerMessageKey, bodyIntegrityKey: _bodyIntegrityKey, rawPayloadSha256: _rawPayloadSha256, ...value } = anchor;
  return value;
}

function view(replyIntents: PrivateConversationView["replyIntents"] = []): PrivateConversationView {
  return {
    conversation: safeConversation(),
    participants: [],
    messages: [safeMessage()],
    replyIntents,
    replyEligibility: { state: "eligible", checkedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), evidence: { mode: "standard", qualifyingEventAt: now, durationSeconds: 60 }, contractVersion: "mock-v1" },
  };
}

function infrastructure(overrides: Partial<PrivateConversationsInfrastructure> = {}) {
  const repository = {
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(async () => view()),
    getMessage: vi.fn(async () => anchor),
    getReplyIntent: vi.fn(async () => null),
    saveReplyIntent: vi.fn(async () => undefined),
    reviseReplyIntent: vi.fn(async (_scope, revised) => revised),
    transitionReplyIntent: vi.fn(async () => null),
    updateConversation: vi.fn(async () => safeConversation()),
    markRead: vi.fn(async () => undefined),
    getReplyApprovalContext: vi.fn(async () => null),
    getReplyExecutionContext: vi.fn(async () => null),
    getSyncState: vi.fn(async () => null),
    saveSyncPage: vi.fn(async () => ({ conversations: 0, inserted: 0, updated: 0, deleted: 0, reopened: 0 })),
  } as unknown as PrivateConversationRepository;
  return {
    privateConversationRepository: repository,
    organizationRepository: { listBrands: vi.fn(async () => [{ id: scope.brandId, workspaceId: scope.workspaceId }]) },
    connectedAccountRepository: { list: vi.fn(async () => []), get: vi.fn(async () => null), save: vi.fn(async () => undefined) },
    connectors: createSafeConnectorRegistry({ privateConversationMode: "mock", nodeEnv: "test" }),
    privateConversationQueue: { add: vi.fn(async () => ({ id: "job-1" })) },
    ...overrides,
  } as unknown as PrivateConversationsInfrastructure;
}

function service(value: PrivateConversationsInfrastructure, config: Record<string, string> = {}) {
  return new PrivateConversationsService(value, new ConfigService({
    PRIVATE_MESSAGE_HASH_KEY: integrityKey,
    PRIVATE_MESSAGE_CONNECTOR_MODE: "mock",
    NODE_ENV: "test",
    ...config,
  }));
}

const owner = { id: "owner-1", name: "Owner", role: "owner", actorType: "human" } satisfies Actor;
const creator = { id: "creator-1", name: "Creator", role: "creator", actorType: "human" } satisfies Actor;

function connectedAccount(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: "account-1",
    ...scope,
    platform: "instagram",
    displayName: "OriginPost Instagram",
    externalAccountId: "provider-account-secret",
    capabilities: ["profile_read"],
    status: "healthy",
    lastCheckedAt: now,
    lastHealthyAt: now,
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("PrivateConversationsService", () => {
  it("fails clearly when private-message storage is disabled", async () => {
    await expect(service(infrastructure({ privateConversationRepository: null })).list(scope.workspaceId, { brandId: scope.brandId }, owner)).rejects.toMatchObject({ status: 503 });
  });

  it("keeps stored conversations readable while provider operations fail closed when connectors are disabled", async () => {
    const list = vi.fn(async () => ({ items: [] }));
    const queueAdd = vi.fn();
    const syncState: PrivateConversationSyncState = { ...scope, accountId: conversation.accountId, platform: "instagram", connectionMode: "instagram_login", nextSyncAt: now, failureCount: 0, version: 1 };
    const infra = infrastructure({
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        list,
        getSyncState: vi.fn(async () => syncState),
      } as PrivateConversationRepository,
      connectedAccountRepository: {
        get: vi.fn(async () => connectedAccount({ capabilities: ["private_message_read"] })),
      } as never,
      connectors: createSafeConnectorRegistry(),
      privateConversationQueue: { add: queueAdd },
    });
    const target = service(infra, { PRIVATE_MESSAGE_CONNECTOR_MODE: "disabled" });

    await expect(target.list(scope.workspaceId, { brandId: scope.brandId }, owner)).resolves.toMatchObject({ brandId: scope.brandId, items: [] });
    await expect(target.syncAccount(scope.workspaceId, scope.brandId, conversation.accountId, owner)).rejects.toMatchObject({ status: 503 });
    expect(list).toHaveBeenCalledOnce();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("reports honest demo readiness without exposing account secrets or raw private capabilities", async () => {
    const instagram = connectedAccount();
    const facebook = connectedAccount({ id: "account-facebook", platform: "facebook", displayName: "OriginPost Facebook", externalAccountId: "facebook-provider-secret" });
    const syncState: PrivateConversationSyncState = { ...scope, accountId: instagram.id, platform: "instagram", connectionMode: "instagram_linked_page", nextSyncAt: now, failureCount: 0, version: 1 };
    const infra = infrastructure({
      connectedAccountRepository: {
        list: vi.fn(async () => [{ ...instagram, capabilities: [...instagram.capabilities, "private_message_read", "private_message_send"] }, facebook]),
      } as never,
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        getSyncState: vi.fn(async (_scope, accountId) => accountId === instagram.id ? syncState : null),
      } as PrivateConversationRepository,
    });
    const result = await service(infra).readiness(scope.workspaceId, scope.brandId, owner);
    expect(result).toMatchObject({ demo: true, state: "ready", canProvision: true, brandId: scope.brandId });
    expect(result.accounts).toEqual([
      expect.objectContaining({ accountId: instagram.id, connectionMode: "instagram_linked_page", state: "ready" }),
      expect.objectContaining({ accountId: facebook.id, connectionMode: "facebook_page_messenger", state: "setup_required" }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("provider-account-secret");
    expect(serialized).not.toContain("facebook-provider-secret");
    expect(serialized).not.toContain("private_message_read");
    expect(serialized).not.toContain("private_message_send");
  });

  it("fails closed outside the non-production mock mode", async () => {
    const infra = infrastructure();
    const disabled = await service(infra, { PRIVATE_MESSAGE_CONNECTOR_MODE: "disabled" }).readiness(scope.workspaceId, scope.brandId, owner);
    expect(disabled).toEqual({ demo: false, state: "disabled", canProvision: false, reason: "demo_disabled", brandId: scope.brandId, accounts: [] });
    await expect(service(infra, { NODE_ENV: "production" }).provisionDemoAccount(scope.workspaceId, scope.brandId, "account-1", now, owner)).rejects.toMatchObject({ status: 404 });
    expect(infra.connectedAccountRepository.get).not.toHaveBeenCalled();
  });

  it("provisions an existing healthy Instagram account, seeds empty sync state, and queues the exact worker job", async () => {
    const account = connectedAccount();
    let stored = account;
    const accountSave = vi.fn(async (value: ConnectedAccount) => { stored = value; });
    const saveSyncPage = vi.fn(async () => ({ conversations: 0, inserted: 0, updated: 0, deleted: 0, reopened: 0 }));
    const queueAdd = vi.fn(async () => ({ id: "sync-job" }));
    const infra = infrastructure({
      connectedAccountRepository: {
        list: vi.fn(async () => [stored]),
        get: vi.fn(async () => stored),
        save: accountSave,
      } as never,
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        getSyncState: vi.fn(async () => null),
        saveSyncPage,
      } as PrivateConversationRepository,
      privateConversationQueue: { add: queueAdd },
    });

    const result = await service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner);
    expect(accountSave).toHaveBeenCalledTimes(1);
    expect(accountSave.mock.calls[0]?.[0]).toMatchObject({
      id: account.id,
      capabilities: expect.arrayContaining(["private_message_read", "private_message_send"]),
    });
    const accountAudit = accountSave.mock.calls[0]?.[1] as { action: string; detail: Record<string, unknown> };
    expect(accountAudit.action).toBe("private-conversation.demo-capabilities-enabled");
    expect(JSON.stringify(accountAudit)).not.toContain(account.externalAccountId);
    expect(saveSyncPage).toHaveBeenCalledWith(scope, expect.objectContaining({
      batches: [],
      syncState: expect.objectContaining({ accountId: account.id, platform: "instagram", connectionMode: "instagram_linked_page", nextSyncAt: expect.any(String), version: 1 }),
    }), expect.objectContaining({ action: "private-conversation.demo-sync-initialized" }));
    expect(queueAdd).toHaveBeenCalledWith("sync-account", {
      name: "sync-account",
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      accountId: account.id,
    }, expect.objectContaining({ jobId: `private-demo-sync-${account.id}-v1`, attempts: 3 }));
    expect(result).toMatchObject({ demo: true, state: "ready", queued: true, account: { accountId: account.id, platform: "instagram", connectionMode: "instagram_linked_page" } });
    expect(JSON.stringify(result)).not.toContain(account.externalAccountId);
    expect(JSON.stringify(result)).not.toContain("private_message_read");
  });

  it("requires the exact current account version and a human owner", async () => {
    const account = connectedAccount();
    const infra = infrastructure({ connectedAccountRepository: { get: vi.fn(async () => account) } as never });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, creator)).rejects.toMatchObject({ status: 403 });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, { ...owner, actorType: "agent" })).rejects.toMatchObject({ status: 403 });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, "2020-01-01T00:00:00.000Z", owner)).rejects.toMatchObject({ code: "private_message_demo_account_version_conflict", statusCode: 409 });
  });

  it("rejects unhealthy, cross-brand, and unsupported accounts before any write", async () => {
    const account = connectedAccount();
    const accountSave = vi.fn();
    const infra = infrastructure({
      connectedAccountRepository: {
        get: vi.fn()
          .mockResolvedValueOnce({ ...account, brandId: "brand-other" })
          .mockResolvedValueOnce({ ...account, status: "refresh_failed" })
          .mockResolvedValueOnce({ ...account, platform: "youtube" }),
        save: accountSave,
      } as never,
    });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner)).rejects.toMatchObject({ code: "private_message_demo_account_not_found", statusCode: 404 });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner)).rejects.toMatchObject({ code: "private_message_demo_account_unhealthy", statusCode: 409 });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner)).rejects.toMatchObject({ code: "private_message_demo_account_not_found", statusCode: 404 });
    expect(accountSave).not.toHaveBeenCalled();
  });

  it("compensates account capabilities when initial sync-state persistence fails", async () => {
    const account = connectedAccount();
    let stored = account;
    const accountSave = vi.fn(async (value: ConnectedAccount) => { stored = value; });
    const syncFailure = new Error("sync insert failed");
    const infra = infrastructure({
      connectedAccountRepository: {
        get: vi.fn(async () => stored),
        save: accountSave,
      } as never,
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        getSyncState: vi.fn(async () => null),
        saveSyncPage: vi.fn(async () => { throw syncFailure; }),
      } as PrivateConversationRepository,
    });
    await expect(service(infra).provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner)).rejects.toBe(syncFailure);
    expect(accountSave).toHaveBeenCalledTimes(2);
    expect(accountSave.mock.calls[1]?.[0]).toMatchObject({ capabilities: account.capabilities });
    expect(accountSave.mock.calls[1]?.[1]).toMatchObject({ action: "private-conversation.demo-capabilities-rolled-back", detail: expect.objectContaining({ reason: "sync_state_initialization_failed" }) });
    expect(infra.privateConversationQueue?.add).not.toHaveBeenCalled();
  });

  it("treats a concurrent sync-state winner as an idempotent success and never removes valid capabilities", async () => {
    const account = connectedAccount();
    let stored = account;
    let validSync: PrivateConversationSyncState | null = null;
    let releaseFirst!: () => void;
    let saveCalls = 0;
    const accountSave = vi.fn(async (value: ConnectedAccount) => { stored = value; });
    const saveSyncPage = vi.fn(async (_scope, page) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        throw new Error("private sync insert raced");
      }
      validSync = { ...page.syncState, version: 1 };
      releaseFirst();
      return { conversations: 0, inserted: 0, updated: 0, deleted: 0, reopened: 0 };
    });
    let accountReads = 0;
    const queueAdd = vi.fn(async () => ({ id: "sync-job" }));
    const infra = infrastructure({
      connectedAccountRepository: {
        // Both requests observe the same optimistic version before either save.
        get: vi.fn(async () => accountReads++ < 4 ? account : stored),
        save: accountSave,
      } as never,
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        getSyncState: vi.fn(async () => validSync),
        saveSyncPage,
      } as PrivateConversationRepository,
      privateConversationQueue: { add: queueAdd },
    });
    const target = service(infra);
    const [first, second] = await Promise.all([
      target.provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner),
      target.provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner),
    ]);
    expect(first).toMatchObject({ demo: true, state: "ready", queued: true });
    expect(second).toMatchObject({ demo: true, state: "ready", queued: true });
    expect(accountSave).toHaveBeenCalledTimes(2);
    expect(accountSave).not.toHaveBeenCalledWith(expect.objectContaining({ capabilities: account.capabilities }), expect.objectContaining({ action: "private-conversation.demo-capabilities-rolled-back" }));
    expect(stored.capabilities).toEqual(expect.arrayContaining(["private_message_read", "private_message_send"]));
    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(queueAdd.mock.calls.map((call) => call[2]?.jobId)).toEqual([
      `private-demo-sync-${account.id}-v1`,
      `private-demo-sync-${account.id}-v1`,
    ]);
  });

  it("replays completed provisioning without rewriting the account or sync cursor", async () => {
    const account = connectedAccount({ capabilities: ["profile_read", "private_message_read", "private_message_send"] });
    const syncState: PrivateConversationSyncState = { ...scope, accountId: account.id, platform: "instagram", connectionMode: "instagram_linked_page", nextSyncAt: now, failureCount: 0, version: 4 };
    const accountSave = vi.fn();
    const saveSyncPage = vi.fn();
    const queueAdd = vi.fn(async () => ({ id: "sync-job" }));
    const infra = infrastructure({
      connectedAccountRepository: { get: vi.fn(async () => account), save: accountSave } as never,
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        getSyncState: vi.fn(async () => syncState),
        saveSyncPage,
      } as PrivateConversationRepository,
      privateConversationQueue: { add: queueAdd },
    });
    const target = service(infra);
    await target.provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner);
    await target.provisionDemoAccount(scope.workspaceId, scope.brandId, account.id, account.updatedAt, owner);
    expect(accountSave).not.toHaveBeenCalled();
    expect(saveSyncPage).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(queueAdd.mock.calls.every((call) => call[2]?.jobId === `private-demo-sync-${account.id}-v4`)).toBe(true);
  });

  it("uses explicit response projections that remove provider IDs, integrity keys, response digests, leases, and review digests", () => {
    const hostile = {
      conversation: { ...safeConversation(), providerConversationKey: "provider-conversation-leak" },
      participants: [{ id: "participant-1", ...scope, conversationId: conversation.id, accountId: conversation.accountId, providerParticipantKey: "provider-participant-leak", role: "customer", firstSeenAt: now, lastSeenAt: now }],
      messages: [{ ...safeMessage(), providerMessageKey: "provider-message-leak", bodyIntegrityKey: "body-integrity-leak", rawPayloadSha256: "raw-digest-leak", attachments: [{ id: "attachment-1", kind: "image", providerAttachmentKey: "provider-attachment-leak", url: "https://private-provider.example/image-secret.jpg", cachePolicy: "reference_only", availability: "available" }] }],
      replyIntents: [{ id: "intent-1", ...scope, conversationId: conversation.id, inReplyToMessageId: anchor.id, body: "Reply", bodyIntegrityKey: "reply-integrity-leak", status: "uncertain", idempotencyKey: "idempotency-leak", requestedBy: creator.id, eligibilityAtApproval: { state: "eligible", checkedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), contractVersion: "review-v1", evidence: { mode: "human_agent", qualifyingEventAt: now, durationSeconds: 604_800, review: { reviewedAt: now, referenceSha256: "review-digest-leak", humanOnly: true, contractVersion: "review-v1" } } }, providerMessageKey: "provider-proof-leak", providerResponseSha256: "response-digest-leak", leaseOwner: "worker-leak", leaseExpiresAt: now, attemptCount: 1, createdAt: now, updatedAt: now, version: 3 }],
      replyEligibility: { state: "unknown", checkedAt: now, reason: "provider_unavailable", contractVersion: "mock-v1" },
    } as unknown as PrivateConversationView;
    const result = privateConversationViewResponse(hostile);
    const serialized = JSON.stringify(result);
    for (const secret of ["provider-conversation-leak", "provider-participant-leak", "provider-message-leak", "provider-attachment-leak", "https://private-provider.example/image-secret.jpg", "body-integrity-leak", "raw-digest-leak", "reply-integrity-leak", "idempotency-leak", "review-digest-leak", "provider-proof-leak", "response-digest-leak", "worker-leak"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("lets a creator save a keyed draft but never returns its integrity or idempotency metadata", async () => {
    const infra = infrastructure();
    const repository = infra.privateConversationRepository as unknown as {
      saveReplyIntent: ReturnType<typeof vi.fn>;
    };
    const result = await service(infra).createReplyDraft(scope.workspaceId, scope.brandId, anchor.id, { body: "  Thanks for writing.  ", clientRequestId: "5b9abef7-b847-4244-b0c4-41260541757e" }, creator);
    expect(result).toMatchObject({ id: "private_reply_5b9abef7-b847-4244-b0c4-41260541757e", body: "Thanks for writing.", status: "draft", attemptCount: 0, version: 1 });
    expect(result).not.toHaveProperty("bodyIntegrityKey");
    expect(result).not.toHaveProperty("idempotencyKey");
    const saved = repository.saveReplyIntent.mock.calls[0]?.[0] as PrivateReplyIntent;
    const audit = repository.saveReplyIntent.mock.calls[0]?.[1] as { detail: Record<string, unknown> };
    expect(saved.bodyIntegrityKey).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.idempotencyKey).toContain(saved.bodyIntegrityKey);
    expect(saved.bodyIntegrityKey).not.toContain(saved.body);
    expect(audit.detail).not.toHaveProperty("bodyIntegrityKey");
  });

  it("revises an owned draft atomically and resets it to exact-text approval", async () => {
    const draft: PrivateReplyIntent = {
      id: "intent-revise", ...scope, conversationId: conversation.id, inReplyToMessageId: anchor.id, body: "Old reply", bodyIntegrityKey: "d".repeat(64), status: "draft", idempotencyKey: "private-reply-old", requestedBy: creator.id, attemptCount: 0, createdAt: now, updatedAt: now, version: 1,
    };
    const reviseReplyIntent = vi.fn(async (_scope, revised: PrivateReplyIntent, _event: { detail: Record<string, unknown> }) => revised);
    const infra = infrastructure({
      privateConversationRepository: {
        ...infrastructure().privateConversationRepository,
        getReplyIntent: vi.fn(async () => draft),
        getReplyApprovalContext: vi.fn(async () => ({ intent: draft, conversation, anchorMessage: anchor, externalConversationId: "approval-only-secret" })),
        reviseReplyIntent,
      } as PrivateConversationRepository,
    });
    const result = await service(infra).reviseReplyDraft(scope.workspaceId, scope.brandId, draft.id, { version: 1, body: "  New exact reply  " }, creator);
    expect(reviseReplyIntent).toHaveBeenCalledWith(scope, expect.objectContaining({ body: "New exact reply", status: "pending_approval", requestedBy: creator.id, version: 2 }), expect.anything());
    expect(reviseReplyIntent.mock.calls[0]?.[2]?.detail).not.toHaveProperty("bodyIntegrityKey");
    expect(result).toMatchObject({ body: "New exact reply", status: "pending_approval", version: 2 });
    expect(JSON.stringify(result)).not.toContain("approval-only-secret");
  });

  it("submits only the creator's current draft for manager approval", async () => {
    const draft: PrivateReplyIntent = {
      id: "intent-submit", ...scope, conversationId: conversation.id, inReplyToMessageId: anchor.id, body: "Draft reply", bodyIntegrityKey: "e".repeat(64), status: "draft", idempotencyKey: "private-reply-draft", requestedBy: creator.id, attemptCount: 0, createdAt: now, updatedAt: now, version: 1,
    };
    const transitionReplyIntent = vi.fn(async (_scope, command) => ({ ...draft, status: command.to, version: 2 }));
    const infra = infrastructure({ privateConversationRepository: { ...infrastructure().privateConversationRepository, getReplyIntent: vi.fn(async () => draft), transitionReplyIntent } as PrivateConversationRepository });
    const result = await service(infra).submitReplyDraft(scope.workspaceId, scope.brandId, draft.id, 1, creator);
    expect(transitionReplyIntent).toHaveBeenCalledWith(scope, expect.objectContaining({ expectedVersion: 1, to: "pending_approval", actorId: creator.id }), expect.anything());
    expect(result).toMatchObject({ status: "pending_approval", version: 2 });
  });

  it("requires a human manager or owner and a fresh connector eligibility result before queueing", async () => {
    const pending: PrivateReplyIntent = {
      id: "intent-approve", ...scope, conversationId: conversation.id, inReplyToMessageId: anchor.id, body: "Thanks", bodyIntegrityKey: "a".repeat(64), status: "pending_approval", idempotencyKey: "private-reply-1", requestedBy: creator.id, attemptCount: 0, createdAt: now, updatedAt: now, version: 1,
    };
    const queued = { ...pending, status: "queued" as const, approvedBy: owner.id, eligibilityAtApproval: view().replyEligibility, version: 2 };
    const transitionReplyIntent = vi.fn(async (_scope, command) => ({ ...queued, eligibilityAtApproval: command.eligibilityAtApproval }));
    const getReplyApprovalContext = vi.fn(async () => ({ intent: pending, conversation, anchorMessage: anchor, externalConversationId: "external-conversation-secret" }));
    const queueAdd = vi.fn(async () => ({ id: "job-1" }));
    const infra = infrastructure({
      privateConversationRepository: { ...infrastructure().privateConversationRepository, getReplyApprovalContext, transitionReplyIntent } as PrivateConversationRepository,
      connectedAccountRepository: { get: vi.fn(async () => ({ id: conversation.accountId, brandId: scope.brandId, platform: "instagram", capabilities: ["private_message_send"] })) } as never,
      privateConversationQueue: { add: queueAdd },
    });
    await expect(service(infra).approve(scope.workspaceId, scope.brandId, pending.id, 1, { ...owner, actorType: "agent" })).rejects.toBeInstanceOf(Error);
    const result = await service(infra).approve(scope.workspaceId, scope.brandId, pending.id, 1, owner);
    expect(transitionReplyIntent).toHaveBeenCalledWith(scope, expect.objectContaining({ to: "queued", approvedBy: owner.id, eligibilityAtApproval: expect.objectContaining({ state: "eligible", evidence: { mode: "standard", qualifyingEventAt: now, durationSeconds: 86_400 } }) }), expect.anything());
    expect(queueAdd).toHaveBeenCalledWith("execute-reply", expect.objectContaining({ name: "execute-reply", intentId: pending.id }), expect.objectContaining({ attempts: 1, jobId: `private-reply-${pending.id}` }));
    expect(JSON.stringify(result)).not.toContain("external-conversation-secret");
    expect(JSON.stringify(result)).not.toContain(pending.bodyIntegrityKey);
  });

  it("does not queue when the connector reports that the reply window is closed", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    const pending: PrivateReplyIntent = { id: "intent-closed", ...scope, conversationId: conversation.id, inReplyToMessageId: anchor.id, body: "Thanks", bodyIntegrityKey: "b".repeat(64), status: "pending_approval", idempotencyKey: "private-reply-closed", requestedBy: creator.id, attemptCount: 0, createdAt: now, updatedAt: now, version: 1 };
    const transitionReplyIntent = vi.fn();
    const queueAdd = vi.fn();
    const infra = infrastructure({
      privateConversationRepository: { ...infrastructure().privateConversationRepository, getReplyApprovalContext: vi.fn(async () => ({ intent: pending, conversation, anchorMessage: { ...anchor, providerCreatedAt: old, firstSeenAt: old }, externalConversationId: "external-conversation" })), transitionReplyIntent } as PrivateConversationRepository,
      connectedAccountRepository: { get: vi.fn(async () => ({ id: conversation.accountId, brandId: scope.brandId, platform: "instagram", capabilities: ["private_message_send"] })) } as never,
      privateConversationQueue: { add: queueAdd },
    });
    await expect(service(infra).approve(scope.workspaceId, scope.brandId, pending.id, 1, owner)).rejects.toMatchObject({ code: "private_reply_window_closed", statusCode: 409 });
    expect(transitionReplyIntent).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("does not accept client-supplied provider evidence during uncertain reconciliation", async () => {
    const uncertain: PrivateReplyIntent = { id: "intent-uncertain", ...scope, conversationId: conversation.id, inReplyToMessageId: anchor.id, body: "Thanks", bodyIntegrityKey: "c".repeat(64), status: "uncertain", idempotencyKey: "private-reply-uncertain", requestedBy: creator.id, attemptCount: 1, createdAt: now, updatedAt: now, version: 3 };
    const transitionReplyIntent = vi.fn();
    const infra = infrastructure({ privateConversationRepository: { ...infrastructure().privateConversationRepository, getReplyIntent: vi.fn(async () => uncertain), transitionReplyIntent } as PrivateConversationRepository });
    await expect(service(infra).reconcile(scope.workspaceId, scope.brandId, uncertain.id, { version: 3, outcome: "confirmed_sent", note: "Checked the live provider conversation." }, owner)).rejects.toMatchObject({ code: "private_reply_provider_evidence_required" });
    expect(transitionReplyIntent).not.toHaveBeenCalled();
  });

  it("lets a reader queue an account-scoped reconciliation only after capability verification", async () => {
    const syncState: PrivateConversationSyncState = { ...scope, accountId: conversation.accountId, platform: "instagram", connectionMode: "instagram_login", nextSyncAt: now, failureCount: 0, version: 1 };
    const queueAdd = vi.fn(async () => ({ id: "sync-job" }));
    const infra = infrastructure({
      privateConversationRepository: { ...infrastructure().privateConversationRepository, getSyncState: vi.fn(async () => syncState) } as PrivateConversationRepository,
      connectedAccountRepository: { get: vi.fn(async () => ({ id: conversation.accountId, brandId: scope.brandId, platform: "instagram", capabilities: ["private_message_read"] })) } as never,
      privateConversationQueue: { add: queueAdd },
    });
    const result = await service(infra).syncAccount(scope.workspaceId, scope.brandId, conversation.accountId, { id: "viewer-1", name: "Viewer", role: "viewer", actorType: "human" });
    expect(result).toEqual({ queued: true, accountId: conversation.accountId, connectionMode: "instagram_login" });
    expect(queueAdd).toHaveBeenCalledWith("sync-account", expect.objectContaining({ name: "sync-account", accountId: conversation.accountId, reason: "manual" }), expect.objectContaining({ attempts: 3 }));
  });

  it("keeps connection modes separate when selecting a connector", async () => {
    const registry = new ConnectorRegistry();
    registry.registerPrivateConversations(new MockPrivateConversationConnector({ connectionMode: "instagram_login" }));
    expect(() => registry.getPrivateConversations("instagram_linked_page")).toThrow("No private-message connector");
  });
});
