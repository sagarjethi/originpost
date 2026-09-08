import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { createNotification, markTargetStatus, startPublishAttempt, type Actor, type ProviderPublishOperation } from "@originpost/domain";
import { createMediaDeliveryToken } from "@originpost/connectors";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { CredentialVaultService } from "../src/channels/credential-vault.service.js";
import { startE2eApp, withCurrentScheduleConflictAcknowledgement } from "./test-app.js";

describe("OriginPost API", () => {
  let app: NestFastifyApplication;
  let connectedInstagramAccountId: string;
  let connectedFacebookAccountId: string;
  let connectedYoutubeAccountId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "single-user";
    process.env.DATABASE_URL = "";
    process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = "test-owner";
    process.env.BOOTSTRAP_USER_NAME = "Test Owner";
    process.env.REVIEW_LINK_SECRET = "test-review-link-secret-with-more-than-32-characters";
    process.env.MEDIA_DELIVERY_SECRET = "test-media-delivery-secret-with-more-than-32-characters";
    process.env.TEST_INSTAGRAM_CREDENTIAL = "test-only-credential";
    process.env.TEST_FACEBOOK_CREDENTIAL = "test-only-facebook-page-credential";
    process.env.TEST_YOUTUBE_CREDENTIAL = "test-only-youtube-credential";
    process.env.INSTAGRAM_EDITORIAL_CREDENTIAL = "test-only-editorial-credential";
    process.env.CREDENTIAL_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    process.env.OAUTH_TEST_MODE = "true";
    process.env.API_PUBLIC_URL = "http://localhost:4000";
    process.env.WEB_PUBLIC_URL = "http://localhost:3000";
    process.env.META_GRAPH_API_VERSION = "v26.0";
    process.env.INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION = "v26.0";
    process.env.INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT = new Date(Date.now()-60_000).toISOString();
    process.env.INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT = new Date(Date.now()+60*60_000).toISOString();
    process.env.AUTOMATION_DELIVERY_ENABLED = "false";
    process.env.AUTOMATION_ALLOW_PRIVATE_WEBHOOKS = "true";
    process.env.PLUGIN_DIRECTORY = "../../plugins";

    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false, routerOptions: { maxParamLength: 2048 } }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const now = new Date().toISOString();
    await infrastructure.organizationRepository.createWorkspace({
      workspace: { id: "newsroom", name: "Newsroom", slug: "newsroom", createdAt: now, updatedAt: now },
      defaultBrand: { id: "brand_newsroom", workspaceId: "newsroom", name: "Newsroom brand", slug: "newsroom", primaryLanguage: "English", timezone: "UTC", status: "active", createdBy: "test-owner", createdAt: now, updatedAt: now },
      ownerUserId: "test-owner",
      ownerDisplayName: "Test Owner",
      event: { id: "audit-newsroom-setup", workspaceId: "newsroom", actorId: "test-owner", actorType: "human", action: "workspace.created", detail: {}, createdAt: now },
    });
    const connected = await request(app.getHttpServer()).post("/v1/channels/accounts").send({
      workspaceId: "default", platform: "instagram", displayName: "Test Instagram", externalAccountId: "test-instagram",
      credentialRef: "env:TEST_INSTAGRAM_CREDENTIAL", capabilities: ["profile_read", "media_publish"], expiresAt: "2099-12-31T00:00:00.000Z",
    }).expect(201);
    connectedInstagramAccountId = connected.body.id as string;
    const facebook = await request(app.getHttpServer()).post("/v1/channels/accounts").send({
      workspaceId: "default", platform: "facebook", displayName: "Test Facebook Page", externalAccountId: "test-facebook-page",
      credentialRef: "env:TEST_FACEBOOK_CREDENTIAL", capabilities: ["page_read", "media_publish"],
    }).expect(201);
    connectedFacebookAccountId = facebook.body.id as string;
    const youtube = await request(app.getHttpServer()).post("/v1/channels/accounts").send({
      workspaceId: "default", platform: "youtube", displayName: "Test YouTube", externalAccountId: "test-youtube",
      credentialRef: "env:TEST_YOUTUBE_CREDENTIAL", capabilities: ["channel_read", "video_upload"], expiresAt: "2099-12-31T00:00:00.000Z",
    }).expect(201);
    connectedYoutubeAccountId = youtube.body.id as string;
  });

  afterAll(async () => {
    await app.close();
  });

  async function readyMedia(kind: "image" | "video", contentType: string, marker: string): Promise<string> {
    const upload = await request(app.getHttpServer()).post("/v1/media-assets/uploads").send({
      workspaceId: "default", kind, purpose: "creative", fileName: `fixture.${kind === "image" ? "png" : "mp4"}`,
      contentType, sizeBytes: 1, sha256: marker.repeat(64), rights: "owned", altText: "Test media",
    }).expect(201);
    await request(app.getHttpServer()).post(`/v1/media-assets/${upload.body.asset.id}/complete`).send({ workspaceId: "default" }).expect(200);
    return upload.body.asset.id as string;
  }

  it("exposes an unversioned public health check", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);
    expect(response.body).toMatchObject({ status: "ok", framework: "nestjs", storage: "memory" });
  });

  it("exposes operator-scoped workspace health without adding a public diagnostic surface", async () => {
    const response = await request(app.getHttpServer()).get("/v1/operations/health?workspaceId=default").expect(200);
    expect(response.body).toMatchObject({ workspaceId: "default", status: "healthy" });
    expect(response.body.checks.map((check: { id: string }) => check.id)).toEqual(["malware_protection", "webhook_delivery", "media_cleanup", "publishing_attention", "delivery_queue"]);
    expect(response.body.checks[0]).not.toHaveProperty("host");
  });

  it("rejects client-declared Instagram collaborator capabilities", async()=>{
    await request(app.getHttpServer()).post("/v1/channels/accounts").send({workspaceId:"default",platform:"instagram",displayName:"Unverified collaborator account",externalAccountId:"unverified-collab",capabilities:["collaborator_publish"]}).expect(400);
  });

  it("creates a content item with the trusted local owner", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/content-items")
      .set("x-originpost-user-id", "spoofed-user")
      .set("x-originpost-role", "viewer")
      .send({ workspaceId: "newsroom", title: "A source-backed update", researchDepth: "standard", riskLevel: "medium" })
      .expect(201);

    expect(response.body.workspaceId).toBe("newsroom");
    expect(response.body.createdBy).toBe("test-owner");
  });

  it("runs a scoped and idempotent external automation flow", async () => {
    const createdKey = await request(app.getHttpServer()).post("/v1/automation/keys?workspaceId=default").send({
      name: "Test n8n intake", scopes: ["content:read", "content:write", "imports:write"], brandIds: ["brand_default"], accountIds: [],
    }).expect(201);
    expect(createdKey.body.secret).toMatch(/^op_live_/);
    expect(createdKey.body.key).not.toHaveProperty("secretHash");
    const authorization = `Bearer ${createdKey.body.secret as string}`;

    const created = await request(app.getHttpServer()).post("/public/v1/content-items").set("Authorization", authorization).set("Idempotency-Key", "external-row-0001").send({
      brandId: "brand_default", title: "External automation intake", summary: "Created through a scoped public command.", riskLevel: "medium",
    }).expect(201);
    expect(created.body.meta.idempotentReplay).toBe(false);
    expect(created.body.data).toMatchObject({ workspaceId: "default", brandId: "brand_default", createdBy: `api_key:${createdKey.body.key.id}` });
    const replay = await request(app.getHttpServer()).post("/public/v1/content-items").set("Authorization", authorization).set("Idempotency-Key", "external-row-0001").send({
      brandId: "brand_default", title: "External automation intake", summary: "Created through a scoped public command.", riskLevel: "medium",
    }).expect(201);
    expect(replay.body).toMatchObject({ data: { id: created.body.data.id }, meta: { idempotentReplay: true } });
    await request(app.getHttpServer()).post("/public/v1/content-items").set("Authorization", authorization).set("Idempotency-Key", "external-row-0001").send({ brandId: "brand_default", title: "Different payload" }).expect(409);
    await request(app.getHttpServer()).post(`/public/v1/content-items/${created.body.data.id}/drafts`).set("Authorization", authorization).send({ platform: "instagram", format: "image", title: "Draft", caption: "Draft caption", mediaIds: [] }).expect(400);
    const listed = await request(app.getHttpServer()).get("/public/v1/content-items?brandId=brand_default").set("Authorization", authorization).expect(200);
    expect(listed.body.data.filter((item: { id: string }) => item.id === created.body.data.id)).toHaveLength(1);
    await request(app.getHttpServer()).post(`/public/v1/content-items/${created.body.data.id}/schedule`).set("Authorization", authorization).set("Idempotency-Key", "external-schedule-0001").send({ platform: "instagram", accountId: connectedInstagramAccountId, draftId: "missing", scheduledFor: "2099-01-01T00:00:00.000Z" }).expect(400);
    await request(app.getHttpServer()).post(`/public/v1/content-items/${created.body.data.id}/schedule`).set("Authorization", authorization).set("If-Match", String(created.body.data.version)).set("Idempotency-Key", "external-schedule-0001").send({ platform: "instagram", accountId: connectedInstagramAccountId, draftId: "missing", scheduledFor: "2099-01-01T00:00:00.000Z" }).expect(403);

    const subscription = await request(app.getHttpServer()).post("/v1/automation/subscriptions?workspaceId=default").send({ name: "Workflow callback", url: "https://example.com/originpost", topics: ["content.created"], brandIds: ["brand_default"] }).expect(201);
    expect(subscription.body.signingSecret).toMatch(/^whsec_/); expect(subscription.body.subscription).not.toHaveProperty("secret");
    await request(app.getHttpServer()).post(`/v1/automation/subscriptions/${subscription.body.subscription.id}/test?workspaceId=default`).expect(202);
    await request(app.getHttpServer()).post("/public/v1/content-items").set("Authorization", authorization).set("Idempotency-Key", "external-row-0002").send({ brandId: "brand_default", title: "Webhook event intake" }).expect(201);
    const events = await request(app.getHttpServer()).get("/v1/automation/events?workspaceId=default").expect(200);
    expect(events.body).toEqual(expect.arrayContaining([expect.objectContaining({ topic: "content.created", actorType: "api_key", brandId: "brand_default" })]));
    expect(events.body).toEqual(expect.arrayContaining([expect.objectContaining({ topic: "system.test", payload: expect.objectContaining({ subscriptionId: subscription.body.subscription.id }) })]));
    const deliveries = await request(app.getHttpServer()).get("/v1/automation/deliveries?workspaceId=default").expect(200);
    const subscriptionDeliveries = deliveries.body.filter((delivery: { subscriptionId: string }) => delivery.subscriptionId === subscription.body.subscription.id);
    expect(subscriptionDeliveries).toHaveLength(2);
    expect(new Set(subscriptionDeliveries.map((delivery: { eventId: string }) => delivery.eventId)).size).toBe(2);
    for (const delivery of subscriptionDeliveries as Array<{ status: string; attempts: number }>) {
      expect(["pending", "processing", "delivered", "failed", "dead_letter"]).toContain(delivery.status);
      expect(delivery.attempts).toBeGreaterThanOrEqual(0);
      expect(delivery.attempts).toBeLessThanOrEqual(1);
    }
    const subscriptions = await request(app.getHttpServer()).get("/v1/automation/subscriptions?workspaceId=default").expect(200);
    expect(subscriptions.body[0]).not.toHaveProperty("secret");

    const importRows = Array.from({ length: 100 }, (_, index) => ({ externalRef: `wire-${String(index + 1).padStart(3, "0")}`, title: `Imported story ${index + 1}`, summary: "Staged import row" }));
    const preview = await request(app.getHttpServer()).post("/public/v1/imports/preview").set("Authorization", authorization).send({ format: "json", brandId: "brand_default", rows: importRows });
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    expect(preview.body).toMatchObject({ data: { status: "staged", rows: expect.any(Array) }, meta: { idempotentReplay: false } });
    expect(preview.body.data.rows).toHaveLength(100);
    const committed = await request(app.getHttpServer()).post(`/public/v1/imports/${preview.body.data.id}/commit`).set("Authorization", authorization).expect(201);
    expect(committed.body.meta).toMatchObject({ created: 100, existing: 0, invalid: 0, failed: 0 });
    const committedReplay = await request(app.getHttpServer()).post(`/public/v1/imports/${preview.body.data.id}/commit`).set("Authorization", authorization).expect(201);
    expect(committedReplay.body.meta.idempotentReplay).toBe(true);
    const afterImport = await request(app.getHttpServer()).get("/public/v1/content-items?brandId=brand_default").set("Authorization", authorization).expect(200);
    const importedIds = new Set((afterImport.body.data as Array<{ id: string }>).filter((item) => item.id.startsWith("content_import_")).map((item) => item.id));
    expect(importedIds.size).toBe(100);
    const csvPreview = await request(app.getHttpServer()).post("/public/v1/imports/preview").set("Authorization", authorization).send({ format: "csv", brandId: "brand_default", data: "externalRef,title,summary,riskLevel\ncsv-001,CSV story,Quoted CSV intake,medium\ncsv-002,,Missing title,low" }).expect(201);
    expect(csvPreview.body.data.rows.map((row: { status: string }) => row.status)).toEqual(["valid", "invalid"]);
    const csvCommit = await request(app.getHttpServer()).post(`/public/v1/imports/${csvPreview.body.data.id}/commit`).set("Authorization", authorization).expect(201);
    expect(csvCommit.body.meta).toMatchObject({ created: 1, invalid: 1, failed: 0 });

    await request(app.getHttpServer()).post(`/v1/automation/keys/${createdKey.body.key.id}/revoke?workspaceId=default`).expect(201);
    await request(app.getHttpServer()).get("/public/v1/content-items").set("Authorization", authorization).expect(401);
  });

  it("creates isolated workspaces and brand-scoped content", async () => {
    const created = await request(app.getHttpServer()).post("/v1/workspaces").send({
      name: "Sports Desk", defaultBrandName: "Origin Sports", primaryLanguage: "English", timezone: "Asia/Kolkata",
    }).expect(201);
    expect(created.body.workspace).toMatchObject({ name: "Sports Desk", slug: "sports-desk" });
    expect(created.body.defaultBrand).toMatchObject({ workspaceId: created.body.workspace.id, name: "Origin Sports", timezone: "Asia/Kolkata" });

    const workspaces = await request(app.getHttpServer()).get("/v1/workspaces").expect(200);
    expect(workspaces.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.workspace.id, name: "Sports Desk" })]));

    const secondBrand = await request(app.getHttpServer()).post(`/v1/workspaces/${created.body.workspace.id}/brands`).send({
      name: "Match Room", primaryLanguage: "Hindi", timezone: "Asia/Kolkata",
    }).expect(201);
    const brands = await request(app.getHttpServer()).get(`/v1/workspaces/${created.body.workspace.id}/brands`).expect(200);
    expect(brands.body).toHaveLength(2);

    const content = await request(app.getHttpServer()).post("/v1/content-items").send({
      workspaceId: created.body.workspace.id, brandId: secondBrand.body.id, title: "Brand-scoped match update",
    }).expect(201);
    expect(content.body).toMatchObject({ workspaceId: created.body.workspace.id, brandId: secondBrand.body.id });

    const selected = await request(app.getHttpServer()).get(`/v1/content-items?workspaceId=${created.body.workspace.id}&brandId=${secondBrand.body.id}`).expect(200);
    expect(selected.body.map((item: { id: string }) => item.id)).toContain(content.body.id);
    const defaultBrand = await request(app.getHttpServer()).get(`/v1/content-items?workspaceId=${created.body.workspace.id}&brandId=${created.body.defaultBrand.id}`).expect(200);
    expect(defaultBrand.body).toEqual([]);
    const defaultWorkspace = await request(app.getHttpServer()).get("/v1/content-items?workspaceId=default").expect(200);
    expect(defaultWorkspace.body.map((item: { id: string }) => item.id)).not.toContain(content.body.id);

    const account = await request(app.getHttpServer()).post("/v1/channels/accounts").send({
      workspaceId: created.body.workspace.id,
      brandId: created.body.defaultBrand.id,
      platform: "instagram",
      displayName: "Origin Sports Instagram",
      externalAccountId: `sports-${created.body.workspace.id}`,
      capabilities: [],
    }).expect(201);
    const defaultBrandAccounts = await request(app.getHttpServer()).get(`/v1/channels/accounts?workspaceId=${created.body.workspace.id}&brandId=${created.body.defaultBrand.id}`).expect(200);
    expect(defaultBrandAccounts.body.map((entry: { id: string }) => entry.id)).toContain(account.body.id);
    const matchRoomAccounts = await request(app.getHttpServer()).get(`/v1/channels/accounts?workspaceId=${created.body.workspace.id}&brandId=${secondBrand.body.id}`).expect(200);
    expect(matchRoomAccounts.body).toEqual([]);

    const upload = await request(app.getHttpServer()).post("/v1/media-assets/uploads").send({
      workspaceId: created.body.workspace.id,
      brandId: secondBrand.body.id,
      contentItemId: content.body.id,
      kind: "image",
      purpose: "creative",
      fileName: "match-room.png",
      contentType: "image/png",
      sizeBytes: 1,
      sha256: "c".repeat(64),
      rights: "owned",
    }).expect(201);
    const matchRoomMedia = await request(app.getHttpServer()).get(`/v1/media-assets?workspaceId=${created.body.workspace.id}&brandId=${secondBrand.body.id}`).expect(200);
    expect(matchRoomMedia.body.map((entry: { id: string }) => entry.id)).toContain(upload.body.asset.id);
    const defaultBrandMedia = await request(app.getHttpServer()).get(`/v1/media-assets?workspaceId=${created.body.workspace.id}&brandId=${created.body.defaultBrand.id}`).expect(200);
    expect(defaultBrandMedia.body).toEqual([]);

    await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/sources?workspaceId=${created.body.workspace.id}`).send({ kind: "url", title: "Match source", url: "https://example.com/match", rights: "reference-only", confidence: 90 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/drafts?workspaceId=${created.body.workspace.id}`).send({ platform: "instagram", format: "image", title: "Match update", caption: "Verified match update", mediaIds: [] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/approvals?workspaceId=${created.body.workspace.id}`).send({ decision: "approved", draftId }).expect(201);
    const crossBrand = await request(app.getHttpServer()).post(`/v1/content-items/${content.body.id}/schedule?workspaceId=${created.body.workspace.id}`).set("If-Match", String(approved.body.version)).send({ platform: "instagram", accountId: account.body.id, draftId, scheduledFor: "2099-01-01T12:00:00.000Z", deliveryMode: "auto_publish" }).expect(409);
    expect(crossBrand.body.error).toBe("connected_account_brand_mismatch");

    await request(app.getHttpServer()).patch(`/v1/workspaces/${created.body.workspace.id}/brands/${secondBrand.body.id}`).send({ status: "archived" }).expect(200);
    const activeBrands = await request(app.getHttpServer()).get(`/v1/workspaces/${created.body.workspace.id}/brands`).expect(200);
    expect(activeBrands.body).toHaveLength(1);
    await request(app.getHttpServer()).patch(`/v1/workspaces/${created.body.workspace.id}/brands/${created.body.defaultBrand.id}`).send({ status: "archived" }).expect(409);
  });

  it("lists and reads deduplicated workspace notifications", async () => {
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const workspaceId = "notification-test";
    const first = createNotification({ workspaceId, kind: "publish_failed", severity: "error", title: "Instagram publish failed", body: "Open the item and retry after checking the account.", dedupeKey: "test:publish:failed:1", contentItemId: "item-test", targetId: "target-test", actionUrl: "/?module=Content&item=item-test" });
    await infrastructure.notificationRepository.create(first);
    await infrastructure.notificationRepository.create(createNotification({ workspaceId, kind: "publish_failed", severity: "error", title: "Duplicate", body: "This must not create a second alert.", dedupeKey: "test:publish:failed:1" }));
    await infrastructure.notificationRepository.create(createNotification({ workspaceId: "another-workspace", kind: "system", severity: "info", title: "Other workspace", body: "Hidden from the default workspace.", dedupeKey: "test:other:1" }));

    const summary = await request(app.getHttpServer()).get(`/v1/workspaces/${workspaceId}/notifications/summary`).expect(200);
    expect(summary.body).toEqual({ unread: 1 });
    const listed = await request(app.getHttpServer()).get(`/v1/workspaces/${workspaceId}/notifications?unreadOnly=true&limit=10`).expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id: first.id, severity: "error", targetId: "target-test" });

    await request(app.getHttpServer()).patch(`/v1/workspaces/another-workspace/notifications/${first.id}/read`).expect(404);
    const read = await request(app.getHttpServer()).patch(`/v1/workspaces/${workspaceId}/notifications/${first.id}/read`).expect(200);
    expect(read.body).toMatchObject({ id: first.id, readBy: "test-owner" });
    await request(app.getHttpServer()).post(`/v1/workspaces/${workspaceId}/notifications/read-all`).expect(201, { updated: 0 });
  });

  it("rejects unknown request fields", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/content-items")
      .send({ title: "Valid title", unexpected: "blocked" })
      .expect(400);

    expect(response.body.message).toContain("property unexpected should not exist");
  });

  it("diagnoses connected accounts without accepting raw credentials", async () => {
    await request(app.getHttpServer()).post("/v1/channels/accounts")
      .send({ workspaceId: "default", platform: "instagram", displayName: "Unsafe", externalAccountId: "unsafe-1", accessToken: "must-not-be-stored" })
      .expect(400);

    const blocked = await request(app.getHttpServer()).post("/v1/channels/accounts")
      .send({ workspaceId: "default", platform: "instagram", displayName: "Editorial Instagram", externalAccountId: "ig-editorial", capabilities: ["profile_read"] })
      .expect(201);
    expect(blocked.body).toMatchObject({ credentialConfigured: false, status: "setup_required", diagnostic: { readiness: "blocked" } });
    expect(blocked.body.credentialRef).toBeUndefined();
    expect(blocked.body.diagnostic.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "credentials", status: "fail" }), expect.objectContaining({ id: "permissions", status: "fail" })]));

    const updated = await request(app.getHttpServer()).patch(`/v1/channels/accounts/${blocked.body.id}?workspaceId=default`)
      .send({ credentialRef: "env:INSTAGRAM_EDITORIAL_CREDENTIAL", capabilities: ["profile_read", "media_publish"], expiresAt: "2099-01-01T00:00:00.000Z" })
      .expect(200);
    expect(updated.body).toMatchObject({ credentialConfigured: true, status: "healthy", diagnostic: { readiness: "warning" } });
    expect(updated.body.credentialRef).toBeUndefined();

    const otherWorkspace = await request(app.getHttpServer()).get("/v1/channels/accounts?workspaceId=another-workspace").expect(200);
    expect(otherWorkspace.body).toEqual([]);
  });

  it("connects Instagram through one-time OAuth state without exposing credentials", async () => {
    const status = await request(app.getHttpServer()).get("/v1/channels/oauth/status").expect(200);
    expect(status.body).toEqual({ instagram: { configured: true }, instagramFacebook:{configured:true,connectionMode:"facebook_login",legacyInstagramLoginSupported:false}, metaMessaging:{configured:false,connectionModes:["facebook_page_messenger","instagram_linked_page"],instagramLoginSupported:false}, facebook: { configured: true }, youtube: { configured: true } });

    const started = await request(app.getHttpServer()).post("/v1/channels/oauth/instagram/start").send({ workspaceId: "newsroom" }).expect(201);
    const authorization = new URL(started.body.authorizationUrl as string);
    expect(authorization.hostname).toBe("oauth.test.invalid");
    expect(authorization.searchParams.get("scope")).toContain("instagram_business_content_publish");
    const state = authorization.searchParams.get("state")!;

    const callback = await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram/callback?state=${encodeURIComponent(state)}&code=originpost-oauth-test-code`).expect(302);
    expect(callback.headers.location).toContain("channel=connected");
    expect(callback.headers.location).not.toContain("access_token");

    const newsroom = await request(app.getHttpServer()).get("/v1/channels/accounts?workspaceId=newsroom").expect(200);
    const account = newsroom.body.find((entry: { externalAccountId: string }) => entry.externalAccountId === "test-instagram-oauth");
    expect(account).toMatchObject({ displayName: "OAuth Test Instagram", credentialConfigured: true, capabilities: ["profile_read", "media_publish", "comment_read", "comment_reply"], diagnostic: { readiness: "warning" } });
    expect(JSON.stringify(account)).not.toContain("test-access-token-never-returned");
    expect(account.credentialRef).toBeUndefined();

    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const internal = (await infrastructure.connectedAccountRepository.list("newsroom")).find((entry) => entry.externalAccountId === "test-instagram-oauth")!;
    const secretId = internal.credentialRef!.slice(7);
    const encrypted = await infrastructure.oauthRepository.getCredential("newsroom", secretId);
    expect(encrypted).toMatchObject({ purpose: "provider-token", algorithm: "aes-256-gcm", keyVersion: "v1" });
    expect(encrypted?.ciphertext).not.toContain("test-access-token-never-returned");
    const decrypted = JSON.parse(await app.get(CredentialVaultService).open("newsroom", secretId)) as { accessToken: string; accountType: string };
    expect(decrypted.accessToken).toBe("test-access-token-never-returned");
    expect(decrypted.accountType).toBe("BUSINESS");
    await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram/callback?state=${encodeURIComponent(state)}&code=originpost-oauth-test-code`).expect(400);

    const refreshed = await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/refresh?workspaceId=newsroom`).expect(201);
    expect(refreshed.body).toMatchObject({ id: internal.id, status: "healthy", credentialConfigured: true, credentialManaged: true });
    expect(JSON.stringify(refreshed.body)).not.toContain("test-refreshed-access-token-never-returned");
    const rotated = await infrastructure.connectedAccountRepository.get("newsroom", internal.id);
    const rotatedSecretId = rotated!.credentialRef!.slice(7);
    expect(rotatedSecretId).not.toBe(secretId);
    await expect(infrastructure.oauthRepository.hasCredential("newsroom", secretId)).resolves.toBe(false);
    const refreshedPayload = JSON.parse(await app.get(CredentialVaultService).open("newsroom", rotatedSecretId)) as { accessToken: string; expiresAt: string; accountType: string };
    expect(refreshedPayload.accessToken).toBe("test-refreshed-access-token-never-returned");
    expect(refreshedPayload.expiresAt).toBe(refreshed.body.expiresAt);
    expect(refreshedPayload.accountType).toBe("BUSINESS");

    const disconnected=await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/disconnect?workspaceId=newsroom`).expect(201);
    expect(disconnected.body).toMatchObject({status:"disconnected",credentialConfigured:false,remoteGrantStatus:"provider_deauthorization_required"});
    await expect(infrastructure.oauthRepository.hasCredential("newsroom", rotatedSecretId)).resolves.toBe(false);
  });

  it("discovers Facebook Pages server-side and connects only the selected Pages", async () => {
    const started = await request(app.getHttpServer()).post("/v1/channels/oauth/facebook/start").send({ workspaceId: "newsroom" }).expect(201);
    const authorization = new URL(started.body.authorizationUrl as string);
    expect(authorization.hostname).toBe("oauth.test.invalid");
    expect(authorization.searchParams.get("scope")).toContain("pages_manage_posts");
    const state = authorization.searchParams.get("state")!;

    const callback = await request(app.getHttpServer()).get(`/v1/channels/oauth/facebook/callback?state=${encodeURIComponent(state)}&code=originpost-facebook-oauth-test-code`).expect(302);
    const redirect = new URL(callback.headers.location as string);
    expect(redirect.searchParams.get("channel")).toBe("select_facebook");
    const selectionId = redirect.searchParams.get("selectionId")!;
    expect(callback.headers.location).not.toContain("page-token");

    const selection = await request(app.getHttpServer()).get(`/v1/channels/oauth/facebook/selections/${selectionId}?workspaceId=newsroom`).expect(200);
    expect(selection.body.pages).toEqual([
      { externalAccountId: "test-facebook-page-1", displayName: "OAuth Test Facebook Page" },
      { externalAccountId: "test-facebook-page-2", displayName: "OAuth Test Community Page" },
    ]);
    expect(JSON.stringify(selection.body)).not.toContain("page-token");

    await request(app.getHttpServer()).post(`/v1/channels/oauth/facebook/selections/${selectionId}`).send({ workspaceId: "newsroom", pageIds: ["not-in-selection"] }).expect(400);

    const completed = await request(app.getHttpServer()).post(`/v1/channels/oauth/facebook/selections/${selectionId}`).send({ workspaceId: "newsroom", pageIds: ["test-facebook-page-2"] }).expect(201);
    expect(completed.body).toMatchObject({ connected: true, accounts: [{ platform: "facebook", externalAccountId: "test-facebook-page-2", credentialConfigured: true, credentialManaged: true }] });
    expect(JSON.stringify(completed.body)).not.toContain("page-token");
    await request(app.getHttpServer()).get(`/v1/channels/oauth/facebook/selections/${selectionId}?workspaceId=newsroom`).expect(400);
    await request(app.getHttpServer()).get(`/v1/channels/oauth/facebook/callback?state=${encodeURIComponent(state)}&code=originpost-facebook-oauth-test-code`).expect(400);

    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const facebookAccounts = (await infrastructure.connectedAccountRepository.list("newsroom")).filter((account) => account.platform === "facebook");
    expect(facebookAccounts).toHaveLength(1);
    const internal = facebookAccounts[0]!;
    const payload = JSON.parse(await app.get(CredentialVaultService).open("newsroom", internal.credentialRef!.slice(7))) as { provider: string; externalAccountId: string; accessToken: string };
    expect(payload).toMatchObject({ provider: "facebook", externalAccountId: "test-facebook-page-2", accessToken: "test-facebook-page-token-2-never-returned" });

    const refreshed = await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/refresh?workspaceId=newsroom`).expect(201);
    expect(refreshed.body).toMatchObject({ platform: "facebook", status: "healthy", credentialConfigured: true });
    const disconnected = await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/disconnect?workspaceId=newsroom`).expect(201);
    expect(disconnected.body).toMatchObject({ platform: "facebook", status: "disconnected", credentialConfigured: false,remoteGrantStatus:"provider_deauthorization_required" });
  });

  it("discovers Instagram professional accounts through a distinct Facebook Login selection",async()=>{
    const started=await request(app.getHttpServer()).post("/v1/channels/oauth/instagram-facebook/start").send({workspaceId:"newsroom"}).expect(201);
    expect(started.body).toMatchObject({connectionMode:"facebook_login"});const authorization=new URL(started.body.authorizationUrl as string);expect(authorization.hostname).toBe("oauth.test.invalid");expect(authorization.searchParams.get("scope")).toContain("instagram_content_publish");expect(authorization.searchParams.get("scope")).toContain("instagram_manage_contents");const state=authorization.searchParams.get("state")!;expect(state).toMatch(/^igfb_/);
    await request(app.getHttpServer()).get(`/v1/channels/oauth/facebook/callback?state=${encodeURIComponent(state)}&code=originpost-instagram-facebook-oauth-test-code`).expect(400);
    const callback=await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram-facebook/callback?state=${encodeURIComponent(state)}&code=originpost-instagram-facebook-oauth-test-code`).expect(302);const redirect=new URL(callback.headers.location as string);expect(redirect.searchParams.get("channel")).toBe("select_instagram");const selectionId=redirect.searchParams.get("selectionId")!;expect(callback.headers.location).not.toContain("token");
    const selection=await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram-facebook/selections/${selectionId}?workspaceId=newsroom`).expect(200);expect(selection.body).toEqual({selectionId,expiresAt:expect.any(String),connectionMode:"facebook_login",accounts:[{externalAccountId:"test-instagram-facebook-1",username:"originpost.test",displayName:"@originpost.test",pageId:"test-facebook-page-1",pageName:"OAuth Test Facebook Page"},{externalAccountId:"test-instagram-facebook-2",username:"originpost.community",displayName:"@originpost.community",pageId:"test-facebook-page-2",pageName:"OAuth Test Community Page"}]});expect(JSON.stringify(selection.body)).not.toContain("page-token");
    await request(app.getHttpServer()).post(`/v1/channels/oauth/instagram-facebook/selections/${selectionId}`).send({workspaceId:"newsroom",instagramAccountIds:["not-in-selection"]}).expect(400);
    const completions=await Promise.all([request(app.getHttpServer()).post(`/v1/channels/oauth/instagram-facebook/selections/${selectionId}`).send({workspaceId:"newsroom",instagramAccountIds:["test-instagram-facebook-2"]}),request(app.getHttpServer()).post(`/v1/channels/oauth/instagram-facebook/selections/${selectionId}`).send({workspaceId:"newsroom",instagramAccountIds:["test-instagram-facebook-2"]})]);expect(completions.filter((value)=>value.status===201)).toHaveLength(1);expect(completions.filter((value)=>value.status===400||value.status===409)).toHaveLength(1);const completed=completions.find((value)=>value.status===201)!;expect(completed.body).toMatchObject({connected:true,connectionMode:"facebook_login",accounts:[{platform:"instagram",externalAccountId:"test-instagram-facebook-2",displayName:"@originpost.community",credentialConfigured:true,credentialManaged:true,capabilities:["profile_read","media_publish","comment_read","comment_reply","collaborator_publish","collaborator_status_read"]}]});expect(JSON.stringify(completed.body)).not.toContain("page-token");
    const infrastructure=app.get<OriginPostInfrastructure>(INFRASTRUCTURE);const internal=(await infrastructure.connectedAccountRepository.list("newsroom")).find((account)=>account.externalAccountId==="test-instagram-facebook-2")!;const payload=JSON.parse(await app.get(CredentialVaultService).open("newsroom",internal.credentialRef!.slice(7))) as Record<string,unknown>;expect(payload).toMatchObject({provider:"instagram",connectionMode:"facebook_login",accountType:"BUSINESS",externalAccountId:"test-instagram-facebook-2",canonicalUsername:"originpost.community",endpointFamily:"instagram_api_with_facebook_login",providerVersion:"v26.0",pageId:"test-facebook-page-2",accessToken:"test-instagram-facebook-page-token-2-never-returned",accountVersion:internal.updatedAt});expect(payload.grantedScopes).toEqual([...payload.grantedScopes as string[]].sort());expect(payload.appVersion).toMatch(/^[a-f0-9]{64}$/);expect(payload.providerAccountVersion).toMatch(/^[a-f0-9]{64}$/);await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/refresh?workspaceId=newsroom`).expect(409);
    await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram-facebook/selections/${selectionId}?workspaceId=newsroom`).expect(400);await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram-facebook/callback?state=${encodeURIComponent(state)}&code=originpost-instagram-facebook-oauth-test-code`).expect(400);
  });

  it("connects YouTube with offline access and keeps refresh credentials server-side", async () => {
    const started = await request(app.getHttpServer()).post("/v1/channels/oauth/youtube/start").send({ workspaceId: "newsroom" }).expect(201);
    const authorization = new URL(started.body.authorizationUrl as string);
    expect(authorization.hostname).toBe("oauth.test.invalid");
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("scope")).toContain("youtube.upload");
    expect(authorization.searchParams.get("prompt")).toBe("consent");
    const state = authorization.searchParams.get("state")!;
    const callback = await request(app.getHttpServer()).get(`/v1/channels/oauth/youtube/callback?state=${encodeURIComponent(state)}&code=originpost-youtube-oauth-test-code`).expect(302);
    expect(callback.headers.location).toContain("channel=connected");
    expect(callback.headers.location).not.toContain("access_token");

    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const internal = (await infrastructure.connectedAccountRepository.list("newsroom")).find((entry) => entry.externalAccountId === "test-youtube-channel")!;
    expect(internal).toMatchObject({ platform: "youtube", capabilities: ["channel_read", "video_upload"], status: "healthy" });
    const secretId = internal.credentialRef!.slice(7);
    const decrypted = JSON.parse(await app.get(CredentialVaultService).open("newsroom", secretId)) as { accessToken: string; refreshToken: string; provider: string };
    expect(decrypted).toMatchObject({ provider: "youtube", accessToken: "test-youtube-access-token-never-returned", refreshToken: "test-youtube-refresh-token-never-returned" });

    const refreshed = await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/refresh?workspaceId=newsroom`).expect(201);
    expect(refreshed.body).toMatchObject({ id: internal.id, platform: "youtube", status: "healthy", credentialConfigured: true });
    const rotated = await infrastructure.connectedAccountRepository.get("newsroom", internal.id);
    const rotatedPayload = JSON.parse(await app.get(CredentialVaultService).open("newsroom", rotated!.credentialRef!.slice(7))) as { accessToken: string; refreshToken: string };
    expect(rotatedPayload.accessToken).toBe("test-youtube-refreshed-access-token-never-returned");
    expect(rotatedPayload.refreshToken).toBe("test-youtube-refresh-token-never-returned");
    await request(app.getHttpServer()).get(`/v1/channels/oauth/youtube/callback?state=${encodeURIComponent(state)}&code=originpost-youtube-oauth-test-code`).expect(400);
    const rotatedSecretId = rotated!.credentialRef!.slice(7);
    const disconnected = await request(app.getHttpServer()).post(`/v1/channels/accounts/${internal.id}/disconnect?workspaceId=newsroom`).expect(201);
    expect(disconnected.body).toMatchObject({ displayName: "Disconnected YouTube channel", externalAccountId: `revoked:${internal.id}`, status: "disconnected", credentialConfigured: false,remoteGrantStatus:"revoked" });
    await expect(infrastructure.oauthRepository.hasCredential("newsroom", rotatedSecretId)).resolves.toBe(false);
  });

  it("consumes denied OAuth state and will not replay it", async () => {
    const started = await request(app.getHttpServer()).post("/v1/channels/oauth/instagram/start").send({ workspaceId: "default" }).expect(201);
    const state = new URL(started.body.authorizationUrl as string).searchParams.get("state")!;
    const denied = await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram/callback?state=${encodeURIComponent(state)}&error=access_denied`).expect(302);
    expect(denied.headers.location).toContain("reason=provider_denied");
    await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram/callback?state=${encodeURIComponent(state)}&error=access_denied`).expect(400);
  });

  it("keeps the old encrypted credential when Instagram refresh fails", async () => {
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const vault = app.get(CredentialVaultService);
    const now = new Date().toISOString();
    const secret = vault.seal("newsroom", "provider-token", JSON.stringify({ accessToken: "provider-rejected-token", tokenType: "bearer", provider: "instagram", externalAccountId: "refresh-failure" }), now);
    const account = {
      id: "account-refresh-failure", workspaceId: "newsroom", brandId: "brand_newsroom", platform: "instagram" as const, displayName: "Refresh failure",
      externalAccountId: "refresh-failure", credentialRef: `secret:${secret.id}`, capabilities: ["profile_read", "media_publish"] as const,
      status: "healthy" as const, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdBy: "test-owner", createdAt: now, updatedAt: now,
    };
    await infrastructure.connectedAccountRepository.save(account, { id: "audit-refresh-failure-setup", workspaceId: "newsroom", actorId: "test-owner", actorType: "human", action: "test.account-created", detail: {}, createdAt: now }, { save: secret });

    const failed = await request(app.getHttpServer()).post(`/v1/channels/accounts/${account.id}/refresh?workspaceId=newsroom`).expect(502);
    expect(failed.body.message).toContain("Reconnect");
    const saved = await infrastructure.connectedAccountRepository.get("newsroom", account.id);
    expect(saved).toMatchObject({ status: "refresh_failed", credentialRef: `secret:${secret.id}`, lastErrorCode: "token_refresh" });
    await expect(infrastructure.oauthRepository.hasCredential("newsroom", secret.id)).resolves.toBe(true);
  });

  it("keeps workspace reads isolated", async () => {
    const newsroom = await request(app.getHttpServer()).get("/v1/content-items?workspaceId=newsroom").expect(200);
    const another = await request(app.getHttpServer()).get("/v1/content-items?workspaceId=another-workspace").expect(200);
    expect(newsroom.body.some((item: { title: string }) => item.title === "A source-backed update")).toBe(true);
    expect(another.body.some((item: { title: string }) => item.title === "A source-backed update")).toBe(false);
  });

  it("rejects stale If-Match content commands with a refreshable conflict", async () => {
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Optimistic API test" }).expect(201);
    expect(created.body.version).toBe(1);

    const first = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .set("if-match", "1")
      .send({ kind: "url", title: "First source", url: "https://example.com/optimistic-first", rights: "reference-only", confidence: 95 }).expect(201);
    expect(first.body).toMatchObject({ version: 2, sources: [expect.objectContaining({ title: "First source" })] });

    const stale = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .set("if-match", "1")
      .send({ kind: "url", title: "Stale source", url: "https://example.com/optimistic-stale", rights: "reference-only", confidence: 95 }).expect(409);
    expect(stale.body).toMatchObject({ error: "content_version_conflict", message: "This content changed while you were working. Refresh it and try again." });

    const saved = await request(app.getHttpServer()).get(`/v1/content-items/${created.body.id}?workspaceId=default`).expect(200);
    expect(saved.body).toMatchObject({ version: 2, sources: [expect.objectContaining({ title: "First source" })] });
  });

  it("commits a scheduled publish command to the durable outbox", async () => {
    const mediaId = await readyMedia("image", "image/png", "c");
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Durable schedule test" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .send({ kind: "url", title: "Official source", url: "https://example.com/source", rights: "reference-only", confidence: 100 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "instagram", format: "image", title: "Durable schedule test", caption: "Checked caption", mediaIds: [mediaId] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const comment = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/review-comments`)
      .send({ draftId, audience: "internal", body: "Check the final caption before publishing." }).expect(201);
    expect(comment.body.reviewComments.at(-1)).toMatchObject({ draftId, audience: "internal", authorId: "test-owner" });
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`)
      .send({ decision: "approved", draftId }).expect(201);
    const scheduleBody = { platform: "instagram", accountId: connectedInstagramAccountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z" };
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, scheduleBody)).expect(201);

    const outbox = await request(app.getHttpServer()).get("/v1/operations/outbox").expect(200);
    expect(outbox.body).toMatchObject({ pending: 1, processing: 0, failed: 0 });
  });

  it("keeps Facebook Page analytics disabled until the reviewed provider gate is enabled", async () => {
    const response = await request(app.getHttpServer()).get("/v1/connectors").expect(200);
    const facebook = response.body.find((entry: { platform: string }) => entry.platform === "facebook");
    expect(facebook).toMatchObject({
      platform: "facebook",
      capabilities: { formats: ["text", "image"], analytics: false, pendingPublishing: false },
    });
  });

  it("exposes validated plugin metadata without loading plugin code or server paths", async () => {
    const response = await request(app.getHttpServer()).get("/v1/plugins/catalog").expect(200);
    expect(response.body).toMatchObject({
      configured: true,
      entries: [expect.objectContaining({ id: "org.originpost.example-signal-monitor", status: "available" })],
      rejected: [],
    });
    expect(JSON.stringify(response.body)).not.toContain(process.cwd());
  });

  it("schedules a checked Facebook text post and rejects unsupported Page drafts", async () => {
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Facebook Page release check" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .send({ kind: "url", title: "Official source", url: "https://example.com/facebook-source", rights: "reference-only", confidence: 100 }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "facebook", format: "carousel", title: "Unsupported", caption: "This must not be accepted.", mediaIds: [] }).expect(400);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "facebook", format: "image", title: "Missing image", caption: "This must not be accepted.", mediaIds: [] }).expect(400);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "facebook", format: "text", title: "Facebook Page release check", caption: "A source-checked Page update.", mediaIds: [] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`)
      .send({ decision: "approved", draftId }).expect(201);
    const scheduleBody = { platform: "facebook", accountId: connectedFacebookAccountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z" };
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, scheduleBody)).expect(201);
    expect(scheduled.body.targets.at(-1)).toMatchObject({ platform: "facebook", status: "queued", deliveryMode: "auto_publish" });
  });

  it("reschedules and cancels a waiting calendar target with workspace time zone", async () => {
    const mediaId = await readyMedia("image", "image/png", "c");
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Calendar workflow" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .send({ kind: "url", title: "Official source", url: "https://example.com/calendar-workflow", rights: "reference-only", confidence: 100 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "instagram", format: "image", title: "Calendar workflow", caption: "Checked calendar caption", mediaIds: [mediaId] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    const approved = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`)
      .send({ decision: "approved", draftId }).expect(201);
    const scheduleBody = { platform: "instagram", accountId: connectedInstagramAccountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z", timezone: "Asia/Kolkata" };
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .set("if-match", String(approved.body.version))
      .send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, scheduleBody, approved.body.version)).expect(201);
    const original = scheduled.body.targets.at(-1);
    expect(original).toMatchObject({ status: "queued", timezone: "Asia/Kolkata" });

    await request(app.getHttpServer()).patch(`/v1/content-items/${created.body.id}/targets/${original.id}/reschedule`)
      .set("if-match", String(scheduled.body.version))
      .send({ scheduledFor: "2099-01-02T15:30:00.000Z", timezone: "Europe/London" }).expect(200);
    const refreshed = await request(app.getHttpServer()).get(`/v1/content-items/${created.body.id}?workspaceId=default`).expect(200);
    expect(refreshed.body.targets.find((target: { id: string }) => target.id === original.id)).toMatchObject({ status: "cancelled" });
    const replacement = refreshed.body.targets.at(-1);
    expect(replacement).toMatchObject({ status: "queued", scheduledFor: "2099-01-02T15:30:00.000Z", timezone: "Europe/London" });

    const cancelled = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/targets/${replacement.id}/cancel`)
      .set("if-match", String(refreshed.body.version)).expect(201);
    expect(cancelled.body).toMatchObject({ status: "approved" });
    expect(cancelled.body.targets.at(-1)).toMatchObject({ status: "cancelled" });

    const audit = await request(app.getHttpServer()).get(`/v1/content-items/${created.body.id}/audit?workspaceId=default`).expect(200);
    expect(audit.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "publish.rescheduled", detail: expect.objectContaining({ previousTargetId: original.id, targetId: replacement.id, timezone: "Europe/London" }) }),
      expect.objectContaining({ action: "publish.cancelled", detail: expect.objectContaining({ targetId: replacement.id }) }),
    ]));
  });

  it("stores approved YouTube settings and fails closed for non-private publishing", async () => {
    const mediaId = await readyMedia("video", "video/mp4", "f");
    const title = "A checked YouTube Short";
    const description = "This description was approved with the video.";
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .send({ kind: "url", title: "Official source", url: "https://example.com/youtube-short", rights: "reference-only", confidence: 100 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "youtube", format: "short", title, caption: description, mediaIds: [mediaId] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`)
      .send({ decision: "approved", draftId }).expect(201);

    const base = {
      platform: "youtube",
      accountId: connectedYoutubeAccountId,
      draftId,
      scheduledFor: "2099-01-01T12:00:00.000Z",
    };
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send({ ...base, settings: { title, description } }).expect(400);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send({ ...base, settings: { title: "Changed after approval", description, madeForKids: false, containsSyntheticMedia: false } }).expect(409);
    const blocked = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send({ ...base, settings: { title, description, privacyStatus: "unlisted", madeForKids: false, containsSyntheticMedia: false } }).expect(409);
    expect(blocked.body).toMatchObject({ error: "youtube_non_private_gate_required" });

    const privateBody = { ...base, settings: { title, description, madeForKids: false, containsSyntheticMedia: true, timezone: "Asia/Kolkata" } };
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, privateBody)).expect(201);
    expect(scheduled.body.targets.at(-1)).toMatchObject({
      platform: "youtube",
      settings: { title, description, privacyStatus: "private", madeForKids: false, containsSyntheticMedia: true, notifySubscribers: false, timezone: "Asia/Kolkata" },
    });

    const audit = await request(app.getHttpServer()).get(`/v1/content-items/${created.body.id}/audit?workspaceId=default`).expect(200);
    expect(audit.body).toEqual(expect.arrayContaining([expect.objectContaining({
      action: "publish.scheduled",
      detail: expect.objectContaining({ privacyStatus: "private", madeForKids: false, containsSyntheticMedia: true, notifySubscribers: false, timezone: "Asia/Kolkata" }),
    })]));

    const previousGate = process.env.YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING;
    const previousAudit = process.env.YOUTUBE_API_COMPLIANCE_AUDITED;
    process.env.YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING = "true";
    process.env.YOUTUBE_API_COMPLIANCE_AUDITED = "true";
    try {
      const nonPrivateBody = { ...base, settings: { title, description, privacyStatus: "unlisted", madeForKids: false, containsSyntheticMedia: true } };
      const reviewedNonPrivate = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
        .send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, nonPrivateBody)).expect(201);
      expect(reviewedNonPrivate.body.targets.at(-1).settings.privacyStatus).toBe("unlisted");
    } finally {
      if (previousGate === undefined) delete process.env.YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING;
      else process.env.YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING = previousGate;
      if (previousAudit === undefined) delete process.env.YOUTUBE_API_COMPLIANCE_AUDITED;
      else process.env.YOUTUBE_API_COMPLIANCE_AUDITED = previousAudit;
    }
  });

  it("recovers an uncertain Instagram result with atomic proof", async () => {
    const mediaId = await readyMedia("image", "image/png", "e");
    const created = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", title: "Provider recovery API test" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`).send({ kind: "url", title: "Official source", url: "https://example.com/recovery", rights: "reference-only", confidence: 100 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`).send({ platform: "instagram", format: "image", title: "Provider recovery API test", caption: "Checked recovery caption", mediaIds: [mediaId] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    const scheduleBody = { platform: "instagram", accountId: connectedInstagramAccountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z", deliveryMode: "auto_publish" };
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`).send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, scheduleBody)).expect(201);
    const targetId = scheduled.body.targets.at(-1).id as string;
    const actor: Actor = { id: "originpost-worker", name: "OriginPost Worker", role: "owner" };
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const started = startPublishAttempt(scheduled.body, targetId, `publish:${targetId}:v1`, actor, "job-recovery");
    await infrastructure.repository.commit(started.item, started.event);
    const waiting = markTargetStatus(started.item, targetId, "action_required", actor, { reason: "provider_result_uncertain" });
    await infrastructure.repository.commit(waiting.item, waiting.event);
    const operation: ProviderPublishOperation = { id: "provider-operation-api-test", workspaceId: "default", contentItemId: created.body.id, targetId, attemptId: started.attempt.id, platform: "instagram", status: "uncertain", containerId: "container-recovery", childContainerIds: [], lastError: "Provider response timed out.", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await infrastructure.providerPublishOperationRepository.save(operation);

    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/targets/${targetId}/provider-confirm`)
      .set("if-match", String(waiting.item.version))
      .send({ externalPostId: "ig-recovered-1", liveUrl: "https://example.com/not-instagram", publishedAt: "2026-08-29T00:00:00.000Z", disclosure: "none" }).expect(400);
    const recovered = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/targets/${targetId}/provider-confirm`)
      .set("if-match", String(waiting.item.version))
      .send({ externalPostId: "ig-recovered-1", liveUrl: "https://www.instagram.com/p/recovered/", publishedAt: "2026-08-29T00:00:00.000Z", disclosure: "none" }).expect(201);
    expect(recovered.body).toMatchObject({ status: "published", targets: [expect.objectContaining({ id: targetId, status: "published" })], proofs: [expect.objectContaining({ externalPostId: "ig-recovered-1", liveUrl: "https://www.instagram.com/p/recovered/" })] });
    expect(recovered.body.publishAttempts.find((entry: { id: string }) => entry.id === started.attempt.id)).toMatchObject({ status: "published", externalPostId: "ig-recovered-1" });
    await expect(infrastructure.providerPublishOperationRepository.get("default", targetId)).resolves.toMatchObject({ status: "published", externalPostId: "ig-recovered-1" });
  });

  it("blocks a platform-invalid draft before it reaches the outbox", async () => {
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Invalid Instagram media preflight" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .send({ kind: "url", title: "Source", url: "https://example.com/preflight", rights: "reference-only", confidence: 90 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "instagram", format: "image", title: "Missing image", caption: "This should not queue.", mediaIds: [] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    const missingAccount = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send({ platform: "instagram", accountId: "not-connected", draftId, scheduledFor: "2099-01-01T12:00:00.000Z" }).expect(409);
    expect(missingAccount.body.message).toContain("Connect and check");
    const blocked = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send({ platform: "instagram", accountId: connectedInstagramAccountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z" }).expect(409);
    expect(blocked.body.message).toContain("exactly one image");
  });

  it("creates, verifies, and isolates a private media asset", async () => {
    const upload = await request(app.getHttpServer()).post("/v1/media-assets/uploads")
      .send({
        workspaceId: "newsroom",
        kind: "image",
        purpose: "evidence",
        fileName: "../checked photo.png",
        contentType: "image/png",
        sizeBytes: 68,
        sha256: "a".repeat(64),
        rights: "reference-only",
        sourceUrl: "https://example.com/source-image",
      }).expect(201);

    expect(upload.body.asset).toMatchObject({ workspaceId: "newsroom", fileName: "checked photo.png", status: "pending", version: 1, sha256: "a".repeat(64), malwareScanStatus: "pending" });
    expect(new Date(upload.body.asset.uploadExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(upload.body.asset.objectKey).toBeUndefined();
    expect(upload.body.upload.url).toContain("upload.invalid");

    const completed = await request(app.getHttpServer()).post(`/v1/media-assets/${upload.body.asset.id}/complete`)
      .send({ workspaceId: "newsroom" }).expect(200);
    expect(completed.body).toMatchObject({ status: "ready", version: 2, malwareScanStatus: "disabled", malwareScanner: "originpost/disabled-v1" });

    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const finalized = await infrastructure.mediaRepository.get("newsroom", upload.body.asset.id as string);
    expect(finalized?.objectKey).toContain(`/${upload.body.asset.id}/checked photo.png.final-`);
    expect(finalized?.objectKey.endsWith(`.final-${"a".repeat(64)}`)).toBe(true);

    const newsroom = await request(app.getHttpServer()).get("/v1/media-assets?workspaceId=newsroom").expect(200);
    const other = await request(app.getHttpServer()).get("/v1/media-assets?workspaceId=another-workspace").expect(200);
    expect(newsroom.body).toHaveLength(1);
    expect(other.body).toHaveLength(0);
  });

  it("moves unused media through Trash and blocks media used by a draft", async () => {
    const mediaId = await readyMedia("image", "image/png", "b");
    const before = await request(app.getHttpServer()).get("/v1/media-assets?workspaceId=default").expect(200);
    const ready = (before.body as Array<{ id: string; version: number; status: string }>).find((asset) => asset.id === mediaId);
    expect(ready).toMatchObject({ version: 2, status: "ready" });

    const summary = await request(app.getHttpServer()).get("/v1/media-assets/summary?workspaceId=default").expect(200);
    expect(summary.body.counts.ready).toBeGreaterThanOrEqual(1);
    expect(summary.body.storedBytes).toBeGreaterThanOrEqual(1);

    const trashed = await request(app.getHttpServer()).post(`/v1/media-assets/${mediaId}/trash`)
      .send({ workspaceId: "default", version: ready!.version }).expect(200);
    expect(trashed.body).toMatchObject({ status: "trashed", statusBeforeTrash: "ready", version: 3 });
    expect(new Date(trashed.body.trashExpiresAt).getTime()).toBeGreaterThan(Date.now());

    await request(app.getHttpServer()).post(`/v1/media-assets/${mediaId}/restore`)
      .send({ workspaceId: "default", version: 2 }).expect(409);
    const restored = await request(app.getHttpServer()).post(`/v1/media-assets/${mediaId}/restore`)
      .send({ workspaceId: "default", version: 3 }).expect(200);
    expect(restored.body).toMatchObject({ status: "ready", version: 4 });

    const item = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Media lifecycle reference" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${item.body.id}/drafts`)
      .send({ platform: "instagram", format: "image", title: "Referenced image", caption: "Keep this file connected.", mediaIds: [mediaId] }).expect(201);
    const blocked = await request(app.getHttpServer()).post(`/v1/media-assets/${mediaId}/trash`)
      .send({ workspaceId: "default", version: 4 }).expect(409);
    expect(blocked.body.message).toContain("used by content");
  });

  it("cleans an expired unfinished upload without deleting its audit record", async () => {
    const upload = await request(app.getHttpServer()).post("/v1/media-assets/uploads").send({
      workspaceId: "newsroom", kind: "image", purpose: "creative", fileName: "abandoned.png",
      contentType: "image/png", sizeBytes: 1, sha256: "9".repeat(64), rights: "owned",
    }).expect(201);
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const pending = await infrastructure.mediaRepository.get("newsroom", upload.body.asset.id as string);
    expect(pending).not.toBeNull();
    const expired = { ...pending!, version: pending!.version + 1, uploadExpiresAt: "2000-01-01T00:00:00.000Z" };
    await infrastructure.mediaRepository.save(expired, {
      id: `audit_${crypto.randomUUID()}`, workspaceId: "newsroom", actorId: "test-owner", actorType: "human",
      action: "media.test-expired", detail: { mediaAssetId: expired.id }, createdAt: new Date().toISOString(),
    });

    const cleanup = await request(app.getHttpServer()).post("/v1/media-assets/cleanup").send({ workspaceId: "newsroom" }).expect(201);
    expect(cleanup.body).toMatchObject({ checked: 1, expired: 1, failed: 0 });
    const tombstone = await infrastructure.mediaRepository.get("newsroom", expired.id);
    expect(tombstone).toMatchObject({ status: "expired", version: 3, cleanupReason: "upload-expired" });
  });

  it("serves one verified private asset through a signed provider delivery link", async () => {
    const mediaId = await readyMedia("image", "image/png", "e");
    const token = createMediaDeliveryToken({ workspaceId: "default", mediaId, sha256: "e".repeat(64), expiresAt: Date.now() + 60_000 }, process.env.MEDIA_DELIVERY_SECRET!);
    const delivered = await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(token)}`).expect(200);
    expect(delivered.headers["cache-control"]).toBe("private, no-store");
    expect(delivered.headers["accept-ranges"]).toBe("bytes");
    expect(delivered.headers["content-disposition"]).toContain("inline");
    const bounded = await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(token)}`).set("Range", "bytes=0-0").expect(206);
    expect(bounded.headers).toMatchObject({ "accept-ranges": "bytes", "content-range": "bytes 0-0/1", "content-length": "1" });
    const openEnded = await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(token)}`).set("Range", "bytes=0-").expect(206);
    expect(openEnded.headers["content-range"]).toBe("bytes 0-0/1");
    const multiple = await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(token)}`).set("Range", "bytes=0-0,1-1").expect(416);
    expect(multiple.headers).toMatchObject({ "accept-ranges": "bytes", "content-range": "bytes */1" });
    await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(token)}`).set("Range", "bytes=-1").expect(416);
    await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(token)}`).set("Range", "bytes=1-").expect(416);
    await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(`${token.slice(0, -1)}x`)}`).set("Range", "bytes=0-0,1-1").expect(404);
    const wrongHash = createMediaDeliveryToken({ workspaceId: "default", mediaId, sha256: "f".repeat(64), expiresAt: Date.now() + 60_000 }, process.env.MEDIA_DELIVERY_SECRET!);
    await request(app.getHttpServer()).get(`/v1/media-assets/delivery/${encodeURIComponent(wrongHash)}`).expect(404);
  });

  it("acknowledges and confirms a manual Instagram handoff", async () => {
    const mediaId = await readyMedia("video", "video/mp4", "d");
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Manual handoff API test" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/sources`)
      .send({ kind: "url", title: "Official source", url: "https://example.com/manual-source", rights: "reference-only", confidence: 100 }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "instagram", format: "reel", title: "Manual handoff API test", caption: "Checked manual caption", mediaIds: [mediaId] }).expect(201);
    const draftId = drafted.body.drafts.at(-1).id as string;
    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/approvals`).send({ decision: "approved", draftId }).expect(201);
    const scheduleBody = { platform: "instagram", accountId: connectedInstagramAccountId, draftId, scheduledFor: "2099-01-01T12:00:00.000Z", deliveryMode: "manual_handoff" };
    const scheduled = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/schedule`)
      .send(await withCurrentScheduleConflictAcknowledgement(app, created.body.id, scheduleBody)).expect(201);
    const targetId = scheduled.body.targets.at(-1).id as string;
    expect(scheduled.body.targets.at(-1)).toMatchObject({ deliveryMode: "manual_handoff", status: "queued" });

    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const item = await infrastructure.repository.get("default", created.body.id as string);
    const actor: Actor = { id: "worker", name: "Worker", role: "owner" };
    const due = markTargetStatus(item!, targetId, "action_required", actor);
    await infrastructure.repository.commit(due.item, due.event);

    const acknowledged = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/targets/${targetId}/acknowledge`).expect(201);
    expect(acknowledged.body.targets.at(-1)).toMatchObject({ status: "acknowledged", acknowledgedBy: "test-owner" });

    const publishedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const confirmed = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/targets/${targetId}/manual-confirm`)
      .send({ externalPostId: "instagram-123", liveUrl: "https://www.instagram.com/p/example/", publishedAt, disclosure: "none" }).expect(201);
    expect(confirmed.body).toMatchObject({ status: "published" });
    expect(confirmed.body.targets.at(-1)).toMatchObject({ status: "published" });
    expect(confirmed.body.proofs.at(-1)).toMatchObject({ externalPostId: "instagram-123", draftId });

    const proof = confirmed.body.proofs.at(-1) as { id: string };
    const firstCapturedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const secondCapturedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await infrastructure.analyticsRepository.save({
      id: "analytics-manual-first", workspaceId: "default", brandId: confirmed.body.brandId, contentItemId: created.body.id,
      proofId: proof.id, platform: "instagram", accountId: connectedInstagramAccountId, externalPostId: "instagram-123", status: "ready", period: "lifetime",
      metrics: [{ key: "views", value: 100, unit: "count", rawMetric: "views", source: "instagram_media_insights", coverage: "instagram_only" }],
      rawPayloadSha256: "1".repeat(64), provider: "instagram-official", capturedAt: firstCapturedAt, createdAt: firstCapturedAt,
    }, { id: "audit-analytics-manual-first", workspaceId: "default", contentItemId: created.body.id, actorId: "originpost-worker", actorType: "system", action: "analytics.snapshot-captured", detail: { proofId: proof.id }, createdAt: firstCapturedAt });
    await infrastructure.analyticsRepository.save({
      id: "analytics-manual-second", workspaceId: "default", brandId: confirmed.body.brandId, contentItemId: created.body.id,
      proofId: proof.id, platform: "instagram", accountId: connectedInstagramAccountId, externalPostId: "instagram-123", status: "ready", period: "lifetime",
      metrics: [{ key: "views", value: 150, unit: "count", rawMetric: "views", source: "instagram_media_insights", coverage: "instagram_only" }],
      rawPayloadSha256: "2".repeat(64), provider: "instagram-official", caveats: ["Instagram can delay media insights."], capturedAt: secondCapturedAt, createdAt: secondCapturedAt,
    }, { id: "audit-analytics-manual-second", workspaceId: "default", contentItemId: created.body.id, actorId: "originpost-worker", actorType: "system", action: "analytics.snapshot-captured", detail: { proofId: proof.id }, createdAt: secondCapturedAt });

    const analytics = await request(app.getHttpServer()).get(`/v1/analytics?workspaceId=default&brandId=${confirmed.body.brandId}`).expect(200);
    const measured = analytics.body.posts.find((entry: { proofId: string }) => entry.proofId === proof.id);
    expect(measured).toMatchObject({ contentItemId: created.body.id, status: "ready", metrics: [expect.objectContaining({ key: "views", value: 150 })], trends: [expect.objectContaining({ key: "views", absoluteChange: 50, percentChange: 50 })] });
    const accountSummary = analytics.body.accountSummaries.find((entry: { accountId: string }) => entry.accountId === connectedInstagramAccountId);
    expect(accountSummary.metrics.views).toBe(150);
    expect(accountSummary.metrics.reach).toBeNull();
    await request(app.getHttpServer()).post(`/v1/analytics/content-items/${created.body.id}/proofs/${proof.id}/refresh?workspaceId=default`).expect(503);

    const candidates = await request(app.getHttpServer()).get(`/v1/evergreen/candidates?workspaceId=default&brandId=${confirmed.body.brandId}`).expect(200);
    expect(candidates.body).toContainEqual(expect.objectContaining({ contentItemId: created.body.id, proofId: proof.id, metricLabel: "views", metricValue: 150, autoEligible: false }));
    const firstPublishAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const endAt = new Date(Date.now() + 120 * 24 * 60 * 60_000).toISOString();
    const evergreen = await request(app.getHttpServer()).post("/v1/evergreen").send({ workspaceId: "default", brandId: confirmed.body.brandId, sourceContentItemId: created.body.id, sourceProofId: proof.id, name: "Manual handoff refresh", mode: "review_first", intervalDays: 30, timezone: "UTC", firstPublishAt, endAt, maxOccurrences: 3 }).expect(201);
    expect(evergreen.body).toMatchObject({ sourceProofId: proof.id, mode: "review_first", status: "active", maxOccurrences: 3 });
    await request(app.getHttpServer()).post(`/v1/evergreen/${evergreen.body.id}/pause?workspaceId=default`).set("If-Match", String(evergreen.body.version)).expect(201);
    const list = await request(app.getHttpServer()).get(`/v1/evergreen?workspaceId=default&brandId=${confirmed.body.brandId}`).expect(200);
    expect(list.body).toContainEqual(expect.objectContaining({ id: evergreen.body.id, status: "paused" }));
  });

  it("shares one signed draft revision with an external reviewer", async () => {
    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .send({ workspaceId: "default", title: "Signed review link API test" }).expect(201);
    const drafted = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/drafts`)
      .send({ platform: "instagram", format: "image", title: "Signed review", caption: "Exact signed revision", mediaIds: [] }).expect(201);
    const draft = drafted.body.drafts.at(-1) as { id: string; contentSha256: string };
    const shared = await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/review-links`)
      .send({ draftId: draft.id, expiresInHours: 24, allowComment: true }).expect(201);
    const token = String(shared.body.url).split("/").at(-1)!;
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await request(app.getHttpServer()).get(`/v1/reviews/${tamperedToken}`).expect(404);

    const viewed = await request(app.getHttpServer()).get(`/v1/reviews/${token}`).expect(200);
    expect(viewed.headers["cache-control"]).toBe("no-store");
    expect(viewed.body).toMatchObject({ content: { title: "Signed review link API test" }, draft: { id: draft.id, contentSha256: draft.contentSha256 }, review: { allowComment: true } });

    const commented = await request(app.getHttpServer()).post(`/v1/reviews/${token}/comments`)
      .send({ name: "External Reviewer", body: "Please make the opening shorter." }).expect(201);
    expect(commented.body.comments.at(-1)).toMatchObject({ authorName: "External Reviewer", body: "Please make the opening shorter." });

    await request(app.getHttpServer()).post(`/v1/content-items/${created.body.id}/review-links/${shared.body.link.id}/revoke`).expect(201);
    await request(app.getHttpServer()).get(`/v1/reviews/${token}`).expect(410);
  });
});
