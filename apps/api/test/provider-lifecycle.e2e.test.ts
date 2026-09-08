import "reflect-metadata";
import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import { ProviderLifecycleController } from "../src/provider-lifecycle/provider-lifecycle.controller.js";
import { ProviderLifecycleService } from "../src/provider-lifecycle/provider-lifecycle.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

function signedForm(secret: string, payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return new URLSearchParams({ signed_request: `${signature}.${encoded}` }).toString();
}

describe("provider lifecycle HTTP callbacks", () => {
  it("preserves and verifies the exact form body before accepting deauthorization", async () => {
    const receiveMetaDeauthorization = vi.fn(async () => ({ created: true, matchedGrants: 1, affectedAccounts: 2 }));
    const infrastructure = { storageMode: "postgres", providerLifecycleRepository: { receiveMetaDeauthorization } } as unknown as OriginPostInfrastructure;
    const secret = "meta-callback-test-secret";
    const config = new ConfigService({ META_PROVIDER_CALLBACKS_ENABLED: true, META_APP_ID: "meta-app-1", META_APP_SECRET: secret, PROVIDER_LOOKUP_HMAC_KEYS: `v1:${Buffer.alloc(32, 4).toString("base64")}`, PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION: "v1" });
    const fixture = await Test.createTestingModule({ controllers: [ProviderLifecycleController], providers: [ProviderLifecycleService, { provide: INFRASTRUCTURE, useValue: infrastructure }, { provide: ConfigService, useValue: config }] }).compile();
    const app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }), { rawBody: true });
    configureApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      await request(app.getHttpServer()).post("/v1/channels/callbacks/meta/deauthorization").type("form").send(signedForm(secret, { algorithm: "HMAC-SHA256", user_id: "123456789" })).expect(200, { accepted: true });
      expect(receiveMetaDeauthorization).toHaveBeenCalledOnce();
      const input = receiveMetaDeauthorization.mock.calls[0]![0];
      expect(input.lookupCandidates).toHaveLength(1);
      expect(input.subjectLookupHmac).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(input)).not.toContain("123456789");
    } finally {
      await app.close();
    }
  });
});
