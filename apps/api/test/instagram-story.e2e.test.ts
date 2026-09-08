import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { MediaAsset } from "@originpost/domain";
import { InstagramOfficialConnector } from "@originpost/connectors";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp, withCurrentScheduleConflictAcknowledgement } from "./test-app.js";

describe("Instagram Story workflow", () => {
  let app: NestFastifyApplication;
  let infrastructure: OriginPostInfrastructure;
  let accountId: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_MODE: "single-user",
      DATABASE_URL: "",
      REDIS_URL: "",
      BOOTSTRAP_USER_ID: "story-owner",
      BOOTSTRAP_USER_NAME: "Story Owner",
      REVIEW_LINK_SECRET: "story-review-secret-with-more-than-32-characters",
      MEDIA_DELIVERY_SECRET: "story-media-secret-with-more-than-32-characters",
      AUTOMATION_DELIVERY_ENABLED: "false",
      INSTAGRAM_STORY_TEST_CREDENTIAL: "test-only",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    infrastructure = app.get(INFRASTRUCTURE);
    const account = await request(app.getHttpServer()).post("/v1/channels/accounts").send({
      workspaceId: "default",
      platform: "instagram",
      displayName: "Story Business",
      externalAccountId: "ig-story-business",
      credentialRef: "env:INSTAGRAM_STORY_TEST_CREDENTIAL",
      capabilities: ["profile_read", "media_publish"],
    }).expect(201);
    accountId = account.body.id;
  });

  afterAll(async () => { await app.close(); });

  async function readyStoryAsset(widthPixels = 1080, heightPixels = 1920, contentType = "image/jpeg"): Promise<MediaAsset> {
    const now = new Date().toISOString();
    const id = `story-media-${randomUUID()}`;
    const asset: MediaAsset = {
      id,
      workspaceId: "default",
      brandId: "brand_default",
      version: 1,
      kind: "image",
      purpose: "creative",
      fileName: `${id}.${contentType === "image/jpeg" ? "jpg" : "png"}`,
      contentType,
      sizeBytes: 100,
      sha256: randomUUID().replaceAll("-", "").repeat(2),
      objectKey: `qa/${id}`,
      status: "ready",
      inspectionStatus: "ready",
      detectedContentType: contentType,
      widthPixels,
      heightPixels,
      rights: "owned",
      createdBy: "story-owner",
      createdAt: now,
      uploadExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      readyAt: now,
    };
    await infrastructure.mediaRepository.save(asset, { id: `audit-${id}`, workspaceId: "default", actorId: "story-owner", actorType: "human", action: "test.story-media-ready", detail: { assetId: id }, createdAt: now });
    return asset;
  }

  async function approvedStory(media: MediaAsset) {
    const content = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", title: "Mumbai Story update" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/sources`).send({ kind: "url", title: "Official event source", url: "https://example.com/mumbai-event", rights: "reference-only", confidence: 100 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/drafts`).send({ platform: "instagram", format: "story", title: "Mumbai event", caption: "Internal review note only", mediaIds: [media.id] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    return { contentId: content.body.id as string, draftId, version: approved.body.version as number };
  }

  it("schedules one inspected rights-cleared 9:16 image as a basic Story", async () => {
    const item = await approvedStory(await readyStoryAsset());
    const scheduleBody = {
      platform: "instagram",
      accountId,
      draftId: item.draftId,
      scheduledFor: "2099-01-01T12:00:00.000Z",
      deliveryMode: "auto_publish",
    };
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${item.contentId}/schedule`).set("If-Match", String(item.version)).send(
      await withCurrentScheduleConflictAcknowledgement(app, item.contentId, scheduleBody, item.version),
    ).expect(201);
    expect(scheduled.body.targets.at(-1)).toMatchObject({ platform: "instagram", status: "queued", deliveryMode: "auto_publish" });
    expect(scheduled.body.drafts.find((draft: { id: string }) => draft.id === item.draftId)).toMatchObject({ format: "story", caption: "Internal review note only" });
  });

  it("rejects a non-9:16 Story before a publish target is created", async () => {
    const item = await approvedStory(await readyStoryAsset(1080, 1350));
    const response = await request(app.getHttpServer()).post(`/v1/content-items/${item.contentId}/schedule`).send({
      platform: "instagram",
      accountId,
      draftId: item.draftId,
      scheduledFor: "2099-01-01T12:00:00.000Z",
      deliveryMode: "auto_publish",
    }).expect(409);
    expect(response.body.message).toContain("9:16");
  });

  it("rejects a PNG Story image before a publish target is created", async () => {
    const item = await approvedStory(await readyStoryAsset(1080, 1920, "image/png"));
    const response = await request(app.getHttpServer()).post(`/v1/content-items/${item.contentId}/schedule`).send({
      platform: "instagram", accountId, draftId: item.draftId, scheduledFor: "2099-01-01T12:00:00.000Z", deliveryMode: "auto_publish",
    }).expect(409);
    expect(response.body.message).toContain("JPEG");
  });

  it("schedules a manual Story handoff without resolving Business auto-publish eligibility", async () => {
    const previous = infrastructure.connectors.get("instagram");
    infrastructure.connectors.register(new InstagramOfficialConnector({
      apiVersion: "v99.0",
      resolveCredential: async () => { throw new Error("No official credential is available"); },
    }));
    try {
      const item = await approvedStory(await readyStoryAsset());
      const scheduleBody = {
        platform: "instagram", accountId, draftId: item.draftId, scheduledFor: "2099-01-01T12:00:00.000Z", deliveryMode: "manual_handoff",
      };
      const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${item.contentId}/schedule`).set("If-Match", String(item.version)).send(
        await withCurrentScheduleConflictAcknowledgement(app, item.contentId, scheduleBody, item.version),
      ).expect(201);
      expect(scheduled.body.targets.at(-1)).toMatchObject({ deliveryMode: "manual_handoff", status: "queued" });
    } finally {
      infrastructure.connectors.register(previous);
    }
  });

  it("allows an internal Story review note beyond the provider caption limit", async () => {
    const media = await readyStoryAsset();
    const content = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", title: "Long Story review note" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/sources`).send({ kind: "url", title: "Official event source", url: "https://example.com/long-story-note", rights: "reference-only", confidence: 100 }).expect(201);
    const note = "Internal Story review note. ".repeat(100);
    expect(note.length).toBeGreaterThan(2200);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/drafts`).send({ platform: "instagram", format: "story", title: "Mumbai event", caption: note, mediaIds: [media.id] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    const scheduleBody = { platform: "instagram", accountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z", deliveryMode: "auto_publish" };
    await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/schedule`).set("If-Match", String(approved.body.version)).send(
      await withCurrentScheduleConflictAcknowledgement(app, content.body.id, scheduleBody, approved.body.version),
    ).expect(201);
  });
});
