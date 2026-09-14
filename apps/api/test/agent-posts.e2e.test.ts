import "reflect-metadata";
import { createHash } from "node:crypto";
import { memoryFixtureFor } from "../src/media/memory-media-fixtures.js";
import { ConfigService } from "@nestjs/config";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeResearch } from "@originpost/domain";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { AgentPostsService } from "../src/agent-posts/agent-posts.service.js";
import { AgentRuntimeService } from "../src/agent-runtimes/agent-runtime.service.js";
import { IMAGE_GENERATION_PROVIDER } from "../src/image-generation/image-generation.provider.js";
import { startE2eApp } from "./test-app.js";

describe("news post workflow with external providers substituted", () => {
  let app: NestFastifyApplication,
    infrastructure: OriginPostInfrastructure,
    service: AgentPostsService;
  let templateId: string;
  const generate = vi.fn(async () => ({
    bytes: await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: "#445566" },
    })
      .png()
      .toBuffer(),
    contentType: "image/png",
    providerRequestId: "test_image",
  }));
  const text = vi.fn(async () => ({
    text: JSON.stringify({
      headline: "New public library opens",
      caption:
        "A new library opened today. Which book would you borrow? Source: City council. #Library",
      visualDirection:
        "Clearly illustrated books and a library, no words or logos.",
    }),
  }));
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AUTH_MODE: "single-user",
      DATABASE_URL: "",
      REDIS_URL: "",
      BOOTSTRAP_USER_ID: "post-owner",
      BOOTSTRAP_USER_NAME: "Post Owner",
      REVIEW_LINK_SECRET: "post-review-secret-with-more-than-32-characters",
      MEDIA_DELIVERY_SECRET: "post-media-secret-with-more-than-32-characters",
      AUTOMATION_DELIVERY_ENABLED: "false",
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IMAGE_GENERATION_PROVIDER)
      .useValue({
        capability: () => ({
          enabled: true,
          provider: "openai",
          model: "test-image",
        }),
        generate,
      })
      .overrideProvider(AgentRuntimeService)
      .useValue({ runDraft: text })
      .compile();
    app = fixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureApp(app, app.get(ConfigService));
    await startE2eApp(app);
    infrastructure = app.get(INFRASTRUCTURE);
    service = app.get(AgentPostsService);
    // Manual ticks make recovery/concurrency assertions deterministic.
    service.onApplicationShutdown();
    infrastructure.researchQueue = {
      add: vi.fn(async () => ({})),
      close: async () => {},
    } as never;
    vi.spyOn(
      infrastructure.agentRuntimeRepository,
      "getAssignment",
    ).mockResolvedValue(null);
    infrastructure.hermes = {} as never;
    const upload = await request(app.getHttpServer())
      .post("/v1/media-assets/uploads")
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        kind: "image",
        purpose: "creative",
        fileName: "original-logo.png",
        contentType: "image/png",
        sizeBytes: 1,
        sha256: createHash("sha256")
          .update(memoryFixtureFor("image/png"))
          .digest("hex"),
        rights: "owned",
        altText: "Original logo",
      })
      .expect(201);
    const logo = await request(app.getHttpServer())
      .post(`/v1/media-assets/${upload.body.asset.id}/complete`)
      .send({ workspaceId: "default" })
      .expect(200);
    const template = await request(app.getHttpServer())
      .post("/v1/agent-posts/templates")
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        template: {
          name: "City news",
          language: "English",
          format: "portrait",
          layout: "headline",
          palette: ["#111111", "#222222", "#FFFFFF", "#FFCC00", "#FFFFFF"],
          logoMediaId: logo.body.id,
          logoPosition: "top-right",
          logoWidth: 15,
          logoMargin: 3,
          referenceMediaIds: [],
          styleInstructions: "Clean editorial illustration",
          footer: "City news",
        },
      })
      .expect(201);
    templateId = template.body.id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });
  async function start(key: string) {
    return request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", key)
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        templateId,
        input: "The city council opened a public library today.",
      })
      .expect(201);
  }
  async function advance(id: string) {
    const run = (await infrastructure.agentPostRepository.get("default", id))!;
    await service.advance(run);
    return (await infrastructure.agentPostRepository.get("default", id))!;
  }
  async function research(id: string, disputed = false) {
    const run = await advance(id);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "researching" });
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    const result = completeResearch(
      item,
      run.researchRunId!,
      {
        summary: "Library opening confirmed",
        sources: [
          {
            kind: "url",
            title: "Council announcement",
            url: "https://example.org/library",
            rights: "reference-only",
            confidence: 1,
          },
        ],
        claims: [
          {
            text: "The council opened a library today.",
            status: disputed ? "disputed" : "supported",
            sourceUrls: ["https://example.org/library"],
          },
        ],
        provider: "test-research",
        model: "fixture",
        toolsUsed: ["web_search"],
      },
      { id: "post-owner", name: "Post Owner", role: "owner" },
    );
    await infrastructure.repository.commit(result.item, result.event);
  }
  it("reaches an exact rendered image and unapproved draft, reusing duplicate requests", async () => {
    const first = await start("success");
    expect((await start("success")).body.id).toBe(first.body.id);
    await research(first.body.id);
    let run = await advance(first.body.id);
    for (let i = 0; i < 8 && run.status !== "ready"; i++)
      run = await advance(run.id);
    expect(run, JSON.stringify(run)).toMatchObject({
      status: "ready",
      outputMediaId: expect.any(String),
      draftId: expect.any(String),
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    expect(item.drafts.at(-1)).toMatchObject({
      mediaIds: [run.outputMediaId],
      containsSyntheticMedia: true,
    });
    expect(item.approvals).toHaveLength(0);
    const asset = await infrastructure.mediaRepository.get(
      "default",
      run.outputMediaId!,
    );
    expect(asset).toMatchObject({
      status: "ready",
      widthPixels: 1080,
      heightPixels: 1350,
    });
    expect(run.template.logoPosition).toBe("top-right");
  }, 30000);
  it("blocks disputed research before any additional image call", async () => {
    const started = await start("disputed");
    await research(started.body.id, true);
    expect(await advance(started.body.id)).toMatchObject({ status: "blocked" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("marks an expired worker claim uncertain without repeating work", async () => {
    const started = await start("expired");
    const run = (await infrastructure.agentPostRepository.get(
      "default",
      started.body.id,
    ))!;
    await infrastructure.agentPostRepository.replace(
      { ...run, version: 2, inFlightUntil: new Date(0).toISOString() },
      1,
    );
    expect(await advance(run.id)).toMatchObject({ status: "uncertain" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("allows only one worker to claim the same stage", async () => {
    const started = await start("concurrency");
    const run = (await infrastructure.agentPostRepository.get(
      "default",
      started.body.id,
    ))!;
    await Promise.all([service.advance(run), service.advance(run)]);
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    expect(item.researchRuns).toHaveLength(1);
  });
  it("blocks changed evidence before writing or generating",async()=>{
    const started=await start("changed-evidence"); await research(started.body.id);
    const run=await advance(started.body.id);
    const item=(await infrastructure.repository.get("default",run.contentItemId))!;
    await request(app.getHttpServer()).post(`/v1/content-items/${item.id}/sources?workspaceId=default`).set("If-Match",String(item.version)).send({kind:"note",title:"New evidence",notes:"A correction arrived",rights:"unknown",confidence:0}).expect(201);
    expect(await advance(run.id)).toMatchObject({status:"blocked",error:expect.stringContaining("evidence changed")});
  });
  it("returns a validation error for an invalid template",async()=>{
    await request(app.getHttpServer()).post("/v1/agent-posts/templates").send({workspaceId:"default",brandId:"brand_default",template:{name:"Incomplete"}}).expect(400);
  });
  it("prevents deleting an original logo used by a saved template",async()=>{
    const template=(await infrastructure.agentPostRepository.template("default",templateId))!;
    const logo=(await infrastructure.mediaRepository.get("default",template.logo.mediaId))!;
    await request(app.getHttpServer()).post(`/v1/media-assets/${logo.id}/trash`).send({workspaceId:"default",version:logo.version}).expect(403);
  });

});
