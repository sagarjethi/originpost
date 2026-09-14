import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCreativeRender, type Actor, type AuditEvent, type CreativeRender } from "@originpost/domain";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { MediaService } from "../media/media.service.js";
import { boundedObjectBytes, CREATIVE_FONT_VERSION, CREATIVE_RENDERER_VERSION, CREATIVE_TEMPLATE_VERSION, CreativeRenderFailure, renderCreativeImage } from "./creative-renderer.js";

const QUEUE = "originpost-creative-render";
type RenderJob = { workspaceId: string; projectId: string; renderId: string; leaseOwner: string };

function redisConnection(value: string) {
  const url = new URL(value);
  return { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: url.password } : {}), ...(url.username ? { username: url.username } : {}) };
}

@Injectable()
export class CreativeRenderCoordinator implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(CreativeRenderCoordinator.name);
  private queue: Queue<RenderJob> | null = null;
  private worker: Worker<RenderJob> | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly media: MediaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>("REDIS_URL");
    if (redisUrl) {
      const connection = redisConnection(redisUrl);
      this.queue = new Queue<RenderJob>(QUEUE, { connection });
      this.worker = new Worker<RenderJob>(QUEUE, async (job) => this.process(job.data), { connection, concurrency: 2 });
      this.worker.on("failed", (job, error) => this.logger.error(`Creative render job ${job?.id ?? "unknown"} failed: ${error.message}`));
    }
    this.recoveryTimer = setInterval(() => void this.recoverExpired().catch((error) => this.logger.error("Creative render recovery failed", error instanceof Error ? error.stack : undefined)), 60_000);
    this.recoveryTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await Promise.all([this.worker?.close(), this.queue?.close()]);
  }

  async enqueue(render: CreativeRender): Promise<void> {
    if (!render.leaseOwner) throw new Error("Creative render does not have an active lease.");
    const payload = { workspaceId: render.workspaceId, projectId: render.projectId, renderId: render.id, leaseOwner: render.leaseOwner };
    if (!this.queue) {
      await this.process(payload);
      return;
    }
    await this.queue.add("render", payload, { jobId: `creative-${render.id}-attempt-${render.attemptCount}`, attempts: 1, removeOnComplete: 200, removeOnFail: 500 });
  }

  async recoverExpired(): Promise<number> {
    let recovered = 0;
    for (const workspace of await this.infrastructure.organizationRepository.listWorkspaces()) {
      const projects = await this.infrastructure.creativeStudioRepository.listProjects(workspace.id, undefined, 200);
      for (const project of projects.filter((entry) => entry.status === "rendering")) {
        const revision = await this.infrastructure.creativeStudioRepository.getRevision(workspace.id, project.id, project.currentRevisionId);
        const existing = (await this.infrastructure.creativeStudioRepository.listRenders(workspace.id, project.id, 20)).find((entry) => entry.id === project.latestRenderId);
        if (!revision || !existing || existing.rendererVersion !== CREATIVE_RENDERER_VERSION) continue;
        const now = new Date();
        const leaseOwner = `creative-recovery-${randomUUID()}`;
        const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
        const candidate = createCreativeRender({ project, revision, rendererVersion: CREATIVE_RENDERER_VERSION, templateVersion: CREATIVE_TEMPLATE_VERSION, fontVersion: CREATIVE_FONT_VERSION, leaseOwner, leaseExpiresAt, actorId: "creative-renderer", now: now.toISOString() });
        const started = await this.infrastructure.creativeStudioRepository.startRender({ workspaceId: workspace.id, projectId: project.id, expectedVersion: project.version, render: candidate, updatedBy: "creative-renderer", updatedAt: now.toISOString(), leaseOwner, leaseExpiresAt, event: this.audit(candidate, "creative.render-recovered", { previousRenderId: existing.id, previousAttemptCount: existing.attemptCount }) });
        if (started?.started) { recovered += 1; await this.enqueue(started.render) }
      }
    }
    return recovered;
  }

  private audit(render: CreativeRender, action: string, detail: Record<string, unknown>): AuditEvent {
    return {
      id: `audit_${randomUUID()}`,
      workspaceId: render.workspaceId,
      ...(render.specSnapshot.contentItemId ? { contentItemId: render.specSnapshot.contentItemId } : {}),
      actorId: "creative-renderer",
      actorType: "system",
      action,
      detail: { projectId: render.projectId, revisionId: render.revisionId, renderId: render.id, renderManifestSha256: render.renderManifestSha256, ...detail },
      createdAt: new Date().toISOString(),
    };
  }

  private async process(input: RenderJob): Promise<void> {
    const project = await this.infrastructure.creativeStudioRepository.getProject(input.workspaceId, input.projectId);
    const render = (await this.infrastructure.creativeStudioRepository.listRenders(input.workspaceId, input.projectId, 50)).find((entry) => entry.id === input.renderId);
    if (!project || !render || render.status !== "rendering" || render.leaseOwner !== input.leaseOwner || project.latestRenderId !== render.id) return;
    const source = await this.infrastructure.mediaRepository.get(input.workspaceId, render.specSnapshot.sourceMediaId);
    const actor: Actor = { id: "creative-renderer", name: "Creative renderer", role: "owner", actorType: "system" };
    try {
      if (!source || source.workspaceId !== render.workspaceId || source.brandId !== render.brandId || source.sha256 !== render.specSnapshot.sourceMediaSha256 || source.kind !== "image" || source.status !== "ready" || source.inspectionStatus !== "ready" || !["owned", "cleared"].includes(source.rights)) {
        throw new CreativeRenderFailure("source_not_renderable", "The source image is no longer ready, rights-cleared, or bound to this revision.", "sourceMediaId");
      }
      const stored = await this.infrastructure.mediaObjectStore.read(source.objectKey);
      const sourceBytes = await boundedObjectBytes(stored.body);
      let logoBytes: Buffer | undefined;
      if (render.specSnapshot.logo) {
        const logo = await this.infrastructure.mediaRepository.get(render.workspaceId, render.specSnapshot.logo.mediaId);
        if (!logo || logo.brandId !== render.brandId || logo.status !== "ready" || logo.inspectionStatus !== "ready" || !["owned", "cleared"].includes(logo.rights) || logo.sha256 !== render.specSnapshot.logo.sha256 || logo.syntheticLineage) throw new CreativeRenderFailure("logo_not_ready", "The approved logo changed or is no longer usable.", "logo");
        logoBytes = await boundedObjectBytes((await this.infrastructure.mediaObjectStore.read(logo.objectKey)).body);
      }
      const rendered = await renderCreativeImage(render.specSnapshot, sourceBytes, logoBytes);
      if (rendered.rendererVersion !== render.rendererVersion) throw new CreativeRenderFailure("renderer_version_changed", "The renderer version changed after this render was approved. Create a new revision and render again.");
      const output = await this.media.createGeneratedImage({
        id: `media_${render.id}`,
        workspaceId: render.workspaceId,
        brandId: render.brandId,
        ...(render.specSnapshot.contentItemId ? { contentItemId: render.specSnapshot.contentItemId } : {}),
        fileName: `${project.name}-${render.specSnapshot.format}.${rendered.extension}`,
        contentType: rendered.contentType,
        bytes: rendered.bytes,
        rights: source.rights as "owned" | "cleared",
        altText: render.specSnapshot.headline,
        origin: { type: "creative-render", sourceMediaId: source.id, renderId: render.id },
        ...(source.syntheticLineage ? { syntheticLineage: source.syntheticLineage } : {}),
      }, actor);
      if (output.sha256 !== rendered.sha256 || output.widthPixels !== rendered.width || output.heightPixels !== rendered.height) throw new CreativeRenderFailure("output_inspection_mismatch", "The stored output did not match the renderer's exact dimensions and hash.");
      const finishedAt = new Date().toISOString();
      const completed = await this.infrastructure.creativeStudioRepository.completeRender({
        workspaceId: render.workspaceId,
        projectId: render.projectId,
        renderId: render.id,
        outputMediaId: output.id,
        outputSha256: rendered.sha256,
        finishedAt,
        updatedBy: "creative-renderer",
        leaseOwner: input.leaseOwner,
        event: this.audit(render, "creative.render-completed", { outputMediaId: output.id, outputSha256: rendered.sha256, width: rendered.width, height: rendered.height }),
      });
      if (!completed) this.logger.warn(`Creative render ${render.id} finished after its lease was replaced; the output remains safely retained.`);
    } catch (error) {
      const safe = error instanceof CreativeRenderFailure ? error.message : "The image renderer could not complete this visual.";
      const finishedAt = new Date().toISOString();
      await this.infrastructure.creativeStudioRepository.failRender({
        workspaceId: render.workspaceId,
        projectId: render.projectId,
        renderId: render.id,
        error: safe.slice(0, 500),
        finishedAt,
        updatedBy: "creative-renderer",
        leaseOwner: input.leaseOwner,
        event: this.audit(render, "creative.render-failed", { errorCode: error instanceof CreativeRenderFailure ? error.code : "renderer_failed" }),
      });
      if (!(error instanceof CreativeRenderFailure)) this.logger.error(`Creative render ${render.id} failed`, error instanceof Error ? error.stack : undefined);
    }
  }
}
