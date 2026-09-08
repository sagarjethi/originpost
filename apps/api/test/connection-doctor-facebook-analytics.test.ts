import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import type { ConnectedAccount } from "@originpost/domain";
import type { ConnectorManifest } from "@originpost/connectors";
import { describe, expect, it } from "vitest";
import { ConnectionDoctorService } from "../src/channels/connection-doctor.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

const manifest = (analytics: boolean): ConnectorManifest => ({
  id: "originpost.facebook.official",
  name: "Facebook Page",
  platform: "facebook",
  version: "0.2.0",
  apiMode: "official",
  capabilities: { formats: ["text", "image"], analytics, comments: true, tokenRefresh: true, pendingPublishing: false },
  limits: { captionCharacters: 63_206, maxMedia: 1 },
});

const account = (capabilities: ConnectedAccount["capabilities"]): ConnectedAccount => ({
  id: "account-facebook",
  workspaceId: "workspace-1",
  brandId: "brand-1",
  platform: "facebook",
  displayName: "OriginPost Page",
  externalAccountId: "123456789",
  credentialRef: "env:FACEBOOK_TEST_TOKEN",
  capabilities,
  status: "healthy",
  createdBy: "owner-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const inspect = async (analytics: boolean, capabilities: ConnectedAccount["capabilities"]) => {
  const infrastructure = {
    connectors: { list: () => [{ manifest: manifest(analytics) }] },
    oauthRepository: { hasCredential: async () => true },
  } as unknown as OriginPostInfrastructure;
  const config = new ConfigService({ API_PUBLIC_URL: "https://api.example.com", FACEBOOK_TEST_TOKEN: "secret" });
  return new ConnectionDoctorService(infrastructure, config).inspect(account(capabilities));
};

describe("Connection Doctor Facebook analytics", () => {
  it("shows the deployment contract gate separately from publishing readiness", async () => {
    const result = await inspect(false, ["page_read", "media_publish"]);
    expect(result.checks.find((check) => check.id === "analytics")).toMatchObject({ status: "warn", label: "Page Post analytics" });
  });

  it("passes only when both the contract and Page grant allow analytics", async () => {
    const missingGrant = await inspect(true, ["page_read", "media_publish"]);
    const ready = await inspect(true, ["page_read", "media_publish", "analytics_read"]);
    expect(missingGrant.checks.find((check) => check.id === "analytics")).toMatchObject({ status: "warn" });
    expect(ready.checks.find((check) => check.id === "analytics")).toMatchObject({ status: "pass" });
  });
});
