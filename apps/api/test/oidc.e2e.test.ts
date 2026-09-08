import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OIDC_PROVIDER, type OidcAuthenticationInput, type OidcAuthorizationInput, type OidcProvider } from "../src/auth/oidc-provider.js";
import { startE2eApp } from "./test-app.js";

describe("OIDC browser session flow", () => {
  let app: NestFastifyApplication;
  let provider: OidcProvider & { authorization?: OidcAuthorizationInput; authentication?: OidcAuthenticationInput };

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
    process.env.OIDC_ENABLED = "true";
    process.env.OIDC_ISSUER_URL = "https://identity.example.test";
    process.env.OIDC_CLIENT_ID = "originpost-client";
    process.env.OIDC_CLIENT_SECRET = "test-client-secret";
    process.env.OIDC_REDIRECT_URI = "https://originpost.example.test/v1/auth/oidc/callback";
    process.env.OIDC_WEB_RETURN_URL = "http://localhost:3000/";
    process.env.OIDC_ALLOWED_EMAIL_DOMAINS = "originpost.test";
    process.env.OIDC_ALLOWED_GROUPS = "originpost-users";
    process.env.OIDC_AUTO_PROVISION = "false";

    provider = {
      async authorizationUrl(input) { this.authorization = input; return `https://identity.example.test/authorize?state=${encodeURIComponent(input.state)}`; },
      async authenticate(input) { this.authentication = input; return { issuer: "https://identity.example.test", subject: "owner-subject", email: "owner@originpost.test", emailVerified: true, displayName: "Test Owner", groups: ["originpost-users"] }; },
    };
    const [{ AppModule }, { configureApp }] = await Promise.all([import("../src/app.module.js"), import("../src/configure-app.js")]);
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(OIDC_PROVIDER).useValue(provider).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
  }, 30_000);

  afterAll(async () => { if (app) await app.close(); });

  it("advertises SSO, binds callback cookies and creates the normal OriginPost session", async () => {
    const config = await request(app.getHttpServer()).get("/v1/auth/config").expect(200);
    expect(config.body).toMatchObject({ mode: "sessions", oidc: { enabled: true, displayName: "Single sign-on" } });

    const start = await request(app.getHttpServer()).get("/v1/auth/oidc/start").expect(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get("state")!;
    expect(location.origin).toBe("https://identity.example.test");
    expect(provider.authorization).toMatchObject({ state, redirectUri: "https://originpost.example.test/v1/auth/oidc/callback" });
    const callbackCookies = (start.headers["set-cookie"] as unknown as string[]).map((value) => value.split(";")[0]).join("; ");
    expect(callbackCookies).toContain("originpost_oidc_state=");
    expect(callbackCookies).toContain("originpost_oidc_nonce=");
    expect(callbackCookies).toContain("originpost_oidc_verifier=");

    const callback = await request(app.getHttpServer()).get(`/v1/auth/oidc/callback?code=provider-code&state=${encodeURIComponent(state)}`).set("Cookie", callbackCookies).expect(302);
    expect(callback.headers.location).toBe("http://localhost:3000/?auth=oidc");
    expect(provider.authentication).toMatchObject({ code: "provider-code", redirectUri: "https://originpost.example.test/v1/auth/oidc/callback" });
    const sessionCookie = (callback.headers["set-cookie"] as unknown as string[]).find((value) => value.startsWith("originpost_session="))!.split(";")[0]!;
    const me = await request(app.getHttpServer()).get("/v1/auth/me").set("Cookie", sessionCookie).expect(200);
    expect(me.body).toMatchObject({ mode: "sessions", user: { email: "owner@originpost.test" }, memberships: [expect.objectContaining({ role: "owner" })] });

    const replay = await request(app.getHttpServer()).get(`/v1/auth/oidc/callback?code=provider-code&state=${encodeURIComponent(state)}`).set("Cookie", callbackCookies).expect(302);
    expect(replay.headers.location).toBe("http://localhost:3000/?auth=error");
  });
});
