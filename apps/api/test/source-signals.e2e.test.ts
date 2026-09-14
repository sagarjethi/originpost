import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { createMonitorRule, rankSourceSignals, type MonitorRule } from "@originpost/domain";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import { configureApp } from "../src/configure-app.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { startE2eApp } from "./test-app.js";

describe("Source Signal Desk", () => {
  let app: NestFastifyApplication;
  let infrastructure: OriginPostInfrastructure;
  let monitor: MonitorRule;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "single-user";
    process.env.DATABASE_URL = "";
    process.env.REDIS_URL = "";
    process.env.BOOTSTRAP_USER_ID = "signal-owner";
    process.env.BOOTSTRAP_USER_NAME = "Signal Owner";
    process.env.REVIEW_LINK_SECRET = "source-signal-test-secret-with-more-than-32-characters";
    process.env.MEDIA_DELIVERY_SECRET = "source-signal-media-secret-with-more-than-32-characters";
    process.env.API_PUBLIC_URL = "http://localhost:4000";
    process.env.WEB_PUBLIC_URL = "http://localhost:3000";
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    infrastructure = app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    monitor = createMonitorRule({ workspaceId: "default", brandId: "brand_default", name: "Luma Mumbai events", query: "Upcoming public Luma events in Mumbai with public hosts", intervalMinutes: 60, depth: "standard", languages: ["English", "Hindi"], region: "Mumbai", sourceLimit: 15, freshnessHours: 720, enabled: true, sourceIntelligence: { mode: "tracked_sources", sources: [{ label: "Luma Mumbai", url: "https://luma.com/mumbai", kind: "luma_city", publisher: "Luma", priority: "primary", enabled: true }], includeTerms: [], excludeTerms: [], minimumScore: 35 } }, { id: "signal-owner", name: "Signal Owner", role: "owner", actorType: "human" });
    await infrastructure.monitorRepository.save(monitor);
  });

  afterAll(async () => { await app.close(); });

  function eventSignal(runId: string, slug: string, title: string) {
    return rankSourceSignals(monitor, {
      monitorRunId: runId, provider: "luma-public", model: "public-events", toolsUsed: ["luma_city"],
      suggestions: [{ title, summary: "September 9 at BKC. Public hosts: Asha and Dev.", sourceUrls: [`https://luma.com/${slug}`] }],
      sources: [{ stableId: `evt-${slug}`, title, url: `https://luma.com/${slug}`, publisher: "Luma Mumbai", confidence: 100 }],
      claims: [{ text: "The event is listed in Mumbai.", status: "supported", sourceUrls: [`https://luma.com/${slug}`] }],
    }, "2026-09-01T08:00:00.000Z")[0]!;
  }

  it("opens only screenshots attached to an accessible source signal", async () => {
    const signal = eventSignal("capture-run", "snapshot-example", "A public event with a page capture");
    signal.brandId = "brand_snapshot";
    signal.sources[0]!.snapshot = { sha256: "a".repeat(64), capturedAt: "2026-09-15T00:00:00.000Z", pageUrl: "https://luma.com/mumbai", width: 1440, height: 1000 };
    await infrastructure.sourceSignalRepository.ingest([signal]);
    const path = `/v1/signals/${signal.id}/sources/${signal.sources[0]!.id}/screenshot`;
    const result = await request(app.getHttpServer()).get(path).expect(200);
    expect(result.body).toMatchObject({ rights: "reference-only", snapshot: { width: 1440, height: 1000, sha256: "a".repeat(64) } });
    expect(result.body.url).toContain("source-snapshots");
    await request(app.getHttpServer()).get(`/v1/signals/${signal.id}/sources/missing/screenshot`).expect(404);
    await request(app.getHttpServer()).get(`/v1/signals/missing/sources/${signal.sources[0]!.id}/screenshot`).expect(404);
  });
  it("keeps the pinned Luma city preset free of attendee data", async () => {
    expect(monitor.sourceIntelligence?.sources[0]).toMatchObject({ kind: "luma_city", url: "https://luma.com/mumbai", priority: "primary" });
    expect(JSON.stringify(monitor.sourceIntelligence)).not.toMatch(/attendee|guest.list/i);
  });

  it("lists, dismisses, restores, and safely saves one signal to the existing Content Inbox", async () => {
    const first = eventSignal("run-luma-1", "mumbai-product-night", "Mumbai Product Night");
    const second = eventSignal("run-luma-1", "mumbai-founders", "Mumbai Founders Meetup");
    await infrastructure.sourceSignalRepository.ingest([first, second]);

    const list = await request(app.getHttpServer()).get("/v1/signals?workspaceId=default&brandId=brand_default&state=new").expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0]).toEqual(expect.objectContaining({ eventFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), state: "new" }));

    const dismissed = await request(app.getHttpServer()).post(`/v1/signals/${second.id}/dismiss?workspaceId=default`).set("if-match", "1").send({ reason: "Not relevant this week" }).expect(201);
    expect(dismissed.body).toMatchObject({ state: "dismissed", dismissReason: "Not relevant this week", version: 2 });
    const restored = await request(app.getHttpServer()).post(`/v1/signals/${second.id}/restore?workspaceId=default`).set("if-match", "2").expect(201);
    expect(restored.body).toMatchObject({ state: "new", version: 3 });

    const saved = await request(app.getHttpServer()).post(`/v1/signals/${first.id}/save?workspaceId=default`).set("if-match", "1").expect(201);
    expect(saved.body).toMatchObject({ signal: { state: "saved", version: 3 }, contentItem: { status: "inbox", brandId: "brand_default" }, idempotentReplay: false });
    expect(saved.body.contentItem.sources).toEqual([expect.objectContaining({ url: "https://luma.com/mumbai-product-night", rights: "reference-only" })]);
    const replay = await request(app.getHttpServer()).post(`/v1/signals/${first.id}/save?workspaceId=default`).set("if-match", "3").expect(201);
    expect(replay.body).toMatchObject({ signal: { state: "saved" }, contentItem: { id: saved.body.contentItem.id }, idempotentReplay: true });
  });
  it("applies publication windows before limiting and validates filter inputs", async () => {
    const recent = eventSignal("run-recent", "recent-release", "Recent release");
    await infrastructure.sourceSignalRepository.ingest([{...recent,publishedAt:new Date(Date.now()-3600000).toISOString(),score:40}]);
    const response = await request(app.getHttpServer()).get("/v1/signals?workspaceId=default&brandId=brand_default&sort=newest&recentHours=2&limit=1").expect(200);
    expect(response.body.map((signal: {id:string}) => signal.id)).toEqual([recent.id]);
    await request(app.getHttpServer()).get("/v1/signals?workspaceId=default&sort=invalid").expect(400);
    await request(app.getHttpServer()).get("/v1/signals?workspaceId=default&recentHours=0").expect(400);
  });

});
