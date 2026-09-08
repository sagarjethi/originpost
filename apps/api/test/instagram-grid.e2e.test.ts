import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { ConnectedAccount, ContentItem, MediaAsset } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

const workspaceId = "instagram-grid-api";
const brandId = "instagram-grid-brand";
const now = "2026-09-01T12:00:00.000Z";

describe("Instagram grid API", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = "test"; process.env.AUTH_MODE = "single-user"; process.env.DATABASE_URL = ""; process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = "grid-owner"; process.env.BOOTSTRAP_USER_NAME = "Grid Owner";
    process.env.REVIEW_LINK_SECRET = "grid-review-secret-with-more-than-32-characters";
    process.env.MEDIA_DELIVERY_SECRET = "grid-delivery-secret-with-more-than-32-characters";
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService)); await startE2eApp(app);
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    await infrastructure.organizationRepository.createWorkspace({
      workspace: { id: workspaceId, name: "Grid workspace", slug: "instagram-grid-api", createdAt: now, updatedAt: now },
      defaultBrand: { id: brandId, workspaceId, name: "Grid brand", slug: "grid-brand", primaryLanguage: "English", timezone: "UTC", status: "active", createdBy: "grid-owner", createdAt: now, updatedAt: now },
      ownerUserId: "grid-owner", ownerDisplayName: "Grid Owner",
      event: { id: "audit-grid-setup", workspaceId, actorId: "grid-owner", actorType: "human", action: "workspace.created", detail: {}, createdAt: now },
    });
    const account: ConnectedAccount = { id: "instagram-grid-account", workspaceId, brandId, platform: "instagram", displayName: "Sample Publisher", externalAccountId: "17841400000000000", capabilities: ["profile_read", "media_publish"], status: "healthy", createdBy: "grid-owner", createdAt: now, updatedAt: now };
    await infrastructure.connectedAccountRepository.save(account, { id: "audit-grid-account", workspaceId, actorId: "grid-owner", actorType: "human", action: "channel.connected", detail: {}, createdAt: now });
    const asset: MediaAsset = { id: "grid-image", workspaceId, brandId, version: 1, kind: "image", purpose: "creative", fileName: "Mumbai.jpg", contentType: "image/jpeg", sizeBytes: 100, sha256: "a".repeat(64), objectKey: "private/grid-image", status: "ready", inspectionStatus: "ready", detectedContentType: "image/jpeg", widthPixels: 1080, heightPixels: 1350, inspectedAt: now, inspector: "test", rights: "owned", altText: "Mumbai", createdBy: "grid-owner", createdAt: now, uploadExpiresAt: now, readyAt: now };
    await infrastructure.mediaRepository.save(asset, { id: "audit-grid-media", workspaceId, actorId: "grid-owner", actorType: "human", action: "media.ready", detail: {}, createdAt: now });
    const item: ContentItem = {
      id: "grid-content", workspaceId, brandId, version: 1, title: "Mumbai event", summary: "", status: "scheduled", researchDepth: "quick", riskLevel: "low", tags: [], sources: [], claims: [], researchRuns: [], approvals: [], reviewComments: [], reviewLinks: [], publishAttempts: [], createdBy: "grid-owner", createdAt: now, updatedAt: now,
      drafts: [
        { id: "grid-draft", revision: 1, contentSha256: "b".repeat(64), createdBy: "grid-owner", createdAt: now, platform: "instagram", format: "image", title: "Mumbai", caption: "Mumbai caption", mediaIds: [asset.id] },
        { id: "story-draft", revision: 1, contentSha256: "c".repeat(64), createdBy: "grid-owner", createdAt: now, platform: "instagram", format: "story", title: "Story", caption: "Internal", mediaIds: [asset.id] },
      ],
      targets: [
        { id: "grid-target", platform: "instagram", accountId: account.id, draftId: "grid-draft", scheduledFor: "2026-09-05T12:00:00.000Z", deliveryMode: "auto_publish", status: "queued" },
        { id: "story-target", platform: "instagram", accountId: account.id, draftId: "story-draft", scheduledFor: "2026-09-06T12:00:00.000Z", deliveryMode: "auto_publish", status: "queued" },
      ], proofs: [],
    };
    await infrastructure.repository.commit(item, { id: "audit-grid-content", workspaceId, contentItemId: item.id, actorId: "grid-owner", actorType: "human", action: "content.created", detail: {}, createdAt: now });
  });

  afterAll(async () => { await app.close(); });

  it("returns an honest, sanitized profile projection", async () => {
    const response = await request(app.getHttpServer()).get(`/v1/instagram-grid?workspaceId=${workspaceId}&brandId=${brandId}`).expect(200);
    expect(response.body).toMatchObject({ data: { selectedAccountId: "instagram-grid-account", accounts: [{ id: "instagram-grid-account", displayName: "Sample Publisher", status: "healthy" }], tiles: [{ targetId: "grid-target", preview: { mediaId: "grid-image", kind: "image", contentType: "image/jpeg", widthPixels: 1080, heightPixels: 1350 } }] }, meta: { coverage: "originpost_records_only", providerHistoryIncluded: false, storiesExcluded: true, limit: 30 } });
    expect(response.body.data.tiles).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain("private/grid-image");
  });

  it("rejects cross-scope account identities and unknown query fields", async () => {
    await request(app.getHttpServer()).get(`/v1/instagram-grid?workspaceId=${workspaceId}&brandId=${brandId}&accountId=another-account`).expect(404);
    await request(app.getHttpServer()).get(`/v1/instagram-grid?workspaceId=${workspaceId}&brandId=${brandId}&credentialRef=secret:nope`).expect(400);
  });

  it("offers a same-origin, rights-checked preview without exposing storage", async () => {
    const download = await request(app.getHttpServer()).get(`/v1/media-assets/grid-image/download-url?workspaceId=${workspaceId}`).expect(200);
    expect(download.body.previewUrl).toMatch(/^\/v1\/media-assets\/preview\?token=/u);
    await request(app.getHttpServer()).get(download.body.previewUrl).expect(200).expect("cache-control", "private, no-store");
  });
});
