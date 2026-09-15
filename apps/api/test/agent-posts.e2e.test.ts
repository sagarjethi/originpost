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
import { completeResearch, type SourceSignal } from "@originpost/domain";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { INFRASTRUCTURE } from "../src/common/tokens.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { AgentPostImageReviewService } from "../src/agent-posts/agent-post-image-review.service.js";
import { AgentPostPublishingService } from "../src/agent-posts/agent-post-publishing.service.js";
import { AgentPostsService } from "../src/agent-posts/agent-posts.service.js";
import { AgentRuntimeService } from "../src/agent-runtimes/agent-runtime.service.js";
import { ImageGenerationService } from "../src/image-generation/image-generation.service.js";
import { IMAGE_GENERATION_PROVIDER } from "../src/image-generation/image-generation.provider.js";
import { startE2eApp } from "./test-app.js";

describe("news post workflow with external providers substituted", () => {
  let app: NestFastifyApplication,
    infrastructure: OriginPostInfrastructure,
    service: AgentPostsService;
  let templateId: string;
  let publishRunId: string;
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
  const review = vi.fn(async () => ({
    provider: "test-review",
    model: "test-model",
    text: JSON.stringify({
      checks: ["facts", "attribution", "language", "visual-direction"].map(
        (category) => ({
          category,
          verdict: "pass",
          explanation: "Fixture review passed.",
        }),
      ),
    }),
  }));
  const vision = vi.fn(async () => ({
    provider: "test-vision",
    model: "test-vision-model",
    text: JSON.stringify({
      observedHeadline: "New public library opens",
      observedFooter: "City news",
      observedDisclosure: "AI illustration",
      checks: ["legibility", "branding", "visual-integrity", "disclosure"].map(
        (category) => ({
          category,
          verdict: "pass",
          explanation: "Fixture visual check passed.",
        }),
      ),
    }),
  }));
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      AGENT_MODE: "hermes",
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
      .useValue({
        runDraft: text,
        runCopyReview: review,
        runImageReview: vision,
        imageReviewCapability: async () => true,
      })
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
          skills: ["clear-language"],
          exampleCaption: "A short, specific opening. What changes for you?",
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
  async function start(key: string, selectedTemplateId = templateId) {
    return request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", key)
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        templateId: selectedTemplateId,
        input: "The city council opened a public library today.",
      })
      .expect(201);
  }
  async function advance(id: string) {
    const run = (await infrastructure.agentPostRepository.get("default", id))!;
    await service.advance(run);
    return (await infrastructure.agentPostRepository.get("default", id))!;
  }
  async function research(id: string, disputed = false, provider = "hermes") {
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
        provider,
        model: "fixture",
        toolsUsed: ["web_search"],
      },
      { id: "post-owner", name: "Post Owner", role: "owner" },
    );
    await infrastructure.repository.commit(result.item, result.event);
  }
  it("freezes a versioned news lead, preserves capture evidence and keeps discovery unverified", async () => {
    const signal: SourceSignal = {
      id: "signal_post_handoff",
      workspaceId: "default",
      brandId: "brand_default",
      monitorId: "monitor_handoff",
      monitorRunId: "monitor_run_handoff",
      version: 1,
      state: "new",
      urgency: "normal",
      score: 70,
      rankReasons: ["Tracked source"],
      eventFingerprint: "handoff",
      title: "Library opens",
      summary: "A council announcement to verify.",
      sources: [
        {
          id: "source_lead",
          kind: "url",
          title: "Council release",
          url: "https://example.org/lead",
          publisher: "Council",
          capturedAt: "2026-09-15T00:00:00.000Z",
          rights: "owned",
          confidence: 100,
          snapshot: {
            sha256: "a".repeat(64),
            capturedAt: "2026-09-15T00:00:00.000Z",
            pageUrl: "https://example.org/news",
            width: 1440,
            height: 1000,
          },
        },
      ],
      claims: [
        {
          id: "discovery_claim",
          text: "Discovery claimed this was confirmed",
          status: "supported",
          sourceIds: ["source_lead"],
        },
      ],
      discovery: {
        query: "Latest council news",
        provider: "public-websites",
        model: "public-pages",
        toolsUsed: ["browser"],
      },
      occurrenceCount: 1,
      firstSeenAt: "2026-09-15T00:00:00.000Z",
      lastSeenAt: "2026-09-15T00:00:00.000Z",
    };
    await infrastructure.sourceSignalRepository.ingest([signal]);
    const payload = {
      workspaceId: "default",
      brandId: "brand_default",
      templateId,
      input: signal.title,
      sourceSignalId: signal.id,
      sourceSignalVersion: 1,
    };
    const send = (key: string, body = payload) =>
      request(app.getHttpServer())
        .post("/v1/agent-posts")
        .set("Idempotency-Key", key)
        .send(body);
    await send("lead-version", { ...payload, sourceSignalVersion: 2 }).expect(
      409,
    );
    await send("lead-brand", { ...payload, brandId: "brand_elsewhere" }).expect(
      404,
    );
    const first = await send("lead-success").expect(201);
    expect(first.body.sourceLead).toMatchObject({
      id: signal.id,
      version: 1,
      sources: signal.sources,
    });
    await infrastructure.sourceSignalRepository.ingest([
      { ...signal, title: "Corrected title", sources: [] },
    ]);
    expect((await send("lead-success").expect(201)).body.sourceLead.title).toBe(
      "Library opens",
    );
    await send("lead-stale").expect(409);
    const run = await advance(first.body.id);
    expect(run.status).toBe("researching");
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    expect(item.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^source_/),
          url: "https://example.org/lead",
          rights: "reference-only",
          confidence: 0,
          snapshot: signal.sources[0]!.snapshot,
        }),
      ]),
    );
    expect(item.claims).toEqual([]);
    expect(item.researchRuns.at(-1)?.status).toBe("queued");
    await infrastructure.agentPostRepository.replace(
      { ...run, status: "blocked", version: run.version + 1 },
      run.version,
    );
    const revision = await send("lead-revision", {
      workspaceId: "default",
      brandId: "brand_default",
      templateId,
      input: signal.title,
      parentRunId: run.id,
      direction: "Use a shorter headline",
    } as typeof payload).expect(201);
    expect(revision.body.sourceLead).toEqual(first.body.sourceLead);
    const revisedRun = await advance(revision.body.id);
    expect(revisedRun.status).toBe("researching");
    const revisedItem = (await infrastructure.repository.get("default", revisedRun.contentItemId))!;
    const originalSource = item.sources.find(source => source.url === "https://example.org/lead")!;
    const revisedSource = revisedItem.sources.find(source => source.url === originalSource.url)!;
    expect(originalSource.id).not.toBe("source_lead");
    expect(revisedSource.id).not.toBe(originalSource.id);
    expect(revisedSource).toMatchObject({url: originalSource.url, snapshot: originalSource.snapshot, rights:"reference-only",confidence:0});
  });

  it("does not offer post creation when research is in mock mode", async () => {
    const config = app.get(ConfigService);
    const get = config.get.bind(config);
    const spy = vi
      .spyOn(config, "get")
      .mockImplementation(((key: string, ...args: unknown[]) =>
        key === "AGENT_MODE"
          ? "mock"
          : get(key, ...(args as []))) as typeof config.get);
    try {
      const capability = await request(app.getHttpServer())
        .get(
          "/v1/agent-posts/capability?workspaceId=default&brandId=brand_default",
        )
        .expect(200);
      expect(capability.body).toMatchObject({
        research: false,
        researchMode: "mock",
        available: false,
        codexUpload: false,
      });
      expect(capability.body.researchReason).toContain("test mode");
      await request(app.getHttpServer())
        .post("/v1/agent-posts")
        .set("Idempotency-Key", "mock-start")
        .send({
          workspaceId: "default",
          brandId: "brand_default",
          templateId,
          input: "A news story",
          imageMode: "codex-upload",
        })
        .expect(503);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a mock research receipt even if a run was started with live configuration", async () => {
    const first = await start("mock-receipt");
    await research(first.body.id, false, "mock");
    const run = (await infrastructure.agentPostRepository.get(
      "default",
      first.body.id,
    ))!;
    const calls = text.mock.calls.length;
    const blocked = await advance(run.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.error).toContain("Test results cannot verify");
    expect(text).toHaveBeenCalledTimes(calls);
  });

  it("reaches an exact rendered image and unapproved draft, reusing duplicate requests", async () => {
    const first = await start("success");
    publishRunId = first.body.id;
    expect((await start("success")).body.id).toBe(first.body.id);
    await research(first.body.id);
    let run = await advance(first.body.id);
    for (let i = 0; i < 8 && run.status !== "ready"; i++)
      run = await advance(run.id);
    expect(run, JSON.stringify(run)).toMatchObject({
      status: "ready",
      imageReview: {
        status: "passed",
        textMatches: { headline: true, footer: true, disclosure: true },
      },
      outputMediaId: expect.any(String),
      draftId: expect.any(String),
      copyReview: {
        status: "passed",
        evidenceHash: run.evidenceHash,
        copyHash: createHash("sha256")
          .update(JSON.stringify(run.copy))
          .digest("hex"),
      },
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
  it("refuses publishing an older ready post whose research receipt is only a test result", async () => {
    const original = infrastructure.repository.get.bind(infrastructure.repository);
    const run = (await infrastructure.agentPostRepository.get("default", publishRunId))!;
    const spy = vi.spyOn(infrastructure.repository, "get").mockImplementation(async (w, id) => {
      const item = await original(w, id);
      if (id !== run.contentItemId || !item) return item;
      const changed = structuredClone(item);
      changed.researchRuns.find(r => r.id === run.researchRunId)!.provider = "mock";
      return changed;
    });
    try {
      const response = await request(app.getHttpServer()).get(`/v1/agent-posts/${publishRunId}/publication?workspaceId=default&brandId=brand_default`).expect(409);
      expect(response.body.message).toContain("live research receipt");
    } finally { spy.mockRestore(); }
  });

  it("pauses for Codex, binds the upload to its brief and resumes without an image provider call", async () => {
    const before = generate.mock.calls.length;
    const started = await request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", "codex-upload")
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        templateId,
        input: "The city council opened a public library today.",
        imageMode: "codex-upload",
      })
      .expect(201);
    await research(started.body.id);
    let run = await advance(started.body.id);
    run = await advance(run.id);
    expect(run.status).toBe("reviewing-copy");
    run = await advance(run.id);
    expect(run.status).toBe("awaiting-image");
    expect(
      (await infrastructure.agentPostRepository.pending()).map((r) => r.id),
    ).not.toContain(run.id);
    expect((await advance(run.id)).version).toBe(run.version);
    const route = `/v1/agent-posts/${run.id}`;
    const brief = await request(app.getHttpServer())
      .get(`${route}/image-brief?brandId=brand_default`)
      .expect(200);
    expect(brief.body).toMatchObject({
      evidenceHash: run.evidenceHash,
      template: { logo: run.template.logo },
      evidence: { claims: expect.any(Array) },
    });
    expect(brief.body.prompt).toContain("Do not render words");
    expect(brief.body.prompt).toContain("lower 45% for the headline");
    await request(app.getHttpServer())
      .get(`${route}/image-brief?brandId=missing-brand`)
      .expect(404);
    const upload = await request(app.getHttpServer())
      .post("/v1/media-assets/uploads")
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        kind: "image",
        purpose: "creative",
        fileName: "codex-image.png",
        contentType: "image/png",
        sizeBytes: 1,
        sha256: createHash("sha256")
          .update(memoryFixtureFor("image/png"))
          .digest("hex"),
        rights: "owned",
        altText: "Codex illustration",
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/media-assets/${upload.body.asset.id}/complete`)
      .send({ workspaceId: "default" })
      .expect(200);
    const payload = {
      workspaceId: "default",
      brandId: "brand_default",
      expectedVersion: run.version,
      mediaId: upload.body.asset.id,
      briefHash: brief.body.briefHash,
    };
    await request(app.getHttpServer())
      .post(`${route}/image`)
      .send({ ...payload, expectedVersion: run.version - 1 })
      .expect(409);
    await request(app.getHttpServer())
      .post(`${route}/image`)
      .send({ ...payload, briefHash: "0".repeat(64) })
      .expect(409);
    await request(app.getHttpServer())
      .post(`${route}/image`)
      .send({ ...payload, mediaId: run.template.logo.mediaId })
      .expect(409);
    const accepted = await request(app.getHttpServer())
      .post(`${route}/image`)
      .send(payload)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`${route}/image`)
      .send(payload)
      .expect(201);
    expect(replay.body.version).toBe(accepted.body.version);
    expect(
      await infrastructure.agentPostRepository.referencesAsset(
        "default",
        upload.body.asset.id,
      ),
    ).toBe(true);
    expect(
      await infrastructure.agentPostRepository.referencesAsset(
        "other",
        upload.body.asset.id,
      ),
    ).toBe(false);
    for (let i = 0; i < 8 && run.status !== "ready"; i++)
      run = await advance(run.id);
    expect(run, JSON.stringify(run)).toMatchObject({
      status: "ready",
      outputMediaId: expect.any(String),
    });
    expect(generate.mock.calls.length).toBe(before);
    const output = await infrastructure.mediaRepository.get(
      "default",
      run.outputMediaId!,
    );
    expect(output?.syntheticLineage).toMatchObject({
      provenance: "editor-attested-codex-upload",
      disclosureRequired: true,
    });
    expect(output?.syntheticLineage?.generatedAt).toBeUndefined();
    expect(
      (
        await infrastructure.mediaRepository.get(
          "default",
          upload.body.asset.id,
        )
      )?.syntheticLineage,
    ).toBeUndefined();
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    expect(item.drafts.at(-1)?.containsSyntheticMedia).toBe(true);
    expect(item.approvals).toHaveLength(0);
  }, 30000);
  it("offers Codex uploads when the server image provider is disabled", async () => {
    const images = app.get(ImageGenerationService);
    const original = images.capability("default", {
      id: "post-owner",
      name: "Post Owner",
      role: "owner",
    });
    const spy = vi
      .spyOn(images, "capability")
      .mockReturnValue({ ...original, generation: false });
    try {
      const capability = await request(app.getHttpServer())
        .get("/v1/agent-posts/capability?brandId=brand_default")
        .expect(200);
      expect(capability.body).toMatchObject({
        available: false,
        codexUpload: true,
      });
      await request(app.getHttpServer())
        .post("/v1/agent-posts")
        .set("Idempotency-Key", "codex-provider-disabled")
        .send({
          workspaceId: "default",
          brandId: "brand_default",
          templateId,
          input: "The city council opened a public library today.",
          imageMode: "codex-upload",
        })
        .expect(201);
    } finally {
      spy.mockRestore();
    }
  });
  it("rejects a Codex brief after source evidence changes", async () => {
    const started = await request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", "codex-evidence-change")
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        templateId,
        input: "The city council opened a public library today.",
        imageMode: "codex-upload",
      })
      .expect(201);
    await research(started.body.id);
    await advance(started.body.id);
    const run = await advance(started.body.id);
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    item.claims[0]!.text = "A different claim";
    vi.spyOn(infrastructure.repository, "get").mockResolvedValueOnce(item);
    await request(app.getHttpServer())
      .get(`/v1/agent-posts/${run.id}/image-brief?brandId=brand_default`)
      .expect(409);
  });
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
  it("blocks changed evidence before writing or generating", async () => {
    const started = await start("changed-evidence");
    await research(started.body.id);
    const run = await advance(started.body.id);
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    await request(app.getHttpServer())
      .post(`/v1/content-items/${item.id}/sources?workspaceId=default`)
      .set("If-Match", String(item.version))
      .send({
        kind: "note",
        title: "New evidence",
        notes: "A correction arrived",
        rights: "unknown",
        confidence: 0,
      })
      .expect(201);
    expect(await advance(run.id)).toMatchObject({
      status: "blocked",
      error: expect.stringContaining("evidence changed"),
    });
  });
  it("returns a validation error for an invalid template", async () => {
    await request(app.getHttpServer())
      .post("/v1/agent-posts/templates")
      .send({
        workspaceId: "default",
        brandId: "brand_default",
        template: { name: "Incomplete" },
      })
      .expect(400);
  });
  it("prevents deleting an original logo used by a saved template", async () => {
    const template = (await infrastructure.agentPostRepository.template(
      "default",
      templateId,
    ))!;
    const logo = (await infrastructure.mediaRepository.get(
      "default",
      template.logo.mediaId,
    ))!;
    await request(app.getHttpServer())
      .post(`/v1/media-assets/${logo.id}/trash`)
      .send({ workspaceId: "default", version: logo.version })
      .expect(403);
  });

  it("stores revisions in the same conversation and preserves the original story", async () => {
    const original = (await start("success")).body;
    const body = {
      workspaceId: "default",
      brandId: "brand_default",
      templateId,
      input: original.input,
      parentRunId: original.id,
      direction: "Make the caption shorter.",
    };
    const revised = await request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", "revision")
      .send(body)
      .expect(201);
    expect(revised.body).toMatchObject({
      conversationId: original.conversationId,
      parentRunId: original.id,
      requestMessage: "Make the caption shorter.",
      input: original.input,
    });
    expect(revised.body.template.skills).toEqual(["clear-language"]);
    await request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", "revision")
      .send({ ...body, direction: "Different request" })
      .expect(409);
    await request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", "wrong-story")
      .send({ ...body, input: "A different story" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/v1/agent-posts")
      .set("Idempotency-Key", "unknown-parent")
      .send({ ...body, parentRunId: "missing" })
      .expect(404);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("keeps review separate from writing and blocks a failed check before paid image creation", async () => {
    const before = generate.mock.calls.length;
    const started = await start("copy-review-rejected");
    await research(started.body.id);
    let run = await advance(started.body.id);
    run = await advance(run.id);
    expect(run.status).toBe("reviewing-copy");
    review.mockResolvedValueOnce({
      provider: "test-review",
      model: "test-model",
      text: JSON.stringify({
        checks: ["facts", "attribution", "language", "visual-direction"].map(
          (category) => ({
            category,
            verdict: category === "facts" ? "needs-changes" : "pass",
            explanation: "The relative date needs a verified reference.",
          }),
        ),
      }),
    });
    run = await advance(run.id);
    expect(run.status).toBe("blocked");
    expect(run.copyReview).toMatchObject({
      status: "needs-changes",
      evidenceHash: run.evidenceHash,
      model: "test-model",
    });
    expect(generate.mock.calls.length).toBe(before);
    const call = review.mock.calls.at(-1) as unknown as [
      { messages: { role: string; content: string }[] },
    ];
    expect(call[0].messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    const packet = JSON.parse(call[0].messages[1].content);
    expect(packet.copy).toEqual(run.copy);
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    expect(packet.claims).toEqual(item.claims);
    expect(packet.sources).toEqual(item.sources);
    expect(item.approvals).toHaveLength(0);
  });
  it("rejects repeated review categories instead of accepting four apparent passes", async () => {
    const before = generate.mock.calls.length;
    const started = await start("copy-review-malformed");
    await research(started.body.id);
    let run = await advance(started.body.id);
    run = await advance(run.id);
    review.mockResolvedValueOnce({
      provider: "test-review",
      model: "test-model",
      text: JSON.stringify({
        checks: Array.from({ length: 4 }, () => ({
          category: "facts",
          verdict: "pass",
          explanation: "Untrustworthy duplicate.",
        })),
      }),
    });
    run = await advance(run.id);
    expect(run.status).toBe("blocked");
    expect(run.copyReview).toBeUndefined();
    expect(generate.mock.calls.length).toBe(before);
  });

  it("binds chat publication to approval, native disclosure and one durable target", async () => {
    const run = (await infrastructure.agentPostRepository.get(
      "default",
      publishRunId,
    ))!;
    const now = new Date().toISOString();
    const accountId = "agent-publish-test-account";
    await infrastructure.connectedAccountRepository.save(
      {
        id: accountId,
        workspaceId: "default",
        brandId: "brand_default",
        platform: "instagram",
        displayName: "originpost_test",
        externalAccountId: "ig-test",
        capabilities: [],
        status: "healthy",
        createdBy: "post-owner",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "test-account-event",
        workspaceId: "default",
        actorId: "post-owner",
        actorType: "human",
        action: "test.account",
        detail: {},
        createdAt: now,
      },
    );
    const path = `/v1/agent-posts/${run.id}`;
    const input = {
      workspaceId: "default",
      brandId: "brand_default",
      recipientId: "originpost.publisher",
      accountId,
      scheduledFor: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    await request(app.getHttpServer())
      .get(`${path}/publication?brandId=brand_default`)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ draftId: run.draftId, targets: [] }),
      );
    await request(app.getHttpServer())
      .post(`${path}/publication-preview`)
      .send({ ...input, recipientId: "arbitrary-agent" })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${path}/publication-preview`)
      .send({ ...input, brandId: "other" })
      .expect(404);
    await request(app.getHttpServer())
      .post(`${path}/publication-preview`)
      .send(input)
      .expect(409)
      .expect(({ body }) => expect(body.message).toMatch(/test connection/i));
    const connector = infrastructure.connectors.get("instagram");
    const originalMode = connector.manifest.apiMode;
    const validate = vi.spyOn(connector, "validate");
    try {
      connector.manifest.apiMode = "official";
      await request(app.getHttpServer())
        .post(`${path}/publication-preview`)
        .send(input)
        .expect(409)
        .expect(({ body }) =>
          expect(body.message).toMatch(/Approve this exact draft/),
        );
      const item = (await infrastructure.repository.get(
        "default",
        run.contentItemId,
      ))!;
      await request(app.getHttpServer())
        .post(`/v1/content-items/${item.id}/approvals`)
        .set("If-Match", String(item.version))
        .send({ decision: "approved", draftId: run.draftId })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${path}/publication-preview`)
        .send(input)
        .expect(409)
        .expect(({ body }) =>
          expect(body.message).toMatch(/native AI info label/),
        );
      connector.manifest.apiMode = "mock";
      const candidate = await request(app.getHttpServer())
        .post(`/v1/content-items/${item.id}/instagram-collaborators/candidates`)
        .send({
          draftId: run.draftId,
          accountId,
          collaborators: [],
          isAiGenerated: true,
        })
        .expect(201);
      connector.manifest.apiMode = "official";
      await request(app.getHttpServer())
        .post(`${path}/publication-preview`)
        .send(input)
        .expect(409)
        .expect(({ body }) =>
          expect(body.message).toMatch(/latest Instagram publishing options/),
        );
      connector.manifest.apiMode = "mock";
      await request(app.getHttpServer())
        .post(
          `/v1/content-items/${item.id}/instagram-collaborators/candidates/${candidate.body.id}/approve`,
        )
        .send({})
        .expect(201);
      connector.manifest.apiMode = "official";
      const preview = await request(app.getHttpServer())
        .post(`${path}/publication-preview`)
        .send(input)
        .expect(201);
      expect(preview.body).toMatchObject({
        mode: "official",
        nativeAiLabel: true,
      });
      const command = {
        ...input,
        previewHash: preview.body.previewHash,
        contentVersion: preview.body.contentVersion,
      };
      await request(app.getHttpServer())
        .post(`${path}/publication`)
        .send({ ...command, previewHash: "a".repeat(64) })
        .expect(409);
      await request(app.getHttpServer())
        .post(`/v1/content-items/${item.id}/review-comments`)
        .set("If-Match", String(preview.body.contentVersion))
        .send({
          draftId: run.draftId,
          audience: "internal",
          body: "Check the new editorial note before publishing.",
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${path}/publication`)
        .send(command)
        .expect(409);
      const refreshed = await request(app.getHttpServer())
        .post(`${path}/publication-preview`)
        .send(input)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/content-items/${item.id}/schedule`)
        .set("If-Match", String(refreshed.body.contentVersion))
        .send({
          ...refreshed.body.schedule,
          targetId: "target_existing_editor_request",
        })
        .expect(201);
      const withConflict = await request(app.getHttpServer())
        .post(`${path}/publication-preview`)
        .send(input)
        .expect(201);
      expect(withConflict.body.conflicts.requiresConfirmation).toBe(true);
      const fresh = {
        ...input,
        previewHash: withConflict.body.previewHash,
        contentVersion: withConflict.body.contentVersion,
        conflictAcknowledgementSha256:
          withConflict.body.conflicts.acknowledgementSha256,
      };
      await request(app.getHttpServer())
        .post(`${path}/publication`)
        .send({ ...fresh, conflictAcknowledgementSha256: undefined })
        .expect(409);

      const results = await Promise.all([
        request(app.getHttpServer()).post(`${path}/publication`).send(fresh),
        request(app.getHttpServer()).post(`${path}/publication`).send(fresh),
      ]);
      expect(
        results.filter((result) => result.status === 201).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        results.every(
          (result) => result.status === 201 || result.status === 409,
        ),
      ).toBe(true);
      const replay = await request(app.getHttpServer())
        .post(`${path}/publication`)
        .send(fresh)
        .expect(201);
      expect(replay.body).toMatchObject({
        replayed: true,
        target: { status: "queued", accountId, draftId: run.draftId },
      });
      const stored = (await infrastructure.repository.get("default", item.id))!;
      expect(
        stored.targets.filter((t) => t.id === replay.body.target.id),
      ).toHaveLength(1);
      const outbox = await infrastructure.outboxRepository.list("default");
      expect(
        outbox.filter(
          (message) =>
            message.dedupeKey === `publish-target:${replay.body.target.id}`,
        ),
      ).toHaveLength(1);
      await request(app.getHttpServer())
        .post(`${path}/publication`)
        .send({
          ...fresh,
          scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
        .expect(409);
      await expect(
        app.get(AgentPostPublishingService).publish("default", run.id, fresh, {
          id: "agent",
          name: "Agent",
          role: "owner",
          actorType: "agent",
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    } finally {
      connector.manifest.apiMode = originalMode;
      validate.mockRestore();
    }
  });
  it("applies selected writing skills and treats example captions as style only", () => {
    const call = text.mock.calls[0] as unknown as [
      { messages: { content: string }[] },
    ];
    const context = JSON.parse(call[0].messages[1].content);
    expect(context.writingSkills[0]).toContain("everyday language");
    expect(context.styleExampleOnly).toContain("specific opening");
    expect(context.exampleRule).toContain("Never copy its facts");
  });
  it("sends the actual card and logo pixels without the expected headline or footer in its OCR prompt", async () => {
    const call = vision.mock.calls[0] as unknown as [
      { imageInputs: { dataUrl: string }[]; messages: { content: string }[] },
    ];
    expect(call[0].imageInputs).toHaveLength(2);
    const pixelBytes = Buffer.from(
      call[0].imageInputs[0]!.dataUrl.split(",")[1]!,
      "base64",
    );
    const run = (await infrastructure.agentPostRepository.get(
      "default",
      publishRunId,
    ))!;
    expect(createHash("sha256").update(pixelBytes).digest("hex")).toBe(
      run.imageReview!.image.sha256,
    );
    expect(
      call[0].messages.map((message) => message.content).join(" "),
    ).not.toContain(run.copy!.headline);
    expect(
      call[0].messages.map((message) => message.content).join(" "),
    ).not.toContain(run.template.footer);
    expect(run.imageReview!.logo).toEqual(run.template.logo);
  });
  it("composes and verifies the template's exact localized illustration label", async()=>{
    const generationRequest = vi.spyOn(app.get(ImageGenerationService), "create");
    const original=(await infrastructure.agentPostRepository.template("default",templateId))!;
    const {id,workspaceId,brandId,createdBy,createdAt,logo,references,...input}=original;
    const label="AI દ્વારા બનાવેલ પ્રતીકાત્મક તસવીર";
    const saved=await request(app.getHttpServer()).post("/v1/agent-posts/templates").send({workspaceId:"default",brandId:"brand_default",template:{...input,name:"Localized label",layout:"headline-top",disclosureText:label}}).expect(201);
    const started=await start("localized-image-label",saved.body.id);
    await research(started.body.id);
    let run=await advance(started.body.id);
    for(let i=0;i<10&&run.status!=="reviewing-image";i++)run=await advance(run.id);
    expect(run.status).toBe("reviewing-image");
    expect(generationRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({prompt: expect.stringContaining("Reserve the top 48% for the headline")}), expect.anything(), expect.anything());
    generationRequest.mockRestore();
    vision.mockResolvedValueOnce({provider:"test-vision",model:"test-vision-model",text:JSON.stringify({observedHeadline:run.copy!.headline,observedFooter:run.template.footer,observedDisclosure:label,checks:["legibility","branding","visual-integrity","disclosure"].map(category=>({category,verdict:"pass",explanation:"Visible text matches the supplied pixels."}))})});
    run=await advance(run.id);
    expect(run.imageReview).toMatchObject({status:"passed",textMatches:{disclosure:true}});
    const uploadRun = await request(app.getHttpServer()).post("/v1/agent-posts").set("Idempotency-Key", "top-headline-upload-guide").send({workspaceId:"default",brandId:"brand_default",templateId:saved.body.id,input:"The city council opened a public library today.",imageMode:"codex-upload"}).expect(201);
    await research(uploadRun.body.id);
    let waiting = await advance(uploadRun.body.id);
    for(let i=0;i<5&&waiting.status!=="awaiting-image";i++)waiting=await advance(waiting.id);
    expect(waiting.status).toBe("awaiting-image");
    const brief = await request(app.getHttpServer()).get(`/v1/agent-posts/${waiting.id}/image-brief?brandId=brand_default`).expect(200);
    expect(brief.body.prompt).toContain("Reserve the top 48% for the headline");
    expect(brief.body.prompt).not.toContain("lower 45%");
  });
  it("blocks text overflow before requesting a paid image", async () => {
    const before = generate.mock.calls.length;
    text.mockResolvedValueOnce({text:JSON.stringify({headline:"X".repeat(120),caption:"A library opened. Which book would you borrow? Source: City council. #Library",visualDirection:"Illustrated books without words or logos."})});
    const started = await start("preflight-overflow");
    await research(started.body.id);
    let run = await advance(started.body.id);
    for(let i=0;i<5&&run.status!=="blocked";i++)run=await advance(run.id);
    expect(run.status).toBe("blocked");
    expect(run.error).toContain("does not fit");
    expect(run.generationId).toBeUndefined();
    expect(generate.mock.calls.length).toBe(before);
  });
  it("keeps the rendered image and blocks a mismatched OCR result before making a draft", async () => {
    const started = await start("image-text-mismatch");
    await research(started.body.id);
    let run = await advance(started.body.id);
    for (let i = 0; i < 10 && run.status !== "reviewing-image"; i++)
      run = await advance(run.id);
    expect(run.status).toBe("reviewing-image");
    vision.mockResolvedValueOnce({
      provider: "test-vision",
      model: "test-vision-model",
      text: JSON.stringify({
        observedHeadline: "100 libraries opened",
        observedFooter: "City news",
        observedDisclosure: "AI illustration",
        checks: [
          "legibility",
          "branding",
          "visual-integrity",
          "disclosure",
        ].map((category) => ({
          category,
          verdict: "pass",
          explanation: "Even apparent passes cannot override incorrect text.",
        })),
      }),
    });
    run = await advance(run.id);
    expect(run.status).toBe("blocked");
    expect(run.outputMediaId).toBeTruthy();
    expect(run.imageReview).toMatchObject({
      status: "needs-changes",
      textMatches: { headline: false },
    });
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    expect(item.drafts).toHaveLength(0);
    expect(item.approvals).toHaveLength(0);
    expect((await advance(run.id)).version).toBe(run.version);
  });
  it("rejects changed stored image bytes before invoking the vision provider", async () => {
    const run = (await infrastructure.agentPostRepository.get(
      "default",
      publishRunId,
    ))!;
    const item = (await infrastructure.repository.get(
      "default",
      run.contentItemId,
    ))!;
    const asset = (await infrastructure.mediaRepository.get(
      "default",
      run.outputMediaId!,
    ))!;
    const read = infrastructure.mediaObjectStore.read.bind(
      infrastructure.mediaObjectStore,
    );
    const before = vision.mock.calls.length;
    const spy = vi
      .spyOn(infrastructure.mediaObjectStore, "read")
      .mockImplementation(async (key) => {
        const result = await read(key);
        return key === asset.objectKey
          ? { ...result, body: Buffer.from("changed bytes") }
          : result;
      });
    try {
      await expect(
        app.get(AgentPostImageReviewService).review(run, item, {
          id: "post-owner",
          name: "Owner",
          role: "owner",
        }),
      ).rejects.toMatchObject({ code: "image_changed" });
      expect(vision.mock.calls.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
