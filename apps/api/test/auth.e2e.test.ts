import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2eApp } from "./test-app.js";

describe("self-hosted session authentication", () => {
  let app: NestFastifyApplication;
  let ownerCookie: string;
  let ownerCsrf: string;

  function invitationToken(url: string): string {
    return new URLSearchParams(new URL(url).hash.slice(1)).get("token") ?? "";
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "sessions";
    process.env.DATABASE_URL = "";
    process.env.REDIS_URL = "";
    process.env.REVIEW_LINK_SECRET = "test-review-link-secret-with-more-than-32-characters";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "owner@originpost.test";
    process.env.BOOTSTRAP_ADMIN_NAME = "Test Owner";
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "StrongPassword123";
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.AUTH_SESSION_DAYS = "14";

    const [{ AppModule }, { configureApp }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/configure-app.js"),
    ]);
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
  }, 30_000);

  afterAll(async () => { if (app) await app.close(); });

  it("requires a session and returns a hardened opaque cookie", async () => {
    const preflight = await request(app.getHttpServer()).options("/v1/workspaces/default/members/user/role")
      .set("Origin", "http://localhost:3000").set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "content-type,x-originpost-csrf").expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    await request(app.getHttpServer()).get("/v1/content-items?workspaceId=default").expect(401);
    await request(app.getHttpServer()).post("/v1/auth/login").send({ email: "owner@originpost.test", password: "wrong-password" }).expect(401);

    const login = await request(app.getHttpServer()).post("/v1/auth/login")
      .send({ email: "OWNER@originpost.test", password: "StrongPassword123" }).expect(200);
    const setCookie = String(login.headers["set-cookie"]?.[0] ?? login.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("originpost_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(login.body.sessionToken).toBeUndefined();
    expect(login.body).toMatchObject({ user: { email: "owner@originpost.test", displayName: "Test Owner" }, memberships: [expect.objectContaining({ workspaceId: "default", role: "owner" })] });
    ownerCookie = setCookie.split(";")[0]!;
    ownerCsrf = login.body.csrfToken as string;

    const me = await request(app.getHttpServer()).get("/v1/auth/me").set("Cookie", ownerCookie).expect(200);
    expect(me.body).toMatchObject({ mode: "sessions", user: { email: "owner@originpost.test" }, csrfToken: ownerCsrf });
  });

  it("requires CSRF for changes and enforces workspace membership", async () => {
    await request(app.getHttpServer()).post("/v1/content-items").set("Cookie", ownerCookie)
      .send({ workspaceId: "default", title: "Blocked without CSRF" }).expect(403);

    const created = await request(app.getHttpServer()).post("/v1/content-items")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ workspaceId: "default", title: "Session-authenticated content" }).expect(201);
    expect(created.body).toMatchObject({ createdBy: expect.stringMatching(/^user_/), workspaceId: "default" });

    await request(app.getHttpServer()).get("/v1/content-items?workspaceId=another-workspace")
      .set("Cookie", ownerCookie).expect(403);
  });

  it("prevents role escalation and keeps a last owner", async () => {
    const member = await request(app.getHttpServer()).post("/v1/workspaces/default/members")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ email: "viewer@originpost.test", displayName: "Test Viewer", password: "ViewerPassword123", role: "viewer" }).expect(201);
    expect(member.body).toMatchObject({ email: "viewer@originpost.test", role: "viewer" });

    const viewerLogin = await request(app.getHttpServer()).post("/v1/auth/login")
      .send({ email: "viewer@originpost.test", password: "ViewerPassword123" }).expect(200);
    const viewerCookie = String(viewerLogin.headers["set-cookie"]?.[0] ?? viewerLogin.headers["set-cookie"]).split(";")[0]!;
    const viewerCsrf = viewerLogin.body.csrfToken as string;
    await request(app.getHttpServer()).get("/v1/content-items?workspaceId=default").set("Cookie", viewerCookie).expect(200);
    await request(app.getHttpServer()).post("/v1/content-items")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf)
      .send({ workspaceId: "default", title: "Viewer cannot create" }).expect(403);
    await request(app.getHttpServer()).post("/v1/workspaces/default/members")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf)
      .send({ email: "escalation@originpost.test", displayName: "Escalation", password: "Escalation123", role: "owner" }).expect(403);
    await request(app.getHttpServer()).post("/v1/operations/outbox/missing/retry?workspaceId=default")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf).expect(403);
    await request(app.getHttpServer()).post("/v1/channels/accounts")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf)
      .send({ workspaceId: "default", platform: "instagram", displayName: "Blocked", externalAccountId: "blocked", capabilities: [] }).expect(403);
    await request(app.getHttpServer()).post("/v1/media-assets/uploads")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf)
      .send({ workspaceId: "default", kind: "image", purpose: "creative", fileName: "blocked.png", contentType: "image/png", sizeBytes: 1, sha256: "a".repeat(64), rights: "owned" }).expect(403);
    await request(app.getHttpServer()).post("/v1/channels/oauth/instagram/start")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf).send({ workspaceId: "default" }).expect(403);
    await request(app.getHttpServer()).post("/v1/channels/accounts/missing/refresh?workspaceId=default")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf).expect(403);

    const me = await request(app.getHttpServer()).get("/v1/auth/me").set("Cookie", ownerCookie).expect(200);
    const ownerId = me.body.user.id as string;
    const lastOwner = await request(app.getHttpServer()).patch(`/v1/workspaces/default/members/${ownerId}/role`)
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf).send({ role: "manager" }).expect(409);
    expect(lastOwner.body.error).toBe("last_owner_required");
  });

  it("creates, rotates, revokes, and registers through one-time fragment invitations", async () => {
    const blocked = await request(app.getHttpServer()).post("/v1/workspaces/default/invitations")
      .set("Cookie", ownerCookie).send({ email: "blocked@originpost.test", role: "viewer" }).expect(403);
    expect(blocked.body.message).toMatch(/security token/i);

    const created = await request(app.getHttpServer()).post("/v1/workspaces/default/invitations")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ email: "rotate@originpost.test", role: "creator", expiresInDays: 7 }).expect(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.headers["referrer-policy"]).toBe("no-referrer");
    expect(created.body).toMatchObject({ invitation: { email: "rotate@originpost.test", role: "creator", status: "pending", deliveryState: "link_ready" }, url: expect.stringContaining("/invite#token=") });
    expect(created.body.invitation.tokenSha256).toBeUndefined();
    const firstToken = invitationToken(created.body.url);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await request(app.getHttpServer()).post("/v1/workspaces/default/invitations")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ email: "ROTATE@originpost.test", role: "viewer" }).expect(409);

    const listed = await request(app.getHttpServer()).get("/v1/workspaces/default/invitations").set("Cookie", ownerCookie).expect(200);
    expect(listed.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.invitation.id, email: "rotate@originpost.test" })]));
    expect(JSON.stringify(listed.body)).not.toContain(firstToken);
    expect(JSON.stringify(listed.body)).not.toContain("tokenSha256");

    const resent = await request(app.getHttpServer()).post(`/v1/workspaces/default/invitations/${created.body.invitation.id}/resend`)
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf).send({ expiresInDays: 3 }).expect(201);
    const secondToken = invitationToken(resent.body.url);
    expect(secondToken).not.toBe(firstToken);
    await request(app.getHttpServer()).post("/public/v1/invitations/preview").send({ token: firstToken }).expect(404);
    const preview = await request(app.getHttpServer()).post("/public/v1/invitations/preview")
      .send({ token: secondToken })
      .expect(200);
    expect(preview.body).toMatchObject({ workspaceName: "My workspace", role: "creator", emailHint: "r***@originpost.test", deliveryState: "link_ready" });

    await request(app.getHttpServer()).post(`/v1/workspaces/default/invitations/${created.body.invitation.id}/revoke`)
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf).expect(201);
    await request(app.getHttpServer()).post("/public/v1/invitations/preview").send({ token: secondToken }).expect(404);

    const registrationInvite = await request(app.getHttpServer()).post("/v1/workspaces/default/invitations")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ email: "new-member@originpost.test", role: "manager" }).expect(201);
    const registrationToken = invitationToken(registrationInvite.body.url);
    const registration = await request(app.getHttpServer()).post("/public/v1/invitations/register")
      .send({ token: registrationToken, displayName: "New Member", password: "NewMemberPassword123" }).expect(201);
    expect(String(registration.headers["set-cookie"]?.[0] ?? registration.headers["set-cookie"])).toContain("HttpOnly");
    expect(registration.body.sessionToken).toBeUndefined();
    expect(registration.body).toMatchObject({ user: { email: "new-member@originpost.test" }, memberships: [expect.objectContaining({ workspaceId: "default", role: "manager" })] });
    await request(app.getHttpServer()).post("/public/v1/invitations/register")
      .send({ token: registrationToken, displayName: "Replay", password: "ReplayPassword123" }).expect(404);
  });

  it("adds a new workspace to the creator's trusted memberships", async () => {
    await request(app.getHttpServer()).post("/v1/workspaces")
      .set("Cookie", ownerCookie)
      .send({ name: "No CSRF Workspace", defaultBrandName: "Blocked", timezone: "UTC" })
      .expect(403);

    const created = await request(app.getHttpServer()).post("/v1/workspaces")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ name: "Second Workspace", defaultBrandName: "Second Brand", primaryLanguage: "Hindi", timezone: "Asia/Kolkata" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;
    const me = await request(app.getHttpServer()).get("/v1/auth/me").set("Cookie", ownerCookie).expect(200);
    expect(me.body.memberships).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId, role: "owner" })]));
    await request(app.getHttpServer()).get(`/v1/workspaces/${workspaceId}/brands`).set("Cookie", ownerCookie).expect(200);

    const viewerLogin = await request(app.getHttpServer()).post("/v1/auth/login")
      .send({ email: "viewer@originpost.test", password: "ViewerPassword123" }).expect(200);
    const viewerCookie = String(viewerLogin.headers["set-cookie"]?.[0] ?? viewerLogin.headers["set-cookie"]).split(";")[0]!;
    const viewerCsrf = viewerLogin.body.csrfToken as string;
    await request(app.getHttpServer()).get(`/v1/workspaces/${workspaceId}/brands`).set("Cookie", viewerCookie).expect(403);

    const invitation = await request(app.getHttpServer()).post(`/v1/workspaces/${workspaceId}/invitations`)
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf)
      .send({ email: "viewer@originpost.test", role: "creator" }).expect(201);
    const token = invitationToken(invitation.body.url);
    await request(app.getHttpServer()).post("/public/v1/invitations/register")
      .send({ token, displayName: "Duplicate", password: "DuplicatePassword123" }).expect(409);
    const accepted = await request(app.getHttpServer()).post("/v1/auth/invitations/accept")
      .set("Cookie", viewerCookie).set("x-originpost-csrf", viewerCsrf).send({ token }).expect(201);
    expect(accepted.body).toMatchObject({ member: { workspaceId, email: "viewer@originpost.test", role: "creator" }, memberships: expect.arrayContaining([expect.objectContaining({ workspaceId, role: "creator" })]) });
    await request(app.getHttpServer()).get(`/v1/workspaces/${workspaceId}/brands`).set("Cookie", viewerCookie).expect(200);
  });

  it("rate-limits repeated failed sign-ins", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post("/v1/auth/login").send({ email: "missing@originpost.test", password: "WrongPassword123" }).expect(401);
    }
    await request(app.getHttpServer()).post("/v1/auth/login").send({ email: "missing@originpost.test", password: "WrongPassword123" }).expect(429);
  });

  it("revokes logout immediately", async () => {
    await request(app.getHttpServer()).post("/v1/auth/logout").set("Cookie", ownerCookie).expect(403);
    await request(app.getHttpServer()).post("/v1/auth/logout")
      .set("Cookie", ownerCookie).set("x-originpost-csrf", ownerCsrf).expect(204);
    await request(app.getHttpServer()).get("/v1/auth/me").set("Cookie", ownerCookie).expect(401);
  });
});
