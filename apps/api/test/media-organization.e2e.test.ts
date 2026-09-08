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

const workspaceId = "media-organization-api";
const brandId = "media-organization-brand";
const now = "2026-09-01T12:00:00.000Z";

describe("Media Organization API", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = "test"; process.env.AUTH_MODE = "single-user"; process.env.DATABASE_URL = ""; process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = "media-owner"; process.env.BOOTSTRAP_USER_NAME = "Media Owner";
    process.env.REVIEW_LINK_SECRET = "media-review-secret-with-more-than-32-characters";
    process.env.MEDIA_DELIVERY_SECRET = "media-delivery-secret-with-more-than-32-characters";
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService)); await startE2eApp(app);
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    await infrastructure.organizationRepository.createWorkspace({
      workspace: { id: workspaceId, name: "Media organization", slug: "media-organization-api", createdAt: now, updatedAt: now },
      defaultBrand: { id: brandId, workspaceId, name: "Media brand", slug: "media-brand", primaryLanguage: "English", timezone: "UTC", status: "active", createdBy: "media-owner", createdAt: now, updatedAt: now },
      ownerUserId: "media-owner", ownerDisplayName: "Media Owner",
      event: { id: "audit-media-api-setup", workspaceId, actorId: "media-owner", actorType: "human", action: "workspace.created", detail: {}, createdAt: now },
    });
    for (const marker of ["a", "b"]) {
      const asset: MediaAsset = { id: `media-api-${marker}`, workspaceId, brandId, version: 1, kind: "image", purpose: "creative", fileName: `Mumbai ${marker}.jpg`, contentType: "image/jpeg", sizeBytes: 100, sha256: marker.repeat(64), objectKey: `private/${marker}`, status: "ready", inspectionStatus: "ready", detectedContentType: "image/jpeg", widthPixels: 1080, heightPixels: 1080, inspectedAt: now, inspector: "test", rights: "owned", altText: "Mumbai campaign", createdBy: "media-owner", createdAt: now, uploadExpiresAt: now, readyAt: now };
      await infrastructure.mediaRepository.save(asset, { id: `audit-media-${marker}`, workspaceId, actorId: "media-owner", actorType: "human", action: "media.ready", detail: {}, createdAt: now });
    }
  });

  afterAll(async () => { await app.close(); });

  it("creates nested folders and safely bulk-organizes visible assets", async () => {
    const initial = await request(app.getHttpServer()).get(`/v1/media-assets/library?workspaceId=${workspaceId}&brandId=${brandId}`).expect(200);
    expect(initial.body).toMatchObject({ total: 2, items: [{ organization: { version: 0 } }, { organization: { version: 0 } }] });
    expect(initial.body.items[0].asset).not.toHaveProperty("objectKey");

    const root = await request(app.getHttpServer()).post("/v1/media-assets/folders").send({ workspaceId, brandId, name: "Campaigns" }).expect(201);
    const child = await request(app.getHttpServer()).post("/v1/media-assets/folders").send({ workspaceId, brandId, parentId: root.body.id, name: "Mumbai Launch" }).expect(201);
    const organized = await request(app.getHttpServer()).post("/v1/media-assets/organize").send({ workspaceId, brandId, assets: [{ assetId: "media-api-a", expectedVersion: 0 }, { assetId: "media-api-b", expectedVersion: 0 }], folderId: child.body.id, addTags: ["Launch", "Mumbai"], favorite: true }).expect(200);
    expect(organized.body.organized).toHaveLength(2);
    const filtered = await request(app.getHttpServer()).get(`/v1/media-assets/library?workspaceId=${workspaceId}&brandId=${brandId}&folderId=${child.body.id}&tags=launch&favorite=true&search=mumbai`).expect(200);
    expect(filtered.body).toMatchObject({ total: 2, availableTags: ["launch", "mumbai"] });
    const folders = await request(app.getHttpServer()).get(`/v1/media-assets/folders?workspaceId=${workspaceId}&brandId=${brandId}`).expect(200);
    expect(folders.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: root.body.id, childFolderCount: 1 }), expect.objectContaining({ id: child.body.id, directAssetCount: 2 })]));
    await request(app.getHttpServer()).post("/v1/media-assets/organize").send({ workspaceId, brandId, assets: [{ assetId: "media-api-a", expectedVersion: 0 }], addTags: ["stale"] }).expect(409);
    await request(app.getHttpServer()).delete(`/v1/media-assets/folders/${child.body.id}?workspaceId=${workspaceId}&brandId=${brandId}&version=1`).expect(409);
  });

  it("rejects unknown fields and empty bulk changes", async () => {
    await request(app.getHttpServer()).post("/v1/media-assets/folders").send({ workspaceId, brandId, name: "Unsafe", credentialRef: "secret:must-not-pass" }).expect(400);
    await request(app.getHttpServer()).post("/v1/media-assets/organize").send({ workspaceId, brandId, assets: [{ assetId: "media-api-a", expectedVersion: 1 }] }).expect(400);
  });
});
