import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { startE2eApp } from "./test-app.js";

describe("Instagram Story capability channel response", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_MODE: "single-user",
      DATABASE_URL: "",
      REDIS_URL: "",
      BOOTSTRAP_USER_ID: "story-channel-owner",
      BOOTSTRAP_USER_NAME: "Story Channel Owner",
      REVIEW_LINK_SECRET: "story-channel-review-secret-with-32-characters",
      MEDIA_DELIVERY_SECRET: "story-channel-media-secret-with-32-characters",
      CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      OAUTH_TEST_MODE: "true",
      API_PUBLIC_URL: "http://localhost:4000",
      WEB_PUBLIC_URL: "http://localhost:3000",
      AUTOMATION_DELIVERY_ENABLED: "false",
    });

    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
  });

  afterAll(async () => { await app.close(); });

  it("returns only the safe Business Story capability from a protected OAuth identity", async () => {
    const started = await request(app.getHttpServer()).post("/v1/channels/oauth/instagram/start").send({ workspaceId: "default" }).expect(201);
    const state = new URL(started.body.authorizationUrl as string).searchParams.get("state");
    expect(state).toBeTruthy();
    await request(app.getHttpServer()).get(`/v1/channels/oauth/instagram/callback?state=${encodeURIComponent(state!)}&code=originpost-oauth-test-code`).expect(302);

    const response = await request(app.getHttpServer()).get("/v1/channels/accounts?workspaceId=default").expect(200);
    const account = response.body.find((entry: { externalAccountId: string }) => entry.externalAccountId === "test-instagram-oauth");

    expect(account).toMatchObject({
      platform: "instagram",
      instagramStory: {
        state: "supported",
        accountType: "BUSINESS",
        autoPublish: true,
        mediaTypes: ["image", "video"],
        interactiveFeatures: false,
      },
    });
    expect(account).not.toHaveProperty("credentialRef");
    expect(account.instagramStory).not.toHaveProperty("scope");
    expect(JSON.stringify(account)).not.toContain("test-access-token-never-returned");
  });
});
