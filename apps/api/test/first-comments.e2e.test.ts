import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { transitionFirstComment, type ContentItem, type PublishProof } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

const now = "2026-09-01T09:00:00.000Z";

function item(): ContentItem {
  return {
    id: "first-comment-content", workspaceId: "default", brandId: "brand_default", version: 1, title: "Mumbai event", summary: "", status: "scheduled", riskLevel: "low", sources: [], claims: [], tags: [],
    drafts: [{ id: "first-comment-draft", revision: 1, platform: "instagram", format: "image", title: "Mumbai event", caption: "Event update", mediaIds: [], contentSha256: "a".repeat(64), createdBy: "first-comment-owner", createdAt: now }],
    approvals: [{ id: "first-comment-draft-approval", draftId: "first-comment-draft", draftSha256: "a".repeat(64), decision: "approved", actorId: "first-comment-owner", actorName: "Owner", actorType: "human", note: "", createdAt: now }],
    reviewComments: [], reviewLinks: [], targets: [{ id: "first-comment-target", platform: "instagram", accountId: "first-comment-account", draftId: "first-comment-draft", scheduledFor: "2099-01-01T10:00:00.000Z", deliveryMode: "auto_publish", status: "queued" }],
    publishAttempts: [], proofs: [], researchRuns: [], createdBy: "first-comment-owner", createdAt: now, updatedAt: now,
  };
}

describe("governed first-comment routes", () => {
  let app: NestFastifyApplication;
  let infrastructure: OriginPostInfrastructure;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test", AUTH_MODE: "single-user", DATABASE_URL: "", REDIS_URL: "",
      BOOTSTRAP_USER_ID: "first-comment-owner", BOOTSTRAP_USER_NAME: "First Comment Owner",
      REVIEW_LINK_SECRET: "first-comment-review-secret-with-more-than-32-characters",
      MEDIA_DELIVERY_SECRET: "first-comment-media-secret-with-more-than-32-characters",
      AUTOMATION_DELIVERY_ENABLED: "false",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    infrastructure = app.get(INFRASTRUCTURE);
    await infrastructure.connectedAccountRepository.save({ id: "first-comment-account", workspaceId: "default", brandId: "brand_default", platform: "instagram", displayName: "@mumbai", externalAccountId: "ig-mumbai", capabilities: ["profile_read", "media_publish", "comment_read", "comment_reply"], status: "healthy", createdBy: "first-comment-owner", createdAt: now, updatedAt: now }, { id: "audit-first-comment-account", workspaceId: "default", actorId: "first-comment-owner", actorType: "human", action: "test.account-created", detail: {}, createdAt: now });
    const content = item();
    await infrastructure.repository.commit(content, { id: "audit-first-comment-content", workspaceId: "default", contentItemId: content.id, actorId: "first-comment-owner", actorType: "human", action: "test.content-created", detail: {}, createdAt: now });
  });

  afterAll(async () => { await app.close(); });

  it("creates, separately approves, and waits for exact publication proof", async () => {
    await request(app.getHttpServer()).get("/v1/content-items/first-comment-content/first-comments/capability").query({ workspaceId: "default", targetId: "first-comment-target" }).expect(200).expect(({ body }) => {
      expect(body.data.capability).toMatchObject({ state: "supported", platform: "instagram" });
    });
    const created = await request(app.getHttpServer()).post("/v1/content-items/first-comment-content/first-comments").send({ workspaceId: "default", targetId: "first-comment-target", body: "Read the full report: https://example.com" }).expect(201);
    const intentId = created.body.data.intent.id as string;
    const submitted = await request(app.getHttpServer()).post(`/v1/content-items/first-comment-content/first-comments/${intentId}/submit`).send({ workspaceId: "default", expectedVersion: created.body.data.intent.version }).expect(201);
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/first-comment-content/first-comments/${intentId}/approve`).send({ workspaceId: "default", expectedVersion: submitted.body.data.intent.version, singleOwnerOverride: true, secondConfirmation: true }).expect(202);
    expect(approved.body).toMatchObject({ data: { intent: { status: "approved", executionMode: "write" } }, meta: { accepted: true, waitingForPublication: true } });
  });

  it("queues read-only inspection separately from a human-confirmed new write", async () => {
    const records = await infrastructure.firstCommentRepository.list("default", "first-comment-content");
    const current = records[0]!.intent;
    const proof: PublishProof = { id: "first-comment-post-proof", contentItemId: "first-comment-content", draftId: current.draftId, draftSha256: current.draftSha256, platform: "instagram", accountId: current.accountId, externalPostId: "ig-post-1", liveUrl: "https://www.instagram.com/p/example/", publishedAt: "2026-09-01T10:00:00.000Z", captionSha256: "b".repeat(64), mediaSha256: [], connectorResponseSha256: "c".repeat(64), approvedBy: "first-comment-owner", sourceIds: [], disclosure: "none" };
    const proofBound = { ...current, status: "processing" as const, publishProofId: proof.id, externalPostId: proof.externalPostId };
    const uncertain = transitionFirstComment(proofBound, "uncertain", "2026-09-01T10:01:00.000Z", "Provider result unknown");
    await infrastructure.firstCommentRepository.compareAndSet(uncertain, current.version, ["approved"], { id: "audit-first-comment-uncertain", workspaceId: "default", contentItemId: current.contentItemId, actorId: "originpost-worker", actorType: "system", action: "test.first-comment-uncertain", detail: {}, createdAt: uncertain.updatedAt });
    const response = await request(app.getHttpServer()).post(`/v1/content-items/first-comment-content/first-comments/${current.id}/reconcile`).send({ workspaceId: "default", expectedVersion: uncertain.version, outcome: "inspect_provider" }).expect(202);
    expect(response.body).toMatchObject({ data: { intent: { status: "queued", executionMode: "reconcile" } }, meta: { providerWriteMayRetry: false, readOnlyInspection: true } });
  });

  it("rejects client-supplied provider identifiers and digests", async () => {
    await request(app.getHttpServer()).post("/v1/content-items/first-comment-content/first-comments").send({ workspaceId: "default", targetId: "first-comment-target", body: "Another comment", providerCommentId: "forged", providerResponseSha256: "f".repeat(64) }).expect(400);
  });
});
