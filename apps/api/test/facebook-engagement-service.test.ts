import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import type { Actor, EngagementAction, EngagementThreadView } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { EngagementService } from "../src/engagement/engagement.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

describe("Facebook Page reply release gate", () => {
  it("places provider health on the thread object consumed by the inbox", async () => {
    const view = {
      thread: { id: "thread-health", workspaceId: "workspace-1", brandId: "brand-1", contentItemId: "content-1", proofId: "proof-1", accountId: "account-1", platform: "facebook", externalMediaId: "post-1", state: "open", lastActivityAt: "2026-08-29T10:00:00.000Z", lastSyncedAt: new Date().toISOString(), version: 1 },
      comments: [], actions: [],
    } as EngagementThreadView;
    const infrastructure = {
      organizationRepository: { listBrands: vi.fn(async () => [{ id: "brand-1" }]) },
      engagementRepository: { getThread: vi.fn(async () => view) },
      connectedAccountRepository: { get: vi.fn(async () => ({ capabilities: ["comment_read"] })) },
      connectors: { getEngagement: vi.fn(() => ({ manifest: { apiMode: "official" } })) },
    } as unknown as OriginPostInfrastructure;
    const service = new EngagementService(infrastructure, new ConfigService({ FACEBOOK_CONNECTOR_MODE: "official", META_GRAPH_API_VERSION: "v26.0" }));

    await expect(service.get("workspace-1", "brand-1", view.thread.id, { id: "viewer-1", role: "viewer" } as Actor)).resolves.toMatchObject({
      thread: { replySupported: false, subscriptionStatus: "active", reconciliationStatus: "current" },
    });
  });

  it("does not create a second reply while an earlier reply is in an ambiguous state", async () => {
    const uncertain: EngagementAction = {
      id: "action-uncertain", workspaceId: "workspace-1", brandId: "brand-1", threadId: "thread-1", commentId: "comment-1",
      type: "reply", body: "Earlier reply", bodySha256: "c".repeat(64), status: "uncertain", idempotencyKey: "reply-uncertain",
      requestedBy: "creator-1", createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:01:00.000Z", version: 3,
    };
    const view: EngagementThreadView = {
      thread: {
        id: "thread-1", workspaceId: "workspace-1", brandId: "brand-1", contentItemId: "content-1", proofId: "proof-1",
        accountId: "account-1", platform: "facebook", externalMediaId: "post-1", state: "open", lastActivityAt: "2026-08-29T10:00:00.000Z", version: 1,
      },
      comments: [], actions: [uncertain],
    };
    const saveAction = vi.fn();
    const infrastructure = {
      organizationRepository: { listBrands: vi.fn(async () => [{ id: "brand-1" }]) },
      engagementRepository: {
        getComment: vi.fn(async () => ({ id: "comment-1", threadId: "thread-1", direction: "incoming", visibility: "visible" })),
        getThread: vi.fn(async () => view),
        saveAction,
      },
    } as unknown as OriginPostInfrastructure;
    const service = new EngagementService(infrastructure, new ConfigService());

    await expect(service.createReplyDraft("workspace-1", "brand-1", "comment-1", { body: "New reply" }, { id: "creator-1", role: "creator" } as Actor))
      .rejects.toMatchObject({ code: "engagement_reply_in_flight", statusCode: 409 });
    expect(saveAction).not.toHaveBeenCalled();
  });

  it("keeps an official Facebook reply out of the queue until the pinned contract probe is recorded", async () => {
    const action: EngagementAction = {
      id: "action-1", workspaceId: "workspace-1", brandId: "brand-1", threadId: "thread-1", commentId: "comment-1",
      type: "reply", body: "Thanks", bodySha256: "a".repeat(64), status: "pending_approval", idempotencyKey: "reply-1",
      requestedBy: "creator-1", createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", version: 1,
    };
    const view: EngagementThreadView = {
      thread: {
        id: "thread-1", workspaceId: "workspace-1", brandId: "brand-1", contentItemId: "content-1", proofId: "proof-1",
        accountId: "account-1", platform: "facebook", externalMediaId: "post-1", state: "open", lastActivityAt: "2026-08-29T10:00:00.000Z", version: 1,
      },
      comments: [],
      actions: [action],
    };
    const queueAdd = vi.fn();
    const transitionAction = vi.fn();
    const infrastructure = {
      organizationRepository: { listBrands: vi.fn(async () => [{ id: "brand-1" }]) },
      engagementRepository: {
        getAction: vi.fn(async () => action),
        getThread: vi.fn(async () => view),
        transitionAction,
      },
      engagementQueue: { add: queueAdd },
      connectors: { getEngagement: vi.fn(() => ({ manifest: { apiMode: "official" } })) },
    } as unknown as OriginPostInfrastructure;
    const service = new EngagementService(infrastructure, new ConfigService({
      FACEBOOK_CONNECTOR_MODE: "official",
      META_GRAPH_API_VERSION: "v26.0",
    }));
    const actor = { id: "owner-1", role: "owner" } as Actor;

    await expect(service.approve("workspace-1", "brand-1", "action-1", 1, actor)).rejects.toMatchObject({ code: "facebook_reply_contract_unverified", statusCode: 409 });
    expect(transitionAction).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("allows the safe mock Facebook connector to complete the approval queue path", async () => {
    const action: EngagementAction = {
      id: "action-mock", workspaceId: "workspace-1", brandId: "brand-1", threadId: "thread-mock", commentId: "comment-mock",
      type: "reply", body: "Thanks", bodySha256: "b".repeat(64), status: "pending_approval", idempotencyKey: "reply-mock",
      requestedBy: "creator-1", createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", version: 1,
    };
    const view: EngagementThreadView = {
      thread: {
        id: "thread-mock", workspaceId: "workspace-1", brandId: "brand-1", contentItemId: "content-1", proofId: "proof-1",
        accountId: "account-1", platform: "facebook", externalMediaId: "post-1", state: "open", lastActivityAt: "2026-08-29T10:00:00.000Z", version: 1,
      },
      comments: [], actions: [action],
    };
    const queued = { ...action, status: "queued" as const, approvedBy: "owner-1", version: 2 };
    const queueAdd = vi.fn(async () => ({ id: "job-1" }));
    const transitionAction = vi.fn(async () => queued);
    const infrastructure = {
      organizationRepository: { listBrands: vi.fn(async () => [{ id: "brand-1" }]) },
      engagementRepository: { getAction: vi.fn(async () => action), getThread: vi.fn(async () => view), transitionAction },
      connectedAccountRepository: { get: vi.fn(async () => ({ capabilities: ["comment_reply"] })) },
      engagementQueue: { add: queueAdd },
      connectors: { getEngagement: vi.fn(() => ({ manifest: { apiMode: "mock" } })) },
    } as unknown as OriginPostInfrastructure;
    const service = new EngagementService(infrastructure, new ConfigService({ FACEBOOK_CONNECTOR_MODE: "mock" }));
    const actor = { id: "owner-1", role: "owner" } as Actor;

    await expect(service.approve("workspace-1", "brand-1", action.id, 1, actor)).resolves.toEqual(queued);
    expect(transitionAction).toHaveBeenCalledOnce();
    expect(queueAdd).toHaveBeenCalledWith("execute-action", expect.objectContaining({ actionId: action.id }), expect.objectContaining({ attempts: 1 }));
  });

  it("lets creators cancel only their own unsent drafts", async () => {
    const action = {
      id: "action-owned", workspaceId: "workspace-1", brandId: "brand-1", threadId: "thread-1", commentId: "comment-1", type: "reply", body: "Reply",
      bodySha256: "d".repeat(64), status: "pending_approval", idempotencyKey: "reply-owned", requestedBy: "creator-1",
      createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", version: 1,
    } as EngagementAction;
    const transitionAction = vi.fn();
    const infrastructure = {
      organizationRepository: { listBrands: vi.fn(async () => [{ id: "brand-1" }]) },
      engagementRepository: { getAction: vi.fn(async () => action), transitionAction },
    } as unknown as OriginPostInfrastructure;
    const service = new EngagementService(infrastructure, new ConfigService());

    await expect(service.cancel("workspace-1", "brand-1", action.id, 1, { id: "creator-2", role: "creator" } as Actor)).rejects.toBeInstanceOf(Error);
    expect(transitionAction).not.toHaveBeenCalled();
  });

  it("requires a manager and provider reply ID to reconcile an uncertain reply as sent", async () => {
    const action = {
      id: "action-uncertain-2", workspaceId: "workspace-1", brandId: "brand-1", threadId: "thread-1", commentId: "comment-1", type: "reply", body: "Reply",
      bodySha256: "e".repeat(64), status: "uncertain", idempotencyKey: "reply-uncertain-2", requestedBy: "creator-1",
      createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", version: 3,
    } as EngagementAction;
    const transitionAction = vi.fn(async (_scope, command) => ({ ...action, status: command.to, providerReplyId: command.providerReplyId, version: 4 }));
    const infrastructure = {
      organizationRepository: { listBrands: vi.fn(async () => [{ id: "brand-1" }]) },
      engagementRepository: { getAction: vi.fn(async () => action), transitionAction },
    } as unknown as OriginPostInfrastructure;
    const service = new EngagementService(infrastructure, new ConfigService());
    const owner = { id: "owner-1", role: "owner" } as Actor;

    await expect(service.reconcileAction("workspace-1", "brand-1", action.id, { version: 3, outcome: "confirmed_sent" }, owner)).rejects.toMatchObject({ code: "engagement_provider_reply_id_required" });
    await expect(service.reconcileAction("workspace-1", "brand-1", action.id, { version: 3, outcome: "confirmed_sent", providerReplyId: "provider-reply-1" }, owner)).resolves.toMatchObject({ status: "succeeded", providerReplyId: "provider-reply-1" });
  });
});
