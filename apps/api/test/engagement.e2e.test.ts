import "reflect-metadata";
import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { engagementBodySha256, type EngagementComment, type EngagementThread } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

describe("OriginPost engagement API", () => {
  let app: NestFastifyApplication;
  let infrastructure: OriginPostInfrastructure;
  const queueAdd = vi.fn(async () => ({ id: "queued" }));
  const queueClose = vi.fn(async () => undefined);
  const now = "2026-08-29T10:00:00.000Z";
  const thread: EngagementThread = {
    id: "engagement-thread-1", workspaceId: "default", brandId: "brand_default", contentItemId: "content-1", proofId: "proof-1",
    accountId: "engagement-account-1", platform: "instagram", externalMediaId: "media-1", state: "open", lastActivityAt: now, lastSyncedAt: now, version: 1,
  };
  const comment: EngagementComment = {
    id: "engagement-comment-1", workspaceId: "default", brandId: "brand_default", threadId: thread.id, accountId: thread.accountId,
    externalMediaId: thread.externalMediaId, externalCommentId: "comment-1", authorScopedId: "viewer-1", authorUsername: "reader",
    body: "Can you share the source?", bodySha256: engagementBodySha256("Can you share the source?"), direction: "incoming", visibility: "visible",
    providerCreatedAt: now, firstSeenAt: now, lastSeenAt: now, source: "reconcile",
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test", AUTH_MODE: "single-user", DATABASE_URL: "", REDIS_URL: "", BOOTSTRAP_USER_ID: "local-owner", BOOTSTRAP_USER_NAME: "Local Owner",
      REVIEW_LINK_SECRET: "test-review-link-secret-with-more-than-32-characters", MEDIA_DELIVERY_SECRET: "test-media-delivery-secret-with-more-than-32-characters",
      CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", META_APP_ID: "test-meta-app", META_APP_SECRET: "test-meta-secret",
      META_WEBHOOK_VERIFY_TOKEN: "test-webhook-verify-token", API_PUBLIC_URL: "http://localhost:4000", WEB_PUBLIC_URL: "http://localhost:3000",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }), { rawBody: true });
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    (infrastructure as unknown as { engagementQueue: { add: typeof queueAdd; close: typeof queueClose } }).engagementQueue = { add: queueAdd, close: queueClose };
    await infrastructure.connectedAccountRepository.save({
      id: thread.accountId, workspaceId: "default", brandId: "brand_default", platform: "instagram", displayName: "Editorial Instagram", externalAccountId: "provider-account-1",
      capabilities: ["profile_read", "media_publish", "comment_read", "comment_reply"], status: "healthy", createdBy: "local-owner", createdAt: now, updatedAt: now,
    }, { id: "audit-account", workspaceId: "default", actorId: "local-owner", actorType: "human", action: "channel.account-created", detail: {}, createdAt: now });
    await infrastructure.engagementRepository.ingest({ workspaceId: "default", brandId: "brand_default" }, { thread, comments: [comment], syncedAt: now }, { id: "audit-ingest", workspaceId: "default", contentItemId: thread.contentItemId, actorId: "originpost-worker", actorType: "system", action: "engagement.comments-reconciled", detail: {}, createdAt: now });
  });

  afterAll(async () => { await app.close(); });

  it("lists, opens, reads, resolves, drafts, and approves a proof-linked thread", async () => {
    const listed = await request(app.getHttpServer()).get("/v1/engagement?workspaceId=default&brandId=brand_default").expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ thread: { id: thread.id }, unreadCount: 1, needsReply: true });

    const opened = await request(app.getHttpServer()).get(`/v1/engagement/threads/${thread.id}?workspaceId=default&brandId=brand_default`).expect(200);
    expect(opened.body.comments[0]).toMatchObject({ id: comment.id, body: comment.body, authorUsername: "reader" });
    await request(app.getHttpServer()).post(`/v1/engagement/threads/${thread.id}/read?workspaceId=default&brandId=brand_default`).expect(200, { read: true, threadId: thread.id });

    const resolved = await request(app.getHttpServer()).patch(`/v1/engagement/threads/${thread.id}?workspaceId=default&brandId=brand_default`).send({ version: 1, state: "resolved" }).expect(200);
    expect(resolved).toHaveProperty("body.state", "resolved");

    const drafted = await request(app.getHttpServer()).post(`/v1/engagement/comments/${comment.id}/reply-drafts?workspaceId=default&brandId=brand_default`).send({ body: "Yes — the source link is in the post notes." }).expect(201);
    expect(drafted.body).toMatchObject({ status: "pending_approval", bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/), version: 1 });
    expect(JSON.stringify(drafted.body)).not.toContain("test-meta-secret");

    const approved = await request(app.getHttpServer()).post(`/v1/engagement/actions/${drafted.body.id}/approve?workspaceId=default&brandId=brand_default`).send({ version: 1 }).expect(202);
    expect(approved.body).toMatchObject({ status: "queued", approvedBy: "local-owner", version: 2 });
    expect(queueAdd).toHaveBeenCalledWith("execute-action", expect.objectContaining({ name: "execute-action", actionId: drafted.body.id }), expect.objectContaining({ attempts: 1, jobId: expect.not.stringContaining(":") }));
  });

  it("verifies signatures before accepting a bounded Meta webhook", async () => {
    await request(app.getHttpServer()).get("/v1/channels/webhooks/instagram?hub.mode=subscribe&hub.challenge=challenge-123&hub.verify_token=test-webhook-verify-token").expect(200, "challenge-123");
    const payload = JSON.stringify({ object: "instagram", entry: [{ id: "provider-account-1", time: 1788000000, changes: [{ field: "comments", value: { id: "provider-comment-2", text: "Useful update", from: { id: "reader-2", username: "reader_two" }, media: { id: "media-1" } } }] }] });
    await request(app.getHttpServer()).post("/v1/channels/webhooks/instagram").set("content-type", "application/json").set("x-hub-signature-256", "sha256=bad").send(payload).expect(403);
    const signature = `sha256=${createHmac("sha256", "test-meta-secret").update(payload).digest("hex")}`;
    const accepted = await request(app.getHttpServer()).post("/v1/channels/webhooks/instagram").set("content-type", "application/json").set("x-hub-signature-256", signature).send(payload).expect(200);
    expect(accepted.body).toEqual({ accepted: true, receipts: 1 });
    expect(queueAdd).toHaveBeenCalledWith("process-webhook-receipt", expect.objectContaining({ receiptId: expect.stringContaining("engagement_receipt_") }), expect.objectContaining({ jobId: expect.not.stringContaining(":") }));
  });

  it("does not expose another brand through an ID route", async () => {
    await request(app.getHttpServer()).get(`/v1/engagement/threads/${thread.id}?workspaceId=default&brandId=not-this-brand`).expect(404);
  });
});
