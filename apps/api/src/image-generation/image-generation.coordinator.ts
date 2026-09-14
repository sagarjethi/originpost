import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type Actor, type AuditEvent, type ImageGenerationRecord } from "@originpost/domain";
import { Queue, Worker } from "bullmq";
import sharp from "sharp";
import { boundedObjectBytes } from "../creative-studio/creative-renderer.js";
import { createHash, randomUUID } from "node:crypto";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { MediaService } from "../media/media.service.js";
import { IMAGE_GENERATION_PROVIDER, ImageGenerationProviderError, type ImageGenerationProvider } from "./image-generation.provider.js";

const QUEUE = "originpost-image-generation";
type GenerationJob = { workspaceId: string; generationId: string; leaseOwner: string };

function redisConnection(value: string) {
  const url = new URL(value);
  return { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: url.password } : {}), ...(url.username ? { username: url.username } : {}) };
}

@Injectable()
export class ImageGenerationCoordinator implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ImageGenerationCoordinator.name);
  private queue: Queue<GenerationJob> | null = null;
  private worker: Worker<GenerationJob> | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    @Inject(IMAGE_GENERATION_PROVIDER) private readonly provider: ImageGenerationProvider,
    private readonly media: MediaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const redisUrl = this.config.get<string>("REDIS_URL");
    if (redisUrl) {
      const connection = redisConnection(redisUrl);
      this.queue = new Queue<GenerationJob>(QUEUE, { connection });
      this.worker = new Worker<GenerationJob>(QUEUE, async (job) => this.process(job.data), { connection, concurrency: 1 });
      this.worker.on("failed", (job, error) => this.logger.error(`Image generation job ${job?.id ?? "unknown"} failed: ${error.message}`));
    }
    this.recoveryTimer = setInterval(() => void this.markExpiredUncertain().catch((error) => this.logger.error("Image generation recovery failed", error instanceof Error ? error.stack : undefined)), 60_000);
    this.recoveryTimer.unref();
  }

  async onApplicationShutdown() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await Promise.all([this.worker?.close(), this.queue?.close()]);
  }

  async enqueue(record: ImageGenerationRecord) {
    if (!record.leaseOwner) throw new Error("Image generation does not have an active lease.");
    const payload = { workspaceId: record.workspaceId, generationId: record.id, leaseOwner: record.leaseOwner };
    if (!this.queue) { await this.process(payload); return; }
    await this.queue.add("generate", payload, { jobId: record.id, attempts: 1, removeOnComplete: 200, removeOnFail: 500 });
  }

  async markExpiredUncertain(): Promise<number> {
    let changed = 0;
    const now = new Date().toISOString();
    for (const workspace of await this.infrastructure.organizationRepository.listWorkspaces()) {
      const records = await this.infrastructure.imageGenerationRepository.list(workspace.id, undefined, 200);
      for (const record of records) {
        if (record.status !== "generating" || !record.leaseOwner || !record.leaseExpiresAt || record.leaseExpiresAt > now) continue;
        const result = await this.infrastructure.imageGenerationRepository.fail({
          workspaceId: record.workspaceId,
          id: record.id,
          leaseOwner: record.leaseOwner,
          status: "uncertain",
          errorCode: "generation_result_uncertain",
          errorSummary: "The provider call did not finish before its lease expired. It was not retried automatically to avoid duplicate paid output.",
          finishedAt: now,
          event: this.audit(record, "image-generation.uncertain", { errorCode: "generation_result_uncertain" }, now),
        });
        if (result) changed += 1;
      }
    }
    return changed;
  }

  private async process(input: GenerationJob) {
    const record = await this.infrastructure.imageGenerationRepository.get(input.workspaceId, input.generationId);
    if (!record || record.status !== "generating" || record.leaseOwner !== input.leaseOwner) return;
    const actor: Actor = { id: "image-generator", name: "Image generator", role: "owner", actorType: "system" };
    let providerRequestId: string | undefined;
    try {
      const referenceImages: Uint8Array[] = [];
      for (const ref of record.referenceAssets ?? []) {
        const asset = await this.infrastructure.mediaRepository.get(record.workspaceId, ref.mediaId);
        if (!asset || asset.brandId !== record.brandId || asset.status !== "ready" || asset.inspectionStatus !== "ready" || !["owned", "cleared"].includes(asset.rights) || asset.sha256 !== ref.sha256) throw new ImageGenerationProviderError("request_rejected", "An approved reference image is no longer available.");
        const bytes = await boundedObjectBytes((await this.infrastructure.mediaObjectStore.read(asset.objectKey)).body);
        if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new ImageGenerationProviderError("request_rejected", "Reference image bytes do not match the approved version.");
        referenceImages.push(await sharp(bytes, { limitInputPixels: 25_000_000 }).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer());
      }
      const result = await this.provider.generate({ requestId: record.id, prompt: record.prompt, size: record.size, quality: record.quality, ...(referenceImages.length ? { referenceImages } : {}) });
      providerRequestId = result.providerRequestId;
      const output = await this.media.createGeneratedImage({
        id: `media_${record.id}`,
        workspaceId: record.workspaceId,
        brandId: record.brandId,
        ...(record.contentItemId ? { contentItemId: record.contentItemId } : {}),
        fileName: `${record.visualIntent}-${record.id}.png`,
        contentType: "image/png",
        bytes: result.bytes,
        rights: "owned",
        altText: record.altText,
        origin: { type: "ai-generation", generationId: record.id },
        syntheticLineage: { kind: "ai-generation", generationId: record.id, provider: record.provider, model: record.model, promptSha256: record.promptSha256, generatedAt: record.createdAt, sourceEvidenceIds: record.sourceEvidenceIds, disclosureRequired: true },
      }, actor);
      const finishedAt = new Date().toISOString();
      const completed = await this.infrastructure.imageGenerationRepository.complete({
        workspaceId: record.workspaceId,
        id: record.id,
        leaseOwner: input.leaseOwner,
        outputMediaId: output.id,
        outputSha256: output.sha256,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        finishedAt,
        event: this.audit(record, "image-generation.completed", { outputMediaId: output.id, outputSha256: output.sha256, providerRequestId: result.providerRequestId, usage: result.usage }, finishedAt),
      });
      if (!completed) this.logger.warn(`Image generation ${record.id} completed after its lease was replaced; the inspected output remains in the Library.`);
    } catch (error) {
      const providerError = error instanceof ImageGenerationProviderError ? error : undefined;
      const status = providerError && ["timeout", "provider_unavailable"].includes(providerError.code) ? "uncertain" as const : "failed" as const;
      const errorCode = providerError?.code ?? "generated_media_failed";
      const errorSummary = providerError?.message ?? "The generated visual could not be inspected and saved to the Library.";
      const finishedAt = new Date().toISOString();
      await this.infrastructure.imageGenerationRepository.fail({
        workspaceId: record.workspaceId,
        id: record.id,
        leaseOwner: input.leaseOwner,
        status,
        errorCode,
        errorSummary,
        ...(providerError?.providerRequestId || providerRequestId ? { providerRequestId: providerError?.providerRequestId ?? providerRequestId } : {}),
        finishedAt,
        event: this.audit(record, status === "uncertain" ? "image-generation.uncertain" : "image-generation.failed", { errorCode, providerRequestId: providerError?.providerRequestId ?? providerRequestId }, finishedAt),
      });
      if (!providerError) this.logger.error(`Image generation ${record.id} failed after provider completion`, error instanceof Error ? error.stack : undefined);
    }
  }

  private audit(record: ImageGenerationRecord, action: string, detail: Record<string, unknown>, createdAt: string): AuditEvent {
    return { id: `audit_${randomUUID()}`, workspaceId: record.workspaceId, ...(record.contentItemId ? { contentItemId: record.contentItemId } : {}), actorId: "image-generator", actorType: "system", action, detail: { generationId: record.id, brandId: record.brandId, provider: record.provider, model: record.model, promptSha256: record.promptSha256, ...detail }, createdAt };
  }
}
