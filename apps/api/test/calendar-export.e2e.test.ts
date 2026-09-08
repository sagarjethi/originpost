import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { ConnectedAccount, ContentItem } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

const workspaceId = "calendar-export-workspace";
const brandId = "calendar-export-brand";
const now = "2026-08-01T00:00:00.000Z";

function content(id: string, title: string, target: ContentItem["targets"][number], override: Partial<ContentItem> = {}): ContentItem {
  return {
    id, workspaceId, brandId, version: 1, title, summary: "", status: "scheduled", researchDepth: "quick", riskLevel: "low", tags: [], sources: [], claims: [], researchRuns: [], drafts: [], approvals: [], reviewComments: [], reviewLinks: [], targets: [target], publishAttempts: [], proofs: [], createdBy: "calendar-owner", createdAt: now, updatedAt: now, ...override,
  };
}

describe("calendar schedule CSV export", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "single-user";
    process.env.DATABASE_URL = "";
    process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = "calendar-owner";
    process.env.BOOTSTRAP_USER_NAME = "Calendar Owner";
    process.env.REVIEW_LINK_SECRET = "calendar-export-review-secret-more-than-32-characters";
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    const infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    await infrastructure.organizationRepository.createWorkspace({
      workspace: { id: workspaceId, name: "Calendar workspace", slug: "calendar-export-workspace", createdAt: now, updatedAt: now },
      defaultBrand: { id: brandId, workspaceId, name: "Mumbai Events", slug: "mumbai-events", primaryLanguage: "English", timezone: "Asia/Kolkata", status: "active", createdBy: "calendar-owner", createdAt: now, updatedAt: now },
      ownerUserId: "calendar-owner",
      ownerDisplayName: "Calendar Owner",
      event: { id: "audit-calendar-workspace", workspaceId, actorId: "calendar-owner", actorType: "human", action: "workspace.created", detail: {}, createdAt: now },
    });
    const account: ConnectedAccount = { id: "internal-account-id", workspaceId, brandId, platform: "instagram", displayName: "Main Instagram", externalAccountId: "provider-account-must-not-leak", capabilities: ["profile_read"], status: "healthy", createdBy: "calendar-owner", createdAt: now, updatedAt: now };
    await infrastructure.connectedAccountRepository.save(account, { id: "audit-calendar-account", workspaceId, actorId: "calendar-owner", actorType: "human", action: "test.account", detail: {}, createdAt: now });
    const records = [
      content("formula-content", "  =HYPERLINK(\"https://invalid.example\")", { id: "z-target", platform: "instagram", accountId: account.id, draftId: "private-draft", scheduledFor: "2026-09-01T04:00:00.000Z", timezone: "Asia/Kolkata", deliveryMode: "auto_publish", status: "queued" }),
      content("gujarati-content", "મુંબઈ, launch", { id: "a-target", platform: "instagram", accountId: "missing-account", draftId: "private-draft-2", scheduledFor: "2026-09-01T04:00:00.000Z", timezone: "Asia/Kolkata", deliveryMode: "manual_handoff", status: "queued" }),
      content("october-content", "October", { id: "october-target", platform: "instagram", accountId: account.id, draftId: "draft-october", scheduledFor: "2026-09-30T18:30:00.000Z", timezone: "Asia/Kolkata", deliveryMode: "auto_publish", status: "queued" }),
      content("other-brand-content", "Other brand", { id: "other-brand-target", platform: "instagram", accountId: account.id, draftId: "other-brand-draft", scheduledFor: "2026-09-02T04:00:00.000Z", deliveryMode: "auto_publish", status: "queued" }, { brandId: "another-brand" }),
    ];
    for (const record of records) {
      await infrastructure.repository.commit(record, { id: `audit-${record.id}`, workspaceId, contentItemId: record.id, actorId: "calendar-owner", actorType: "human", action: "content.created", detail: {}, createdAt: now });
    }
  });

  afterAll(async () => { await app.close(); });

  it("exports the authoritative active-Brand month with safe headers and no internal/provider identifiers", async () => {
    const response = await request(app.getHttpServer()).get("/v1/content-items/schedule/export.csv").query({ workspaceId, brandId, month: "2026-09", timeZone: "Asia/Kolkata", platform: "instagram", status: "queued" }).expect(200);
    expect(response.headers["content-type"]).toContain("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="originpost-calendar-2026-09.csv"');
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.text).toContain('"\'  =HYPERLINK(""https://invalid.example"")"');
    expect(response.text).toContain('"મુંબઈ, launch"');
    expect(response.text).toContain('"Unavailable"');
    expect(response.text).toContain('"Main Instagram"');
    expect(response.text).not.toContain("October");
    expect(response.text).not.toContain("Other brand");
    expect(response.text).not.toContain("internal-account-id");
    expect(response.text).not.toContain("provider-account-must-not-leak");
    expect(response.text).not.toContain("private-draft");
  });

  it("returns a header-only file for a valid empty filter", async () => {
    const response = await request(app.getHttpServer()).get("/v1/content-items/schedule/export.csv").query({ workspaceId, brandId, month: "2026-09", timeZone: "UTC", status: "published" }).expect(200);
    expect(response.text.split("\r\n")).toHaveLength(2);
  });

  it("rejects unknown brands, invalid zones, and unknown query fields", async () => {
    await request(app.getHttpServer()).get("/v1/content-items/schedule/export.csv").query({ workspaceId, brandId: "another-brand", month: "2026-09", timeZone: "UTC" }).expect(404);
    await request(app.getHttpServer()).get("/v1/content-items/schedule/export.csv").query({ workspaceId, brandId, month: "2026-09", timeZone: "Not/AZone" }).expect(400);
    await request(app.getHttpServer()).get("/v1/content-items/schedule/export.csv").query({ workspaceId, brandId, month: "2026-09", timeZone: "UTC", credentialRef: "secret:nope" }).expect(400);
  });
});
