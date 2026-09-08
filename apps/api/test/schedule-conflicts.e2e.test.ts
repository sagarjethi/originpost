import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { startE2eApp } from "./test-app.js";

describe("calendar-wide scheduling conflict preflight", () => {
  let app: NestFastifyApplication;
  let accountId = "";

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_MODE: "single-user",
      DATABASE_URL: "",
      REDIS_URL: "",
      BOOTSTRAP_USER_ID: "conflict-owner",
      BOOTSTRAP_USER_NAME: "Conflict Owner",
      REVIEW_LINK_SECRET: "schedule-conflict-review-secret-more-than-32-characters",
      MEDIA_DELIVERY_SECRET: "schedule-conflict-media-secret-more-than-32-characters",
      AUTOMATION_DELIVERY_ENABLED: "false",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    const account = await request(app.getHttpServer()).post("/v1/channels/accounts").send({ workspaceId: "default", brandId: "brand_default", platform: "facebook", displayName: "Conflict Page", externalAccountId: "conflict-page", capabilities: ["page_read", "media_publish"] }).expect(201);
    accountId = account.body.id as string;
  });

  afterAll(async () => { await app.close(); });

  async function approvedItem(itemTitle: string) {
    const created = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", brandId: "brand_default", title: itemTitle }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`).send({ kind: "url", title: "Source", url: `https://example.com/${encodeURIComponent(itemTitle)}`, rights: "reference-only", confidence: 95 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`).send({ platform: "facebook", format: "text", title: "Exact campaign copy", caption: "One approved caption", mediaIds: [] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    return { id: created.body.id as string, draftId, version: approved.body.version as number };
  }

  it("warns, binds explicit acknowledgement, and rechecks reschedules", async () => {
    const first = await approvedItem("Conflict first");
    const second = await approvedItem("Conflict second");
    const firstTime = "2099-09-01T12:00:00.000Z";
    const secondTime = "2099-09-01T12:30:00.000Z";
    const firstScheduled = await request(app.getHttpServer()).post(`/v1/content-items/${first.id}/schedule?workspaceId=default`).set("If-Match", String(first.version)).send({ platform: "facebook", accountId, draftId: first.draftId, scheduledFor: firstTime, timezone: "UTC", deliveryMode: "manual_handoff" }).expect(201);

    const preflight = await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule-preflight?workspaceId=default`).set("If-Match", String(second.version)).send({ platform: "facebook", accountId, draftId: second.draftId, scheduledFor: secondTime, timezone: "UTC", deliveryMode: "manual_handoff" }).expect(201);
    expect(preflight.body).toMatchObject({ requiresConfirmation: true, windowMinutes: 60, conflicts: [{ contentItemId: first.id, kinds: ["exact_content_duplicate", "account_time_overlap"], minutesApart: 30 }] });
    expect(preflight.body.acknowledgementSha256).toMatch(/^[0-9a-f]{64}$/);

    const blocked = await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule?workspaceId=default`).set("If-Match", String(second.version)).send({ platform: "facebook", accountId, draftId: second.draftId, scheduledFor: secondTime, timezone: "UTC", deliveryMode: "manual_handoff" }).expect(409);
    expect(blocked.body.error).toBe("schedule_conflict_confirmation_required");
    const secondScheduled = await request(app.getHttpServer()).post(`/v1/content-items/${second.id}/schedule?workspaceId=default`).set("If-Match", String(second.version)).send({ platform: "facebook", accountId, draftId: second.draftId, scheduledFor: secondTime, timezone: "UTC", deliveryMode: "manual_handoff", conflictAcknowledgementSha256: preflight.body.acknowledgementSha256 }).expect(201);

    const replacementTime = "2099-09-01T12:45:00.000Z";
    const reschedulePreflight = await request(app.getHttpServer()).post(`/v1/content-items/${first.id}/schedule-preflight?workspaceId=default`).set("If-Match", String(firstScheduled.body.version)).send({ platform: "facebook", accountId, draftId: first.draftId, scheduledFor: replacementTime, timezone: "UTC", deliveryMode: "manual_handoff", excludeTargetId: firstScheduled.body.targets[0].id }).expect(201);
    expect(reschedulePreflight.body.conflicts).toEqual([expect.objectContaining({ contentItemId: second.id, targetId: secondScheduled.body.targets[0].id, minutesApart: 15 })]);
    await request(app.getHttpServer()).patch(`/v1/content-items/${first.id}/targets/${firstScheduled.body.targets[0].id}/reschedule?workspaceId=default`).set("If-Match", String(firstScheduled.body.version)).send({ scheduledFor: replacementTime, timezone: "UTC" }).expect(409);
    const moved = await request(app.getHttpServer()).patch(`/v1/content-items/${first.id}/targets/${firstScheduled.body.targets[0].id}/reschedule?workspaceId=default`).set("If-Match", String(firstScheduled.body.version)).send({ scheduledFor: replacementTime, timezone: "UTC", conflictAcknowledgementSha256: reschedulePreflight.body.acknowledgementSha256 }).expect(200);
    expect(moved.body.targets.at(-1).scheduledFor).toBe(replacementTime);
  });
});
