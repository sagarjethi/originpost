import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { startE2eApp } from "./test-app.js";

const everyDay = { monday: ["23:59"], tuesday: ["23:59"], wednesday: ["23:59"], thursday: ["23:59"], friday: ["23:59"], saturday: ["23:59"], sunday: ["23:59"] };

describe("account posting queues", () => {
  let app: NestFastifyApplication;
  let accountId = "";

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_MODE: "single-user",
      DATABASE_URL: "",
      REDIS_URL: "",
      BOOTSTRAP_USER_ID: "queue-owner",
      BOOTSTRAP_USER_NAME: "Queue Owner",
      REVIEW_LINK_SECRET: "posting-queue-review-secret-more-than-32-characters",
      MEDIA_DELIVERY_SECRET: "posting-queue-media-secret-more-than-32-characters",
      AUTOMATION_DELIVERY_ENABLED: "false",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    const account = await request(app.getHttpServer()).post("/v1/channels/accounts").send({
      workspaceId: "default",
      brandId: "brand_default",
      platform: "facebook",
      displayName: "Queue Page",
      externalAccountId: "queue-page-provider-id",
      capabilities: ["page_read", "media_publish"],
    }).expect(201);
    accountId = account.body.id as string;
  });

  afterAll(async () => { await app.close(); });

  async function approvedTextItem(title: string, draftCopy = `${title} caption`) {
    const created = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", brandId: "brand_default", title }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`).send({ kind: "url", title: "Source", url: `https://example.com/${encodeURIComponent(title)}`, rights: "reference-only", confidence: 95 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`).send({ platform: "facebook", format: "text", title: draftCopy, caption: draftCopy, mediaIds: [] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    return { id: created.body.id as string, draftId, version: approved.body.version as number };
  }

  it("saves, previews, atomically reserves, replays, and releases an account slot", async () => {
    const draftPreview = await request(app.getHttpServer()).post(`/v1/posting-queue-profiles/${accountId}/preview`).send({ workspaceId: "default", brandId: "brand_default", enabled: true, timezone: "UTC", weeklySlots: everyDay, expectedVersion: 0, count: 2 }).expect(201);
    expect(draftPreview.body.profile).toMatchObject({ connectedAccountId: accountId, version: 1 });
    expect(draftPreview.body.occurrences).toHaveLength(2);
    expect(draftPreview.body.occurrences[0]).toMatchObject({ localTime: "23:59", timezone: "UTC", profileVersion: 1 });
    const beforeSave = await request(app.getHttpServer()).get("/v1/posting-queue-profiles?workspaceId=default&brandId=brand_default").expect(200);
    expect(beforeSave.body.find((row: { account: { id: string } }) => row.account.id === accountId)?.profile).toBeNull();

    const saved = await request(app.getHttpServer()).put(`/v1/posting-queue-profiles/${accountId}`).send({ workspaceId: "default", brandId: "brand_default", enabled: true, timezone: "UTC", weeklySlots: everyDay, expectedVersion: 0 }).expect(200);
    expect(saved.body).toMatchObject({ connectedAccountId: accountId, enabled: true, timezone: "UTC", version: 1 });

    const preview = await request(app.getHttpServer()).get(`/v1/posting-queue-profiles/${accountId}/preview?workspaceId=default&brandId=brand_default&count=2`).expect(200);
    expect(preview.body.occurrences).toHaveLength(2);
    expect(preview.body.occurrences[0]).toMatchObject({ localTime: "23:59", timezone: "UTC", profileVersion: 1, occupied: false });

    const first = await approvedTextItem("Queue first");
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${first.id}/schedule-next`).set("If-Match", String(first.version)).set("Idempotency-Key", "posting-queue-command-1").send({ workspaceId: "default", brandId: "brand_default", draftId: first.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1 }).expect(201);
    expect(scheduled.body).toMatchObject({ replayed: false, target: { scheduledFor: preview.body.occurrences[0].scheduledFor, queueAssignment: { origin: "queue_assigned", profileVersion: 1, localTime: "23:59", timezone: "UTC" } } });

    const replay = await request(app.getHttpServer()).post(`/v1/content-items/${first.id}/schedule-next`).set("If-Match", String(first.version)).set("Idempotency-Key", "posting-queue-command-1").send({ workspaceId: "default", brandId: "brand_default", draftId: first.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1 }).expect(201);
    expect(replay.body).toMatchObject({ replayed: true, target: { id: scheduled.body.target.id } });

    await request(app.getHttpServer()).post(`/v1/content-items/${first.id}/targets/${scheduled.body.target.id}/cancel`).set("If-Match", String(scheduled.body.item.version)).send({ workspaceId: "default" }).expect(201);
    const afterRelease = await request(app.getHttpServer()).get(`/v1/posting-queue-profiles/${accountId}/preview?workspaceId=default&brandId=brand_default&count=1`).expect(200);
    expect(afterRelease.body.occurrences[0].scheduledFor).toBe(preview.body.occurrences[0].scheduledFor);

    const second = await approvedTextItem("Queue second");
    const rescheduled = await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule-next`).set("If-Match", String(second.version)).set("Idempotency-Key", "posting-queue-command-2").send({ workspaceId: "default", brandId: "brand_default", draftId: second.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1 }).expect(201);
    expect(rescheduled.body.target.scheduledFor).toBe(preview.body.occurrences[0].scheduledFor);
    const moved = await request(app.getHttpServer()).patch(`/v1/content-items/${second.id}/targets/${rescheduled.body.target.id}/reschedule`).set("If-Match", String(rescheduled.body.item.version)).send({ scheduledFor: "2099-09-01T12:00:00.000Z", timezone: "UTC" }).expect(200);
    const replacement = moved.body.targets.at(-1);
    expect(replacement).toMatchObject({ scheduledFor: "2099-09-01T12:00:00.000Z", timezone: "UTC" });
    expect(replacement).not.toHaveProperty("queueAssignment");
    const afterMove = await request(app.getHttpServer()).get(`/v1/posting-queue-profiles/${accountId}/preview?workspaceId=default&brandId=brand_default&count=1`).expect(200);
    expect(afterMove.body.occurrences[0].scheduledFor).toBe(preview.body.occurrences[0].scheduledFor);
  });

  it("rejects stale profiles and requires a durable idempotency key", async () => {
    const item = await approvedTextItem("Queue safeguards");
    await request(app.getHttpServer()).post(`/v1/content-items/${item.id}/schedule-next`).set("If-Match", String(item.version)).send({ workspaceId: "default", brandId: "brand_default", draftId: item.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1 }).expect(400);
    const stale = await request(app.getHttpServer()).post(`/v1/content-items/${item.id}/schedule-next`).set("If-Match", String(item.version)).set("Idempotency-Key", "posting-queue-stale").send({ workspaceId: "default", brandId: "brand_default", draftId: item.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 99 }).expect(409);
    expect(stale.body.error).toBe("posting_queue_version_conflict");
  });

  it("requires the current duplicate acknowledgement before allocating a queued copy", async () => {
    const first = await approvedTextItem("Queue duplicate first", "Exact queued campaign");
    await request(app.getHttpServer()).post(`/v1/content-items/${first.id}/schedule-next`).set("If-Match", String(first.version)).set("Idempotency-Key", "posting-queue-duplicate-first").send({ workspaceId: "default", brandId: "brand_default", draftId: first.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1 }).expect(201);
    const second = await approvedTextItem("Queue duplicate second", "Exact queued campaign");
    const preview = await request(app.getHttpServer()).get(`/v1/posting-queue-profiles/${accountId}/preview?workspaceId=default&brandId=brand_default&count=1`).expect(200);
    const conflict = await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule-preflight?workspaceId=default`).set("If-Match", String(second.version)).send({ platform: "facebook", accountId, draftId: second.draftId, scheduledFor: preview.body.occurrences[0].scheduledFor, timezone: "UTC", deliveryMode: "manual_handoff" }).expect(201);
    expect(conflict.body.conflicts[0]).toMatchObject({ contentItemId: first.id, kinds: expect.arrayContaining(["exact_content_duplicate"]) });
    await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule-next`).set("If-Match", String(second.version)).set("Idempotency-Key", "posting-queue-duplicate-second").send({ workspaceId: "default", brandId: "brand_default", draftId: second.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1 }).expect(409);
    await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule-next`).set("If-Match", String(second.version)).set("Idempotency-Key", "posting-queue-duplicate-second").send({ workspaceId: "default", brandId: "brand_default", draftId: second.draftId, connectedAccountId: accountId, deliveryMode: "manual_handoff", expectedProfileVersion: 1, conflictAcknowledgementSha256: conflict.body.acknowledgementSha256 }).expect(201);
  });
});
