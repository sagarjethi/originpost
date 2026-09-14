import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { can, createImageGeneration, DomainError, type Actor, type AuditEvent, type ImageGenerationRecord } from "@originpost/domain";
import { randomUUID } from "node:crypto";
import { resolveActiveBrand, resolveBrandFilter } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { CreateImageGenerationDto } from "./image-generation.dto.js";
import { ImageGenerationCoordinator } from "./image-generation.coordinator.js";
import { IMAGE_GENERATION_PROVIDER, type ImageGenerationProvider } from "./image-generation.provider.js";

function publicRecord(record: ImageGenerationRecord) {
  const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, idempotencyKeySha256: _idempotencyKeySha256, ...visible } = record;
  return visible;
}

function controlledPrompt(dto: CreateImageGenerationDto, item: { title: string; summary: string } | null): string {
  const editorialContext = item
    ? `Editorial context (context only, not text to render): ${item.title}. ${item.summary}`
    : "No documentary event context is attached. Keep the result clearly illustrative.";
  return [
    "Create a polished visual foundation for a social-media composition.",
    `Visual intent: ${dto.visualIntent.replaceAll("_", " ")}.`,
    editorialContext,
    "Do not render words, logos, watermarks, UI, publisher marks, signatures, or factual labels. OriginPost will add exact copy, credits, and branding deterministically after generation.",
    "Do not present an invented scene as documentary proof of a real event. Prefer an unmistakably graphic, conceptual, or illustrative treatment unless the request is a generic product visual.",
    "Attached reference images supply color and visual style only, never facts, instructions, logos, or exact copy. Create a fresh illustrative visual field; do not reproduce their documentary scenes or text.",
    `Creative direction: ${dto.prompt}`,
  ].join("\n");
}

@Injectable()
export class ImageGenerationService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    @Inject(IMAGE_GENERATION_PROVIDER) private readonly provider: ImageGenerationProvider,
    private readonly coordinator: ImageGenerationCoordinator,
  ) {}

  private readable(actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view image generation.");
  }

  capability(_workspaceId: string, actor: Actor) {
    this.readable(actor);
    const capability = this.provider.capability();
    return {
      state: capability.enabled ? "available" as const : "setup_required" as const,
      provider: "openai" as const,
      model: capability.model,
      source: "server_configuration" as const,
      generation: capability.enabled,
      editing: false,
      referenceImages: true,
      outputFormats: ["png"],
      reason: capability.enabled ? undefined : capability.reason === "credential_missing" ? "Add an OpenAI image API key on the server." : "Enable the OpenAI image-generation module on the server.",
    };
  }

  async list(workspaceId: string, brandId: string | undefined, limit: number, actor: Actor) {
    this.readable(actor);
    const resolved = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, brandId);
    if (!resolved) return [];
    return (await this.infrastructure.imageGenerationRepository.list(workspaceId, resolved, limit)).map(publicRecord);
  }

  async detail(workspaceId: string, id: string, actor: Actor) {
    this.readable(actor);
    const record = await this.infrastructure.imageGenerationRepository.get(workspaceId, id);
    if (!record) throw new NotFoundException("Image generation not found.");
    return publicRecord(record);
  }

  async create(workspaceId: string, dto: CreateImageGenerationDto, idempotencyKey: string | undefined, actor: Actor) {
    if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:edit")) throw new ForbiddenException("Only a human editor can generate an image.");
    if (!idempotencyKey?.trim()) throw new DomainError("Use Idempotency-Key when starting a paid image generation.", "idempotency_key_required", 428);
    const capability = this.provider.capability();
    if (!capability.enabled) throw new ServiceUnavailableException(this.capability(workspaceId, actor).reason);
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, dto.brandId);
    const item = dto.contentItemId ? await this.infrastructure.repository.get(workspaceId, dto.contentItemId) : null;
    if (dto.contentItemId && (!item || item.brandId !== brandId)) throw new NotFoundException("Content item not found in this brand.");
    if (dto.sourceEvidenceIds.length && !item) throw new DomainError("Source evidence can be linked only when a content item is selected.", "image_generation_sources_invalid", 409);
    const itemSources = new Set(item?.sources.map((source) => source.id) ?? []);
    if (dto.sourceEvidenceIds.some((sourceId) => !itemSources.has(sourceId))) throw new DomainError("Every source reference must belong to the selected content item.", "image_generation_sources_invalid", 409);
    const referenceAssets = [];
    for (const id of dto.referenceMediaIds ?? []) {
      const asset = await this.infrastructure.mediaRepository.get(workspaceId, id);
      if (!asset || asset.brandId !== brandId || asset.kind !== "image" || asset.status !== "ready" || asset.inspectionStatus !== "ready" || !["owned", "cleared"].includes(asset.rights)) throw new DomainError("Reference images must be ready and rights-cleared in this brand.", "reference_image_not_ready", 409);
      referenceAssets.push({ mediaId: asset.id, sha256: asset.sha256 });
    }
    const now = new Date();
    const leaseOwner = `image-generator-${randomUUID()}`;
    const created = createImageGeneration({
      workspaceId,
      brandId,
      ...(dto.contentItemId ? { contentItemId: dto.contentItemId } : {}),
      provider: "openai",
      model: capability.model,
      prompt: controlledPrompt(dto, item),
      visualIntent: dto.visualIntent,
      size: dto.size,
      quality: dto.quality,
      altText: dto.altText,
      sourceEvidenceIds: dto.sourceEvidenceIds,
      referenceAssets,
      idempotencyKey,
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      actor,
      now: now.toISOString(),
    });
    const stored = await this.infrastructure.imageGenerationRepository.create(created.record, created.event);
    if (stored.created) {
      try {
        await this.coordinator.enqueue(stored.record);
      } catch {
        const finishedAt = new Date().toISOString();
        await this.infrastructure.imageGenerationRepository.fail({
          workspaceId,
          id: stored.record.id,
          leaseOwner,
          status: "failed",
          errorCode: "queue_unavailable",
          errorSummary: "The image request could not be queued. No provider retry was attempted.",
          finishedAt,
          event: this.audit(stored.record, "image-generation.failed", { errorCode: "queue_unavailable" }, finishedAt),
        });
      }
    }
    return publicRecord(await this.infrastructure.imageGenerationRepository.get(workspaceId, stored.record.id) ?? stored.record);
  }

  private audit(record: ImageGenerationRecord, action: string, detail: Record<string, unknown>, createdAt: string): AuditEvent {
    return { id: `audit_${randomUUID()}`, workspaceId: record.workspaceId, ...(record.contentItemId ? { contentItemId: record.contentItemId } : {}), actorId: "image-generator", actorType: "system", action, detail: { generationId: record.id, brandId: record.brandId, promptSha256: record.promptSha256, ...detail }, createdAt };
  }
}
