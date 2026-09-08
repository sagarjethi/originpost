import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { createContentItem, type Actor, type ContentItem } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

describe("proof-backed analytics client reports", () => {
  let app: NestFastifyApplication;
  let infrastructure: OriginPostInfrastructure;
  const actor: Actor = { id: "local-owner", name: "Local Owner", role: "owner", actorType: "human" };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "single-user";
    process.env.DATABASE_URL = "";
    process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = actor.id;
    process.env.BOOTSTRAP_USER_NAME = actor.name;
    process.env.REVIEW_LINK_SECRET = "analytics-report-test-secret-more-than-32-characters";
    process.env.WEB_PUBLIC_URL = "http://localhost:3000";
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);

    const createdAt = "2026-08-15T10:00:00.000Z";
    await infrastructure.connectedAccountRepository.save({
      id: "report-instagram", workspaceId: "default", brandId: "brand_default", platform: "instagram", displayName: "Client Instagram",
      externalAccountId: "provider-account", capabilities: ["profile_read"], status: "healthy", createdBy: actor.id, createdAt, updatedAt: createdAt,
    }, { id: "audit-report-account", workspaceId: "default", actorId: actor.id, actorType: "human", action: "test.account", detail: {}, createdAt });
    const created = createContentItem({ contentId: "content-report-fixture", workspaceId: "default", brandId: "brand_default", title: "Campaign launch, verified", actor, now: createdAt });
    const item: ContentItem = {
      ...created.item,
      status: "published",
      proofs: [{
        id: "proof-report-fixture", contentItemId: created.item.id, draftId: "draft-report", draftSha256: "d".repeat(64), platform: "instagram",
        accountId: "report-instagram", externalPostId: "provider-post", liveUrl: "https://www.instagram.com/p/provider-post/", publishedAt: createdAt,
        captionSha256: "c".repeat(64), mediaSha256: ["m".repeat(64)], connectorResponseSha256: "r".repeat(64), approvedBy: actor.id, sourceIds: [], disclosure: "none",
      }],
    };
    await infrastructure.repository.commit(item, created.event);
    await infrastructure.analyticsRepository.save({
      id: "provider-snapshot-report", workspaceId: "default", brandId: "brand_default", contentItemId: item.id, proofId: "proof-report-fixture",
      platform: "instagram", accountId: "report-instagram", externalPostId: "provider-post", status: "ready", period: "lifetime",
      metrics: [
        { key: "views", value: 1200, unit: "count", rawMetric: "views", source: "instagram_media_insights", coverage: "instagram_only", definitionVersion: "2026-01" },
        { key: "likes", value: 84, unit: "count", rawMetric: "likes", source: "instagram_media_insights", coverage: "instagram_only", definitionVersion: "2026-01" },
      ],
      rawPayloadSha256: "a".repeat(64), capturedAt: "2026-08-16T10:00:00.000Z", createdAt: "2026-08-16T10:00:00.000Z",
    }, { id: "audit-report-snapshot", workspaceId: "default", contentItemId: item.id, actorId: "originpost-worker", actorType: "system", action: "analytics.snapshot-captured", detail: { proofId: "proof-report-fixture" }, createdAt: "2026-08-16T10:00:00.000Z" });
  });

  afterAll(async () => { await app.close(); });

  it("creates, generates, exports, shares and revokes an immutable report", async () => {
    const created = await request(app.getHttpServer()).post("/v1/analytics/reports").send({
      workspaceId: "default", name: "August client report", brandIds: ["brand_default"], rangeMode: "fixed",
      from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z", platforms: ["instagram"], accountIds: ["report-instagram"], metricKeys: ["views", "likes"],
    }).expect(201);
    const reportId = created.body.definition.id as string;

    const generated = await request(app.getHttpServer()).post(`/v1/analytics/reports/${reportId}/generate?workspaceId=default`).expect(201);
    expect(generated.body).toMatchObject({ reportId, reportName: "August client report", canonicalSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(generated.body.proofRows[0]).toMatchObject({ proofId: "proof-report-fixture", title: "Campaign launch, verified", metrics: expect.arrayContaining([expect.objectContaining({ key: "views", value: 1200 })]) });
    expect(generated.body.groups[0].metrics).toEqual(expect.arrayContaining([expect.objectContaining({ key: "views", value: 1200, status: "ready" })]));

    const csv = await request(app.getHttpServer()).get(`/v1/analytics/reports/${reportId}/snapshots/${generated.body.id}/export.csv?workspaceId=default`).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain('"Campaign launch, verified"');

    const shared = await request(app.getHttpServer()).post(`/v1/analytics/reports/${reportId}/snapshots/${generated.body.id}/shares`).send({ workspaceId: "default", expiresInDays: 14 }).expect(201);
    const reportDetail = await request(app.getHttpServer()).get(`/v1/analytics/reports/${reportId}?workspaceId=default`).expect(200);
    expect(reportDetail.body.shares[0]).toMatchObject({ id: shared.body.id, snapshotId: generated.body.id });
    expect(reportDetail.body.shares[0]).not.toHaveProperty("revokedAt");
    expect(reportDetail.body.shares[0]).not.toHaveProperty("tokenSha256");
    const token = new URL(shared.body.url as string).pathname.split("/").at(-1)!;
    const publicView = await request(app.getHttpServer()).get(`/v1/analytics-reports/${token}`).expect(200);
    expect(publicView.body.report).toMatchObject({ name: "August client report", canonicalSha256: generated.body.canonicalSha256 });
    expect(publicView.body.posts[0]).not.toHaveProperty("proofId");
    expect(publicView.body.posts[0]).not.toHaveProperty("analyticsSnapshotId");
    expect(publicView.body.posts[0]).not.toHaveProperty("errorCode");
    expect(publicView.body.posts[0]).not.toHaveProperty("provider");
    await request(app.getHttpServer()).get(`/v1/analytics-reports/${token}/export.csv`).expect(200);

    await request(app.getHttpServer()).post(`/v1/analytics/reports/${reportId}/shares/${shared.body.id}/revoke?workspaceId=default`).expect(201);
    await request(app.getHttpServer()).get(`/v1/analytics-reports/${token}`).expect(404);
  });
});
