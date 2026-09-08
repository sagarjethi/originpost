import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { trustedShareTargetPost } from "../src/common/auth-context.guard.js";
import { configureApp } from "../src/configure-app.js";
import { memoryFixtureFor } from "../src/media/memory-media-fixtures.js";
import { startE2eApp } from "./test-app.js";

describe("mobile share capture", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "single-user";
    process.env.DATABASE_URL = "";
    process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = "share-owner";
    process.env.BOOTSTRAP_USER_NAME = "Share Owner";
    process.env.REVIEW_LINK_SECRET = "share-capture-test-secret-with-more-than-32-characters";
    process.env.MEDIA_DELIVERY_SECRET = "share-capture-media-secret-with-more-than-32-characters";
    process.env.API_PUBLIC_URL = "http://localhost:4000";
    process.env.WEB_PUBLIC_URL = "http://localhost:3000";
    process.env.AUTOMATION_DELIVERY_ENABLED = "false";
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
  });

  afterAll(async () => { await app.close(); });

  it("accepts a form Share Target, keeps payload off the redirect URL, and converts exactly once", async () => {
    const intake = await request(app.getHttpServer()).post("/v1/share-captures/intake")
      .set("sec-fetch-site", "none").set("sec-fetch-mode", "navigate").type("form")
      .send({ title: "Shared story", text: "Read this", url: "https://example.com/story?utm_source=phone" }).expect(303);
    expect(intake.headers.location).toBe("/capture");
    expect(intake.headers.location).not.toContain("example.com");
    const cookie = (intake.headers["set-cookie"] as unknown as string[])[0]!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("example.com");

    const pending = await request(app.getHttpServer()).get("/v1/share-captures/current").set("Cookie", cookie).expect(200);
    expect(pending.body).toMatchObject({ status: "pending", title: "Shared story", originalUrl: "https://example.com/story?utm_source=phone" });
    expect(pending.body).not.toHaveProperty("tokenHash");
    expect(pending.body).not.toHaveProperty("normalizedUrl");

    const converted = await request(app.getHttpServer()).post("/v1/share-captures/current/convert").set("Cookie", cookie).send({ workspaceId: "default", brandId: "brand_default", title: "Shared story", text: "Read this", url: "https://example.com/story?utm_source=phone" }).expect(201);
    expect(converted.body.meta.idempotentReplay).toBe(false);
    expect(converted.body.data.contentItem).toMatchObject({ status: "inbox", brandId: "brand_default", createdBy: "share-owner" });
    expect(converted.body.data.contentItem.sources).toEqual([expect.objectContaining({ kind: "url", rights: "reference-only", url: "https://example.com/story?utm_source=phone" })]);
    expect(converted.headers["set-cookie"][0]).toContain("Max-Age=0");

    const replay = await request(app.getHttpServer()).post("/v1/share-captures/current/convert").set("Cookie", cookie).send({ workspaceId: "default", brandId: "brand_default" }).expect(201);
    expect(replay.body).toMatchObject({ data: { contentItem: { id: converted.body.data.contentItem.id } }, meta: { idempotentReplay: true } });

    const repeatedIntake = await request(app.getHttpServer()).post("/v1/share-captures/intake")
      .set("sec-fetch-site", "none").set("sec-fetch-mode", "navigate").type("form")
      .send({ title: "Same story again", url: "https://example.com/story?utm_campaign=second&fbclid=tracking" }).expect(303);
    const repeatedCookie = (repeatedIntake.headers["set-cookie"] as unknown as string[])[0]!;
    const repeatedConvert = await request(app.getHttpServer()).post("/v1/share-captures/current/convert").set("Cookie", repeatedCookie)
      .send({ workspaceId: "default", brandId: "brand_default" }).expect(201);
    expect(repeatedConvert.body).toMatchObject({
      data: { contentItem: { id: converted.body.data.contentItem.id } },
      meta: { idempotentReplay: true }
    });
    expect(repeatedConvert.body.data.contentItem.sources).toHaveLength(1);
  });

  it("rejects cross-site form posts from the CSRF alternative", () => {
    const base = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-mode": "navigate" } };
    expect(trustedShareTargetPost({ ...base, headers: { ...base.headers, "sec-fetch-site": "cross-site" } } as never, "https://originpost.example")).toBe(false);
    expect(trustedShareTargetPost({ ...base, headers: { ...base.headers, "sec-fetch-site": "none" } } as never, "https://originpost.example")).toBe(true);
  });

  it("streams one multipart image into inspection and materializes an exact Library asset", async () => {
    const png = memoryFixtureFor("image/png");
    const intake = await request(app.getHttpServer()).post("/v1/share-captures/intake")
      .set("sec-fetch-site", "none").set("sec-fetch-mode", "navigate")
      .field("title", "Phone newsroom image").attach("media", png, { filename: "newsroom.png", contentType: "image/png" }).expect(303);
    const cookie = (intake.headers["set-cookie"] as unknown as string[])[0]!;

    const pending = await request(app.getHttpServer()).get("/v1/share-captures/current").set("Cookie", cookie).expect(200);
    expect(pending.body).toMatchObject({ status: "pending_review", title: "Phone newsroom image", media: { kind: "image", fileName: "newsroom.png", declaredContentType: "image/png", detectedContentType: "image/png", inspectionStatus: "ready", malwareScanStatus: "disabled", widthPixels: 16, heightPixels: 16 } });
    expect(pending.body.media).not.toHaveProperty("quarantineObjectKey");
    expect(pending.body).not.toHaveProperty("materializationClaimOwner");

    const preview = await request(app.getHttpServer()).get("/v1/share-captures/current/preview").set("Cookie", cookie).expect(200);
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    expect(preview.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(preview.body).equals(png)).toBe(true);

    const saved = await request(app.getHttpServer()).post("/v1/share-captures/current/materialize").set("Cookie", cookie).send({ workspaceId: "default", brandId: "brand_default", title: "Phone newsroom image", purpose: "source", rights: "reference-only", mode: "library" }).expect(201);
    expect(saved.body).toMatchObject({ data: { receipt: { status: "converted" }, mediaAsset: { kind: "image", status: "ready", rights: "reference-only", purpose: "source", inspectionStatus: "ready", malwareScanStatus: "disabled" } }, meta: { idempotentReplay: false } });
    expect(saved.body.data).not.toHaveProperty("contentItem");
    expect(saved.body.data.mediaAsset).not.toHaveProperty("objectKey");
    expect(saved.headers["set-cookie"][0]).toContain("Max-Age=0");

    const replay = await request(app.getHttpServer()).post("/v1/share-captures/current/materialize").set("Cookie", cookie).send({ workspaceId: "default", brandId: "brand_default", title: "Phone newsroom image", purpose: "source", rights: "reference-only", mode: "library" }).expect(201);
    expect(replay.body).toMatchObject({ data: { mediaAsset: { id: saved.body.data.mediaAsset.id } }, meta: { idempotentReplay: true } });
  });

  it("creates exactly one unapproved and unscheduled draft from the inspected asset", async () => {
    const upload = await request(app.getHttpServer()).post("/v1/share-captures/uploads")
      .field("text", "Draft caption from the field team").attach("media", memoryFixtureFor("image/png"), { filename: "field.png", contentType: "image/png" }).expect(201);
    const cookie = (upload.headers["set-cookie"] as unknown as string[])[0]!;
    const saved = await request(app.getHttpServer()).post("/v1/share-captures/current/materialize").set("Cookie", cookie).send({ workspaceId: "default", brandId: "brand_default", title: "Field image", purpose: "creative", rights: "owned", mode: "content", platform: "instagram", format: "image", caption: "Draft caption from the field team" }).expect(201);
    expect(saved.body.data.contentItem).toMatchObject({ status: "drafting", approvals: [], targets: [], proofs: [] });
    expect(saved.body.data.contentItem.drafts).toEqual([expect.objectContaining({ id: saved.body.data.draftId, platform: "instagram", format: "image", mediaIds: [saved.body.data.mediaAsset.id] })]);
    expect(saved.body.data.mediaAsset).not.toHaveProperty("objectKey");
  });

  it("rejects cross-site multipart posts and more than one media file", async () => {
    const multipart = { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test", "sec-fetch-mode": "navigate" } };
    expect(trustedShareTargetPost({ ...multipart, headers: { ...multipart.headers, "sec-fetch-site": "cross-site" } } as never, "https://originpost.example")).toBe(false);
    expect(trustedShareTargetPost({ ...multipart, headers: { ...multipart.headers, "sec-fetch-site": "none" } } as never, "https://originpost.example")).toBe(true);
    const png = memoryFixtureFor("image/png");
    await request(app.getHttpServer()).post("/v1/share-captures/intake").set("sec-fetch-site", "none").set("sec-fetch-mode", "navigate")
      .attach("media", png, { filename: "first.png", contentType: "image/png" }).attach("media", png, { filename: "second.png", contentType: "image/png" }).expect(400);
  });
});
