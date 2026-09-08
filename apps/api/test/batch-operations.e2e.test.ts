import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { MediaAsset } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

describe("batch campaign and media operations", () => {
  let app: NestFastifyApplication; let infrastructure: OriginPostInfrastructure;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: "test", AUTH_MODE: "single-user", DATABASE_URL: "", REDIS_URL: "", BOOTSTRAP_USER_ID: "batch-owner", BOOTSTRAP_USER_NAME: "Batch Owner", REVIEW_LINK_SECRET: "batch-test-secret-with-more-than-32-characters", MEDIA_DELIVERY_SECRET: "batch-media-secret-with-more-than-32-characters", AUTOMATION_DELIVERY_ENABLED: "false" });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false })); configureApp(app, app.get(ConfigService)); await startE2eApp(app); infrastructure = app.get(INFRASTRUCTURE);
    const now = new Date().toISOString();
    await infrastructure.connectedAccountRepository.save({ id: "batch-instagram", workspaceId: "default", brandId: "brand_default", platform: "instagram", displayName: "Batch Instagram", externalAccountId: "provider-batch", capabilities: ["profile_read", "media_publish"], status: "healthy", createdBy: "batch-owner", createdAt: now, updatedAt: now }, { id: "audit-batch-account", workspaceId: "default", actorId: "batch-owner", actorType: "human", action: "test.account", detail: {}, createdAt: now });
    const asset: MediaAsset = { id: "media-batch-image", workspaceId: "default", brandId: "brand_default", version: 1, kind: "image", purpose: "creative", fileName: "campaign.png", contentType: "image/png", sizeBytes: 100, sha256: "a".repeat(64), objectKey: "test/campaign.png", status: "ready", inspectionStatus: "ready", detectedContentType: "image/png", widthPixels: 1080, heightPixels: 1350, inspectedAt: now, inspector: "test", rights: "owned", createdBy: "batch-owner", createdAt: now, uploadExpiresAt: "2099-01-01T00:00:00.000Z", readyAt: now };
    await infrastructure.mediaRepository.save(asset, { id: "audit-batch-media", workspaceId: "default", actorId: "batch-owner", actorType: "human", action: "test.media", detail: {}, createdAt: now });
    const storyAsset: MediaAsset = { ...asset, id: "media-batch-story", fileName: "campaign-story.jpg", contentType: "image/jpeg", detectedContentType: "image/jpeg", sha256: "b".repeat(64), objectKey: "test/campaign-story.jpg", widthPixels: 1080, heightPixels: 1920 };
    await infrastructure.mediaRepository.save(storyAsset, { id: "audit-batch-story-media", workspaceId: "default", actorId: "batch-owner", actorType: "human", action: "test.media", detail: {}, createdAt: now });
  });
  afterAll(async () => { await app.close(); });

  it("dry-runs, prepares, human-approves, schedules and keeps high-risk work individual", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const preview = await request(app.getHttpServer()).post("/v1/batch-operations/preview").send({ workspaceId: "default", brandId: "brand_default", name: "Mumbai launch batch", rows: [
      { externalRef: "launch-01", title: "Launch one", caption: "First launch caption", platform: "instagram", format: "image", mediaAssetIds: ["media-batch-image"], accountId: "batch-instagram", scheduledFor: future, timezone: "Asia/Kolkata", riskLevel: "low" },
      { externalRef: "launch-02", title: "Sensitive launch", caption: "Needs a separate decision", platform: "instagram", format: "image", mediaAssetIds: ["media-batch-image"], riskLevel: "sensitive" },
    ] }).expect(201);
    expect(preview.body.data).toMatchObject({ status: "ready", counts: { ready: 2, invalid: 0 } });
    expect(preview.body.data.rows[0].warnings).toContain("The same media bytes are used in another row. Check that this is intentional.");
    expect(preview.body.data.rows[1]).toMatchObject({ bulkApprovalEligible: false });
    const batchId = preview.body.data.id as string;

    const prepared = await request(app.getHttpServer()).post(`/v1/batch-operations/${batchId}/commit`).send({ workspaceId: "default", version: preview.body.data.version }).expect(202);
    expect(prepared.body.data.rows.map((row: { status: string }) => row.status)).toEqual(["review_ready", "individual_review"]);
    const firstContentId = prepared.body.data.rows[0].contentItemId as string;
    const firstItem = await request(app.getHttpServer()).get(`/v1/content-items/${firstContentId}?workspaceId=default`).expect(200);
    expect(firstItem.body).toMatchObject({ status: "review", drafts: [expect.objectContaining({ platform: "instagram", mediaIds: ["media-batch-image"] })] });

    const approved = await request(app.getHttpServer()).post(`/v1/batch-operations/${batchId}/approve`).send({ workspaceId: "default", version: prepared.body.data.version, rowNumbers: [1, 2], confirmation: "APPROVE 2" }).expect(202);
    expect(approved.body.data.rows.map((row: { status: string }) => row.status), JSON.stringify(approved.body.data.rows[0])).toEqual(["scheduled", "individual_review"]);
    const scheduledItem = await request(app.getHttpServer()).get(`/v1/content-items/${firstContentId}?workspaceId=default`).expect(200);
    expect(scheduledItem.body).toMatchObject({ status: "scheduled", approvals: [expect.objectContaining({ decision: "approved", actorId: "batch-owner" })], targets: [expect.objectContaining({ accountId: "batch-instagram", scheduledFor: future })] });
    await request(app.getHttpServer()).post(`/v1/batch-operations/${batchId}/approve`).send({ workspaceId: "default", version: prepared.body.data.version, rowNumbers: [1], confirmation: "APPROVE 1" }).expect(409);
  });

  it("marks exact duplicate rows invalid and creates nothing", async () => {
    const row = { externalRef: "duplicate", title: "Duplicate", caption: "Duplicate caption", platform: "instagram", format: "image", mediaAssetIds: ["media-batch-image"] };
    const preview = await request(app.getHttpServer()).post("/v1/batch-operations/preview").send({ workspaceId: "default", brandId: "brand_default", name: "Duplicate check", rows: [row, row] }).expect(201);
    expect(preview.body.data.rows.every((entry: { status: string }) => entry.status === "invalid")).toBe(true);
    const committed = await request(app.getHttpServer()).post(`/v1/batch-operations/${preview.body.data.id}/commit`).send({ workspaceId: "default", version: preview.body.data.version }).expect(202);
    expect(committed.body.data.counts.invalid).toBe(2);
  });

  it("dry-runs and prepares an Instagram Story row", async () => {
    const preview = await request(app.getHttpServer()).post("/v1/batch-operations/preview").send({ workspaceId: "default", brandId: "brand_default", name: "Story campaign", rows: [
      { externalRef: "story-01", title: "Mumbai Story", caption: "Internal Story review note", platform: "instagram", format: "story", mediaAssetIds: ["media-batch-story"] },
    ] }).expect(201);
    expect(preview.body.data.rows[0]).toMatchObject({ status: "ready", format: "story" });
    const prepared = await request(app.getHttpServer()).post(`/v1/batch-operations/${preview.body.data.id}/commit`).send({ workspaceId: "default", version: preview.body.data.version }).expect(202);
    expect(prepared.body.data.rows[0]).toMatchObject({ status: "review_ready" });
    const item = await request(app.getHttpServer()).get(`/v1/content-items/${prepared.body.data.rows[0].contentItemId}?workspaceId=default`).expect(200);
    expect(item.body.drafts[0]).toMatchObject({ platform: "instagram", format: "story", mediaIds: ["media-batch-story"] });
  });

  it("returns row-level validation and safely resumes only a stale processing plan", async () => {
    const invalid = await request(app.getHttpServer()).post("/v1/batch-operations/preview").send({ workspaceId: "default", brandId: "brand_default", name: "Row validation", rows: [
      { externalRef: "", title: "", caption: "", platform: "instagram", format: "image", mediaAssetIds: [] },
    ] }).expect(201);
    expect(invalid.body.data.rows[0]).toMatchObject({ status: "invalid", errors: expect.arrayContaining(["externalRef is required.", "title must contain 1–180 characters.", "caption must contain 1–10,000 characters."]) });

    const preview = await request(app.getHttpServer()).post("/v1/batch-operations/preview").send({ workspaceId: "default", brandId: "brand_default", name: "Crash recovery", rows: [
      { externalRef: "recover-01", title: "Recover me", caption: "Recovery caption", platform: "instagram", format: "image", mediaAssetIds: ["media-batch-image"] },
    ] }).expect(201);
    const plan = await infrastructure.batchPlanRepository.get("default", preview.body.data.id as string);
    expect(plan).not.toBeNull();
    const active = { ...plan!, version: plan!.version + 1, status: "processing" as const, updatedAt: new Date().toISOString() };
    const activeSaved = await infrastructure.batchPlanRepository.replace("default", plan!.id, plan!.version, active, { id: "audit-batch-active", workspaceId: "default", actorId: "batch-owner", actorType: "human", action: "test.processing", detail: {}, createdAt: active.updatedAt });
    expect(activeSaved).not.toBeNull();
    const blocked = await request(app.getHttpServer()).post(`/v1/batch-operations/${plan!.id}/commit`).send({ workspaceId: "default", version: active.version }).expect(409);
    expect(blocked.body.message).toContain("still running");

    const staleAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const stale = { ...active, version: active.version + 1, updatedAt: staleAt };
    const staleSaved = await infrastructure.batchPlanRepository.replace("default", plan!.id, active.version, stale, { id: "audit-batch-stale", workspaceId: "default", actorId: "batch-owner", actorType: "human", action: "test.stale", detail: {}, createdAt: staleAt });
    expect(staleSaved).not.toBeNull();
    const recovered = await request(app.getHttpServer()).post(`/v1/batch-operations/${plan!.id}/commit`).send({ workspaceId: "default", version: stale.version }).expect(202);
    expect(recovered.body.data).toMatchObject({ status: "review_ready", rows: [expect.objectContaining({ status: "review_ready" })] });
  });
});
