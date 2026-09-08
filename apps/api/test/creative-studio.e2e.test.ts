import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { startE2eApp } from "./test-app.js";

describe("Creative Studio", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_MODE: "single-user",
      DATABASE_URL: "",
      REDIS_URL: "",
      BOOTSTRAP_USER_ID: "creative-owner",
      BOOTSTRAP_USER_NAME: "Creative Owner",
      REVIEW_LINK_SECRET: "creative-review-secret-with-more-than-32-characters",
      MEDIA_DELIVERY_SECRET: "creative-media-secret-with-more-than-32-characters",
      AUTOMATION_DELIVERY_ENABLED: "false",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
  });

  afterAll(async () => { await app.close() });

  it("renders an immutable multilingual visual and attaches its exact output to a draft", async () => {
    const content = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", brandId: "brand_default", title: "Mumbai event update" }).expect(201);
    const upload = await request(app.getHttpServer()).post("/v1/media-assets/uploads").send({
      workspaceId: "default",
      brandId: "brand_default",
      contentItemId: content.body.id,
      kind: "image",
      purpose: "creative",
      fileName: "mumbai-source.png",
      contentType: "image/png",
      sizeBytes: 1,
      sha256: "c".repeat(64),
      rights: "owned",
      altText: "Mumbai city reference",
    }).expect(201);
    const ready = await request(app.getHttpServer()).post(`/v1/media-assets/${upload.body.asset.id}/complete`).send({ workspaceId: "default" }).expect(200);
    expect(ready.body).toMatchObject({ status: "ready", inspectionStatus: "ready", detectedContentType: "image/png" });

    const spec = {
      format: "portrait",
      sourceMediaId: ready.body.id,
      sourceMediaSha256: ready.body.sha256,
      contentItemId: content.body.id,
      kicker: "MUMBAI EVENTS",
      headline: "મુંબઈમાં આગામી ઇવેન્ટ · मुंबई इवेंट",
      subtitle: "Public details only. Confirm the official event page before publishing.",
      footer: "Source-backed visual",
      layout: "headline",
      font: "manrope",
      textAlign: "left",
      focalPoint: { x: 50, y: 50 },
      zoom: 1,
      palette: ["#303A36", "#1E2623", "#FFFFFF", "#D1AA7B", "#E6EEE9"],
    };
    const created = await request(app.getHttpServer()).post("/v1/creative-studio/projects").send({ workspaceId: "default", brandId: "brand_default", name: "Mumbai event visual", spec }).expect(201);
    expect(created.body).toMatchObject({ project: { status: "draft", version: 1 }, currentRevision: { revisionNumber: 1, specSnapshot: { sourceMediaId: ready.body.id } }, renders: [] });

    await request(app.getHttpServer()).post(`/v1/creative-studio/projects/${created.body.project.id}/revisions`).set("If-Match", "1").send({ workspaceId: "default", name: "Changed without valid source", spec: { ...spec, sourceMediaSha256: "d".repeat(64) } }).expect(409);

    const rendered = await request(app.getHttpServer()).post(`/v1/creative-studio/projects/${created.body.project.id}/revisions/${created.body.currentRevision.id}/render`).set("If-Match", "1").send({ workspaceId: "default" }).expect(201);
    expect(rendered.body.project, JSON.stringify(rendered.body)).toMatchObject({ status: "ready", version: 3 });
    expect(rendered.body.render).toMatchObject({ status: "ready", outputMediaId: expect.any(String), outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(rendered.body.render).not.toHaveProperty("leaseOwner");
    expect(rendered.body.outputAsset).toMatchObject({ kind: "image", purpose: "creative", status: "ready", inspectionStatus: "ready", widthPixels: 1080, heightPixels: 1350, rights: "owned" });
    expect(rendered.body.outputAsset).not.toHaveProperty("objectKey");

    const detail = await request(app.getHttpServer()).get(`/v1/creative-studio/projects/${created.body.project.id}?workspaceId=default`).expect(200);
    expect(detail.body).toMatchObject({ project: { outputMediaId: rendered.body.outputAsset.id }, revisions: [{ revisionNumber: 1 }], outputAsset: { sha256: rendered.body.render.outputSha256 } });

    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/drafts?workspaceId=default`).set("If-Match", String(content.body.version)).send({ platform: "instagram", format: "image", title: "Mumbai event update", caption: "Verified details will be added before publication.", mediaIds: [rendered.body.outputAsset.id] }).expect(201);
    expect(drafted.body.drafts.at(-1)).toMatchObject({ mediaIds: [rendered.body.outputAsset.id], platform: "instagram" });
  }, 30_000);
});
