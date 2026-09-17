import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureApp } from "../src/configure-app.js";
import { PrivateConversationsController } from "../src/private-conversations/private-conversations.controller.js";
import { PrivateConversationsService } from "../src/private-conversations/private-conversations.service.js";
import { startE2eApp } from "./test-app.js";

// These workflow assertions inspect calls made by earlier steps in this file.
// Vitest 5 clears mock history by default; retain it only for these fixtures.
vi.setConfig({ clearMocks: false });

describe("PrivateConversationsController", () => {
  let app: NestFastifyApplication;
  const service = {
    list: vi.fn(async () => ({ brandId: "brand-1", items: [] })),
    readiness: vi.fn(async () => ({ demo: true, state: "setup_required", canProvision: true, brandId: "brand-1", accounts: [] })),
    provisionDemoAccount: vi.fn(async () => ({ demo: true, state: "ready", queued: true, account: { accountId: "account-1", platform: "instagram", connectionMode: "instagram_linked_page" } })),
    get: vi.fn(async () => ({ conversation: { id: "conversation-1" }, participants: [], messages: [], replyIntents: [] })),
    update: vi.fn(async () => ({ id: "conversation-1", state: "resolved", version: 2 })),
    markRead: vi.fn(async () => ({ read: true, conversationId: "conversation-1" })),
    refreshConversation: vi.fn(async () => ({ queued: true, accountId: "account-1", connectionMode: "instagram_login" })),
    createReplyDraft: vi.fn(async () => ({ id: "intent-1", status: "draft", version: 1 })),
    reviseReplyDraft: vi.fn(async () => ({ id: "intent-1", status: "pending_approval", version: 2 })),
    submitReplyDraft: vi.fn(async () => ({ id: "intent-1", status: "pending_approval", version: 2 })),
    approve: vi.fn(async () => ({ id: "intent-1", status: "queued", version: 2 })),
    cancel: vi.fn(async () => ({ id: "intent-1", status: "cancelled", version: 2 })),
    reconcile: vi.fn(async () => ({ id: "intent-1", status: "failed", version: 4 })),
  };

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [PrivateConversationsController],
      providers: [
        ConfigService,
        { provide: PrivateConversationsService, useValue: service },
      ],
    }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
  });

  afterAll(async () => { await app.close(); });

  it("mounts the frozen v1 routes", async () => {
    await request(app.getHttpServer()).get("/v1/private-conversations?workspaceId=workspace-1&brandId=brand-1").expect(200, { brandId: "brand-1", items: [] });
    await request(app.getHttpServer()).get("/v1/private-conversations/readiness?workspaceId=workspace-1&brandId=brand-1").expect(200, { demo: true, state: "setup_required", canProvision: true, brandId: "brand-1", accounts: [] });
    await request(app.getHttpServer()).post("/v1/private-conversations/demo/accounts/account-1/provision?workspaceId=workspace-1&brandId=brand-1").send({ expectedAccountUpdatedAt: "2026-08-31T00:00:00.000Z" }).expect(202);
    await request(app.getHttpServer()).get("/v1/private-conversations/conversation-1?workspaceId=workspace-1&brandId=brand-1").expect(200);
    await request(app.getHttpServer()).patch("/v1/private-conversations/conversation-1?workspaceId=workspace-1&brandId=brand-1").send({ version: 1, state: "resolved" }).expect(200);
    await request(app.getHttpServer()).post("/v1/private-conversations/conversation-1/read?workspaceId=workspace-1&brandId=brand-1").expect(200, { read: true, conversationId: "conversation-1" });
    await request(app.getHttpServer()).post("/v1/private-conversations/conversation-1/refresh?workspaceId=workspace-1&brandId=brand-1").expect(202);
    await request(app.getHttpServer()).post("/v1/private-conversations/messages/message-1/reply-intents?workspaceId=workspace-1&brandId=brand-1").send({ body: "Thanks" }).expect(201);
    await request(app.getHttpServer()).patch("/v1/private-conversations/reply-intents/intent-1?workspaceId=workspace-1&brandId=brand-1").send({ version: 1, body: "Thanks again" }).expect(200);
    await request(app.getHttpServer()).post("/v1/private-conversations/reply-intents/intent-1/submit?workspaceId=workspace-1&brandId=brand-1").send({ version: 1 }).expect(200);
    await request(app.getHttpServer()).post("/v1/private-conversations/reply-intents/intent-1/approve?workspaceId=workspace-1&brandId=brand-1").send({ version: 1 }).expect(202);
    await request(app.getHttpServer()).post("/v1/private-conversations/reply-intents/intent-1/cancel?workspaceId=workspace-1&brandId=brand-1").send({ version: 1 }).expect(200);
    await request(app.getHttpServer()).post("/v1/private-conversations/reply-intents/intent-1/reconcile?workspaceId=workspace-1&brandId=brand-1").send({ version: 3, outcome: "confirmed_not_sent", note: "Checked the provider conversation." }).expect(200);
  });

  it("rejects unbounded or unknown client fields, including provider evidence", async () => {
    await request(app.getHttpServer()).get("/v1/private-conversations?limit=not-a-number").expect(400);
    await request(app.getHttpServer()).post("/v1/private-conversations/messages/message-1/reply-intents").send({ body: "Thanks", providerMessageId: "must-not-enter" }).expect(400);
    await request(app.getHttpServer()).post("/v1/private-conversations/reply-intents/intent-1/reconcile").send({ version: 3, outcome: "confirmed_sent", note: "Checked the provider conversation.", providerMessageId: "must-not-enter" }).expect(400);
    await request(app.getHttpServer()).post("/v1/private-conversations/demo/accounts/account-1/provision").send({ expectedAccountUpdatedAt: "not-a-date", connectionMode: "instagram_login" }).expect(400);
    expect(service.createReplyDraft).toHaveBeenCalledTimes(1);
    expect(service.reconcile).toHaveBeenCalledTimes(1);
  });

  it("passes only scoped validated values to the feature service", () => {
    expect(service.createReplyDraft).toHaveBeenCalledWith("workspace-1", "brand-1", "message-1", { body: "Thanks" }, expect.objectContaining({ role: "owner" }));
    expect(service.refreshConversation).toHaveBeenCalledWith("workspace-1", "brand-1", "conversation-1", expect.objectContaining({ role: "owner" }));
    expect(service.provisionDemoAccount).toHaveBeenCalledWith("workspace-1", "brand-1", "account-1", "2026-08-31T00:00:00.000Z", expect.objectContaining({ role: "owner" }));
  });
});
