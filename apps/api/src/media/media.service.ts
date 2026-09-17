import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { createMediaDeliveryToken, verifyMediaDeliveryToken } from "@originpost/connectors";
import { can, completeMediaCleanup, DEFAULT_MEDIA_TRASH_RETENTION_DAYS, DEFAULT_MEDIA_UPLOAD_LEASE_MINUTES, failMediaCleanup, mediaCleanupReason, requestMediaTrash, restoreMediaFromTrash, type Actor, type AuditEvent, type MediaAsset, type MediaKind, type MediaPurpose, type RightsState, type ShareCaptureMedia } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { resolveActiveBrand, resolveBrandFilter } from "../common/brand-context.js";
import type { CreateMediaUploadDto } from "./media.dto.js";
import { parseSingleByteRange } from "./media-range.js";
import { MEDIA_INSPECTOR, type MediaInspectionResult, type MediaInspector } from "./media-inspector.js";
import { MEDIA_MALWARE_SCANNER, type MediaMalwareScanner, type MediaMalwareScanResult } from "./media-malware-scanner.js";

const allowedTypes: Record<MediaKind, ReadonlySet<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  video: new Set(["video/mp4", "video/quicktime", "video/webm"]),
  audio: new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm"]),
  document: new Set(["application/pdf"]),
};
const capturedMediaLimit: Record<Extract<MediaKind, "image" | "video">, number> = { image: 64 * 1024 * 1024, video: 500 * 1024 * 1024 };

function audit(asset: MediaAsset, actor: Actor, action: string, detail: Record<string, unknown>, actorType: AuditEvent["actorType"] = "human"): AuditEvent {
  return { id: `audit_${crypto.randomUUID()}`, workspaceId: asset.workspaceId, ...(asset.contentItemId ? { contentItemId: asset.contentItemId } : {}), actorId: actor.id, actorType: actor.actorType ?? actorType, action, detail: { mediaAssetId: asset.id, ...detail }, createdAt: new Date().toISOString() };
}

function safeFileName(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").at(-1) ?? "upload";
  return leaf.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "upload";
}

function publicAsset(asset: MediaAsset) {
  const { objectKey: _privateObjectKey, ...visible } = asset;
  return visible;
}

function malwareFields(result: MediaMalwareScanResult) {
  return {
    malwareScanStatus: result.status,
    malwareScannedAt: result.scannedAt,
    malwareScanner: result.scanner,
    ...(result.status === "infected" ? { malwareThreatName: result.threatName } : {}),
    ...(result.status === "unavailable" ? { malwareScanErrorCode: result.errorCode, malwareScanErrorSummary: result.errorSummary } : {}),
  } satisfies Partial<MediaAsset>;
}

function malwareAccepted(result: MediaMalwareScanResult): boolean {
  return result.status === "clean" || result.status === "disabled";
}

function malwareFailure(result: MediaMalwareScanResult): string {
  if (result.status === "infected") return `The uploaded file was quarantined because malware was detected (${result.threatName}).`;
  if (result.status === "unavailable") return result.errorSummary;
  return "The uploaded file could not pass malware scanning.";
}

function metadataAccepted(asset: Pick<MediaAsset, "kind">, result: MediaInspectionResult): boolean {
  return asset.kind === "image" || asset.kind === "video" ? result.status === "ready" : result.status === "not_applicable";
}

export interface GeneratedImageInput {
  id: string;
  workspaceId: string;
  brandId: string;
  contentItemId?: string;
  fileName: string;
  contentType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
  rights: "owned" | "cleared";
  altText?: string;
  origin: { type: "creative-render"; sourceMediaId: string; renderId: string } | { type: "ai-generation"; generationId: string };
  syntheticLineage?: MediaAsset["syntheticLineage"];
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    @Inject(MEDIA_INSPECTOR) private readonly inspector: MediaInspector,
    @Inject(MEDIA_MALWARE_SCANNER) private readonly malwareScanner: MediaMalwareScanner,
    private readonly config: ConfigService,
  ) {}

  async list(workspaceId: string, limit: number, actor: Actor, requestedBrandId?: string) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view media.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    if (!brandId) return [];
    return (await this.infrastructure.mediaRepository.list(workspaceId, limit, brandId)).map(publicAsset);
  }

  async summary(workspaceId: string, actor: Actor, requestedBrandId?: string) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view media storage.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    if (!brandId) return { totalAssets: 0, storedBytes: 0, reclaimableBytes: 0, pendingBytes: 0, counts: {} };
    return this.infrastructure.mediaRepository.summary(workspaceId, brandId);
  }

  async createUpload(dto: CreateMediaUploadDto, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot add media.");
    const contentType = dto.contentType.toLowerCase();
    if (!allowedTypes[dto.kind].has(contentType)) throw new BadRequestException(`Unsupported ${dto.kind} content type.`);
    const contentItem = dto.contentItemId ? await this.infrastructure.repository.get(dto.workspaceId, dto.contentItemId) : null;
    if (dto.contentItemId && !contentItem) throw new NotFoundException("Content item not found in this workspace.");
    if (contentItem && dto.brandId && contentItem.brandId !== dto.brandId) throw new BadRequestException("The selected media brand does not match the content item.");
    const brandId = contentItem?.brandId ?? await resolveActiveBrand(this.infrastructure.organizationRepository, dto.workspaceId, dto.brandId);
    const id = `media_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const leaseMinutes = Number(this.config.get<string>("MEDIA_UPLOAD_LEASE_MINUTES") ?? DEFAULT_MEDIA_UPLOAD_LEASE_MINUTES);
    const fileName = safeFileName(dto.fileName);
    const date = createdAt.slice(0, 10).replaceAll("-", "/");
    const asset: MediaAsset = {
      id, workspaceId: dto.workspaceId, brandId, version: 1, ...(dto.contentItemId ? { contentItemId: dto.contentItemId } : {}), kind: dto.kind,
      purpose: dto.purpose, fileName, contentType, sizeBytes: dto.sizeBytes, sha256: dto.sha256.toLowerCase(),
      objectKey: `${dto.workspaceId}/${date}/${id}/${fileName}`, status: "pending",
      inspectionStatus: dto.kind === "image" || dto.kind === "video" ? "pending" : "not_applicable", rights: dto.rights,
      malwareScanStatus: "pending",
      ...(dto.altText ? { altText: dto.altText } : {}), ...(dto.sourceUrl ? { sourceUrl: dto.sourceUrl } : {}),
      createdBy: actor.id, createdAt, uploadExpiresAt: new Date(new Date(createdAt).getTime() + leaseMinutes * 60_000).toISOString(),
    };
    const upload = await this.infrastructure.mediaObjectStore.createUpload(asset);
    await this.infrastructure.mediaRepository.save(asset, audit(asset, actor, "media.upload-requested", { kind: asset.kind, purpose: asset.purpose, sizeBytes: asset.sizeBytes, sha256: asset.sha256 }));
    return { asset: publicAsset(asset), upload };
  }

  async stageShareCapture(input: {
    objectKey: string;
    kind: Extract<MediaKind, "image" | "video">;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    body: AsyncIterable<Uint8Array>;
  }): Promise<ShareCaptureMedia> {
    const contentType = input.contentType.toLowerCase();
    if (!allowedTypes[input.kind].has(contentType)) throw new BadRequestException(`Unsupported ${input.kind} content type.`);
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > capturedMediaLimit[input.kind]) throw new BadRequestException(`The shared ${input.kind} exceeds the safe intake limit.`);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) throw new BadRequestException("The captured file hash is invalid.");
    const media: ShareCaptureMedia = {
      kind: input.kind,
      fileName: safeFileName(input.fileName),
      declaredContentType: contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      quarantineObjectKey: input.objectKey,
      inspectionStatus: "pending",
      malwareScanStatus: "pending",
    };
    await this.infrastructure.mediaObjectStore.writeCaptured({ objectKey: input.objectKey, contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 }, input.body);
    const malware = await this.scanFinalized({ sizeBytes: input.sizeBytes } as MediaAsset, input.objectKey);
    if (!malwareAccepted(malware)) {
      await this.infrastructure.mediaObjectStore.delete(input.objectKey).catch(() => undefined);
      return {
        ...media,
        quarantineObjectKey: "",
        inspectionStatus: malware.status === "unavailable" ? "unavailable" : "failed",
        ...malwareFields(malware),
        errorCode: malware.status === "infected" ? "malware_detected" : malware.status === "unavailable" ? malware.errorCode : "malware_scan_required",
        errorSummary: malwareFailure(malware),
      };
    }
    const inspection = await this.inspectFinalized({ kind: input.kind, contentType, sizeBytes: input.sizeBytes } as MediaAsset, input.objectKey);
    if (inspection.status !== "ready") {
      await this.infrastructure.mediaObjectStore.delete(input.objectKey).catch(() => undefined);
      return {
        ...media,
        quarantineObjectKey: "",
        inspectionStatus: inspection.status === "not_applicable" ? "failed" : inspection.status,
        inspectedAt: inspection.inspectedAt,
        inspector: inspection.inspector,
        ...malwareFields(malware),
        errorCode: inspection.status === "not_applicable" ? "media_inspection_required" : inspection.errorCode,
        errorSummary: inspection.status === "not_applicable" ? "The shared file could not be inspected as image or video media." : inspection.errorSummary,
      };
    }
    return {
      ...media,
      inspectionStatus: "ready",
      detectedContentType: inspection.detectedContentType,
      widthPixels: inspection.widthPixels,
      heightPixels: inspection.heightPixels,
      ...(inspection.durationMs !== undefined ? { durationMs: inspection.durationMs } : {}),
      inspectedAt: inspection.inspectedAt,
      inspector: inspection.inspector,
      ...malwareFields(malware),
    };
  }

  async materializeShareCapture(input: {
    id: string;
    workspaceId: string;
    brandId: string;
    purpose: MediaPurpose;
    rights: RightsState;
    altText?: string;
    sourceUrl?: string;
    media: ShareCaptureMedia;
    createdAt: string;
    actor: Actor;
    captureReceiptId: string;
  }) {
    if (!can(input.actor.role, "content:edit")) throw new ForbiddenException("You cannot add media.");
    if (input.media.inspectionStatus !== "ready" || !input.media.quarantineObjectKey) throw new ConflictException("The shared file is not ready for Library materialization.");
    const contentType = input.media.detectedContentType ?? input.media.declaredContentType;
    if (!allowedTypes[input.media.kind].has(contentType)) throw new BadRequestException(`Unsupported ${input.media.kind} content type.`);
    const fileName = safeFileName(input.media.fileName);
    const date = input.createdAt.slice(0, 10).replaceAll("-", "/");
    const objectKey = `${input.workspaceId}/${date}/share-captures/${input.id}/${fileName}.final-${input.media.sha256}`;
    let pending = await this.infrastructure.mediaRepository.get(input.workspaceId, input.id);
    if (pending) {
      const exact = pending.brandId === input.brandId && pending.kind === input.media.kind && pending.purpose === input.purpose
        && pending.rights === input.rights && pending.sha256 === input.media.sha256 && pending.sizeBytes === input.media.sizeBytes
        && pending.contentType === contentType && pending.objectKey === objectKey && pending.createdBy === input.actor.id;
      if (!exact) throw new ConflictException("This capture identity already belongs to another Library asset.");
      if (pending.status === "ready") return pending;
      if (pending.status !== "pending") throw new ConflictException("This captured Library asset cannot be retried.");
    } else {
      pending = {
        id: input.id,
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        version: 1,
        kind: input.media.kind,
        purpose: input.purpose,
        fileName,
        contentType,
        sizeBytes: input.media.sizeBytes,
        sha256: input.media.sha256,
        objectKey,
        status: "pending",
        inspectionStatus: "pending",
        malwareScanStatus: "pending",
        rights: input.rights,
        ...(input.altText ? { altText: input.altText } : {}),
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        createdBy: input.actor.id,
        createdAt: input.createdAt,
        uploadExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      };
      await this.infrastructure.mediaRepository.save(pending, audit(pending, input.actor, "media.share-capture-materializing", { captureReceiptId: input.captureReceiptId, sha256: pending.sha256, sizeBytes: pending.sizeBytes }));
    }
    let inspection: MediaInspectionResult | undefined;
    let malware: MediaMalwareScanResult;
    try {
      await this.infrastructure.mediaObjectStore.promoteCaptured(input.media.quarantineObjectKey, { objectKey, contentType, sizeBytes: pending.sizeBytes, sha256: pending.sha256 });
      malware = await this.scanFinalized(pending, objectKey);
      if (malwareAccepted(malware)) inspection = await this.inspectFinalized(pending, objectKey);
    } catch (error) {
      const current = await this.infrastructure.mediaRepository.get(input.workspaceId, input.id);
      if (current?.status === "ready") return current;
      throw new ServiceUnavailableException(error instanceof Error ? `The captured file could not be copied safely: ${error.message}` : "The captured file could not be copied safely. Retry this exact save.");
    }
    if (!malwareAccepted(malware)) {
      const reason = malwareFailure(malware);
      const current = await this.infrastructure.mediaRepository.get(input.workspaceId, input.id);
      if (current?.status === "ready") return current;
      if (current?.status === "pending") {
        const rejected: MediaAsset = {
          ...current,
          ...malwareFields(malware),
          version: current.version + 1,
          status: "rejected",
          inspectionStatus: "failed",
          inspectionErrorCode: "malware_scan_blocked",
          inspectionErrorSummary: reason.slice(0, 240),
          lastError: reason.slice(0, 500),
        };
        await this.infrastructure.mediaRepository.save(rejected, audit(rejected, input.actor, "media.share-capture-quarantined", { captureReceiptId: input.captureReceiptId, malwareScanStatus: malware.status, reason: rejected.lastError }));
      }
      await this.infrastructure.mediaObjectStore.delete(objectKey).catch(() => undefined);
      throw new BadRequestException(reason);
    }
    if (!inspection) throw new ServiceUnavailableException("The captured file metadata inspection did not complete.");
    if (inspection.status !== "ready") {
      const reason = inspection.status === "not_applicable" ? "The captured file is not publishable media." : inspection.errorSummary;
      const current = await this.infrastructure.mediaRepository.get(input.workspaceId, input.id);
      if (current?.status === "ready") return current;
      if (current?.status === "pending") {
        const rejected: MediaAsset = { ...current, version: current.version + 1, status: "rejected", inspectionStatus: "failed", inspectionErrorCode: "share_capture_materialization_failed", inspectionErrorSummary: reason.slice(0, 240), lastError: reason.slice(0, 500) };
        await this.infrastructure.mediaRepository.save(rejected, audit(rejected, input.actor, "media.share-capture-rejected", { captureReceiptId: input.captureReceiptId, reason: rejected.lastError }));
      }
      await this.infrastructure.mediaObjectStore.delete(objectKey).catch(() => undefined);
      throw new BadRequestException(reason);
    }
    const ready: MediaAsset = {
      ...pending,
      version: pending.version + 1,
      status: "ready",
      readyAt: new Date().toISOString(),
      inspectionStatus: "ready",
      detectedContentType: inspection.detectedContentType,
      widthPixels: inspection.widthPixels,
      heightPixels: inspection.heightPixels,
      ...(inspection.durationMs !== undefined ? { durationMs: inspection.durationMs } : {}),
      inspectedAt: inspection.inspectedAt,
      inspector: inspection.inspector,
      ...malwareFields(malware),
      lastError: undefined,
    };
    try {
      await this.infrastructure.mediaRepository.save(ready, audit(ready, input.actor, "media.share-capture-ready", { captureReceiptId: input.captureReceiptId, sha256: ready.sha256, malwareScanStatus: ready.malwareScanStatus, widthPixels: ready.widthPixels, heightPixels: ready.heightPixels, ...(ready.durationMs ? { durationMs: ready.durationMs } : {}) }));
      return ready;
    } catch (error) {
      const current = await this.infrastructure.mediaRepository.get(input.workspaceId, input.id);
      if (current?.status === "ready") return current;
      throw new ServiceUnavailableException(error instanceof Error ? `The captured file was verified but its Library record could not be finalized: ${error.message}` : "The captured file was verified but its Library record could not be finalized. Retry this exact save.");
    }
  }

  async capturedPreview(media: ShareCaptureMedia) {
    if (media.inspectionStatus !== "ready" || !media.quarantineObjectKey) throw new NotFoundException("Captured preview is unavailable.");
    const object = await this.infrastructure.mediaObjectStore.read(media.quarantineObjectKey);
    return { ...object, contentType: media.detectedContentType ?? media.declaredContentType, contentLength: object.contentLength ?? media.sizeBytes, fileName: media.fileName };
  }

  async deleteCapturedObject(objectKey: string): Promise<void> {
    if (objectKey) await this.infrastructure.mediaObjectStore.delete(objectKey);
  }

  async complete(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot complete media uploads.");
    const asset = await this.infrastructure.mediaRepository.get(workspaceId, id);
    if (!asset) throw new NotFoundException("Media asset not found.");
    if (asset.status === "ready") return publicAsset(asset);
    if (asset.status !== "pending") throw new BadRequestException("Only a pending upload can be completed.");
    if (new Date(asset.uploadExpiresAt) <= new Date()) throw new BadRequestException("This upload link expired. Start a new upload.");
    let finalizedObjectKey: string | undefined;
    let malware: MediaMalwareScanResult | undefined;
    let inspection: MediaInspectionResult | undefined;
    try {
      const finalized = await this.infrastructure.mediaObjectStore.finalize(asset);
      finalizedObjectKey = finalized.objectKey;
      malware = await this.scanFinalized(asset, finalized.objectKey);
      if (!malwareAccepted(malware)) throw new Error(malwareFailure(malware));
      inspection = await this.inspectFinalized(asset, finalized.objectKey);
      if (!metadataAccepted(asset, inspection)) {
        throw new Error(inspection.status === "failed" || inspection.status === "unavailable" ? inspection.errorSummary : "The uploaded file could not be inspected safely.");
      }
      const ready: MediaAsset = {
        ...asset,
        ...malwareFields(malware),
        version: asset.version + 1,
        objectKey: finalized.objectKey,
        status: "ready",
        readyAt: new Date().toISOString(),
        lastError: undefined,
        inspectionStatus: inspection.status,
        inspectedAt: inspection.inspectedAt,
        inspector: inspection.inspector,
        ...(inspection.status === "ready" ? {
          detectedContentType: inspection.detectedContentType,
          widthPixels: inspection.widthPixels,
          heightPixels: inspection.heightPixels,
          ...(inspection.durationMs !== undefined ? { durationMs: inspection.durationMs } : {}),
        } : {}),
        ...(inspection.status === "failed" || inspection.status === "unavailable" ? {
          inspectionErrorCode: inspection.errorCode,
          inspectionErrorSummary: inspection.errorSummary,
        } : {}),
      };
      await this.infrastructure.mediaRepository.save(ready, audit(ready, actor, "media.upload-verified", {
        sha256: ready.sha256,
        sizeBytes: ready.sizeBytes,
        malwareScanStatus: ready.malwareScanStatus,
        inspectionStatus: ready.inspectionStatus,
        ...(ready.widthPixels ? { widthPixels: ready.widthPixels } : {}),
        ...(ready.heightPixels ? { heightPixels: ready.heightPixels } : {}),
        ...(ready.durationMs ? { durationMs: ready.durationMs } : {}),
        ...(ready.inspectionErrorCode ? { inspectionErrorCode: ready.inspectionErrorCode } : {}),
      }));
      await this.infrastructure.mediaObjectStore.delete(asset.objectKey).catch(() => undefined);
      return publicAsset(ready);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Media verification failed.";
      const rejected: MediaAsset = {
        ...asset,
        ...(malware ? malwareFields(malware) : {}),
        version: asset.version + 1,
        status: "rejected",
        inspectionStatus: inspection?.status === "failed" || inspection?.status === "unavailable" ? inspection.status : "failed",
        inspectionErrorCode: malware && !malwareAccepted(malware)
          ? malware.status === "infected" ? "malware_detected" : malware.status === "unavailable" ? malware.errorCode : "malware_scan_required"
          : inspection?.status === "failed" || inspection?.status === "unavailable" ? inspection.errorCode : "media_verification_failed",
        inspectionErrorSummary: reason.slice(0, 240),
        lastError: reason.slice(0, 500),
      };
      await this.infrastructure.mediaRepository.save(rejected, audit(rejected, actor, malware && !malwareAccepted(malware) ? "media.upload-quarantined" : "media.upload-rejected", { malwareScanStatus: malware?.status, reason: rejected.lastError }));
      await Promise.all([asset.objectKey, finalizedObjectKey].filter((value): value is string => Boolean(value)).map((objectKey) => this.infrastructure.mediaObjectStore.delete(objectKey).catch(() => undefined)));
      throw new BadRequestException(reason);
    }
  }

  async createGeneratedImage(input: GeneratedImageInput, actor: Actor) { return this.createGeneratedMedia(input,actor); }
  async createGeneratedAudio(input: Omit<GeneratedImageInput, 'contentType'> & { contentType: 'audio/mpeg' }, actor: Actor) { return this.createGeneratedMedia(input,actor); }
  private async createGeneratedMedia(input: Omit<GeneratedImageInput, 'contentType'> & { contentType: 'image/jpeg' | 'image/png' | 'audio/mpeg' }, actor: Actor) {
    const kind = input.contentType === 'audio/mpeg' ? 'audio' : 'image';
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot create media.");
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > 64 * 1024 * 1024) throw new BadRequestException("The rendered image exceeds the safe 64 MB limit.");
    const contentItem = input.contentItemId ? await this.infrastructure.repository.get(input.workspaceId, input.contentItemId) : null;
    if (input.contentItemId && (!contentItem || contentItem.brandId !== input.brandId)) throw new NotFoundException("Content item not found in this brand.");
    const extension = kind === "audio" ? ".mp3" : input.contentType === "image/jpeg" ? ".jpg" : ".png";
    const fileName = safeFileName(input.fileName.toLowerCase().endsWith(extension) ? input.fileName : `${input.fileName}${extension}`);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const createdAt = new Date().toISOString();
    const existing = await this.infrastructure.mediaRepository.get(input.workspaceId, input.id);
    if (existing) {
      const sameLineage = existing.brandId === input.brandId && existing.contentItemId === input.contentItemId && existing.sha256 === sha256 && existing.kind === kind && existing.contentType === input.contentType
        && JSON.stringify(existing.syntheticLineage ?? null) === JSON.stringify(input.syntheticLineage ?? null);
      if (!sameLineage) throw new ConflictException("This generated media ID already belongs to another generation operation.");
      if (existing.status === "ready") return publicAsset(existing);
      if (existing.status !== "pending") throw new ConflictException("This generated media record cannot be retried.");
    }
    const date = createdAt.slice(0, 10).replaceAll("-", "/");
    const pending: MediaAsset = existing ?? {
      id: input.id,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      version: 1,
      ...(input.contentItemId ? { contentItemId: input.contentItemId } : {}),
      kind,
      purpose: "creative",
      fileName,
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      sha256,
      objectKey: `${input.workspaceId}/${date}/${input.id}/${fileName}`,
      status: "pending",
      inspectionStatus: "pending",
      malwareScanStatus: "pending",
      rights: input.rights,
      ...(input.altText ? { altText: input.altText } : {}),
      ...(input.syntheticLineage ? { syntheticLineage: input.syntheticLineage } : {}),
      createdBy: actor.id,
      createdAt,
      uploadExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    if (!existing) await this.infrastructure.mediaRepository.save(pending, audit(pending, actor, "media.generated-pending", { origin: input.origin, synthetic: Boolean(input.syntheticLineage), sha256 }));
    let writtenObjectKey: string | undefined;
    let malware: MediaMalwareScanResult | undefined;
    try {
      const stored = await this.infrastructure.mediaObjectStore.writeGenerated(pending, input.bytes);
      writtenObjectKey = stored.objectKey;
      malware = await this.scanFinalized(pending, stored.objectKey);
      if (!malwareAccepted(malware)) throw new Error(malwareFailure(malware));
      if (kind === 'audio') {
        const ready: MediaAsset = { ...pending, ...malwareFields(malware), version: pending.version + 1, objectKey: stored.objectKey, status: 'ready', readyAt: new Date().toISOString(), inspectionStatus: 'not_applicable', detectedContentType: input.contentType };
        await this.infrastructure.mediaRepository.save(ready,audit(ready,actor,'media.generated-ready',{origin:input.origin,synthetic:true,sha256,malwareScanStatus:ready.malwareScanStatus}));
        return publicAsset(ready);
      }
      const inspection = await this.inspectFinalized(pending, stored.objectKey);
      if (inspection.status !== "ready" || inspection.detectedContentType !== input.contentType) throw new Error(inspection.status === "failed" || inspection.status === "unavailable" ? inspection.errorSummary : "The generated image could not be inspected.");
      const ready: MediaAsset = {
        ...pending,
        ...malwareFields(malware),
        version: pending.version + 1,
        objectKey: stored.objectKey,
        status: "ready",
        readyAt: new Date().toISOString(),
        inspectionStatus: "ready",
        detectedContentType: inspection.detectedContentType,
        widthPixels: inspection.widthPixels,
        heightPixels: inspection.heightPixels,
        inspectedAt: inspection.inspectedAt,
        inspector: inspection.inspector,
      };
      await this.infrastructure.mediaRepository.save(ready, audit(ready, actor, "media.generated-ready", { origin: input.origin, synthetic: Boolean(input.syntheticLineage), sha256, malwareScanStatus: ready.malwareScanStatus, widthPixels: ready.widthPixels, heightPixels: ready.heightPixels }));
      return publicAsset(ready);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Generated media verification failed.";
      const rejected: MediaAsset = { ...pending, ...(malware ? malwareFields(malware) : {}), version: pending.version + 1, status: "rejected", inspectionStatus: "failed", inspectionErrorCode: malware && !malwareAccepted(malware) ? "malware_scan_blocked" : "generated_media_failed", inspectionErrorSummary: reason.slice(0, 240), lastError: reason.slice(0, 500) };
      await this.infrastructure.mediaRepository.save(rejected, audit(rejected, actor, malware && !malwareAccepted(malware) ? "media.generated-quarantined" : "media.generated-rejected", { origin: input.origin, synthetic: Boolean(input.syntheticLineage), malwareScanStatus: malware?.status, reason: rejected.lastError }));
      await Promise.all([pending.objectKey, writtenObjectKey].filter((value): value is string => Boolean(value)).map((objectKey) => this.infrastructure.mediaObjectStore.delete(objectKey).catch(() => undefined)));
      throw new BadRequestException(reason);
    }
  }

  private async scanFinalized(asset: Pick<MediaAsset, "sizeBytes">, objectKey: string): Promise<MediaMalwareScanResult> {
    try {
      const stored = await this.infrastructure.mediaObjectStore.read(objectKey);
      return await this.malwareScanner.scan(asset, stored.body);
    } catch {
      return {
        status: "unavailable",
        scannedAt: new Date().toISOString(),
        scanner: "originpost/storage-read-v1",
        errorCode: "stored_media_unavailable",
        errorSummary: "The finalized file could not be read for malware scanning.",
      };
    }
  }

  private async inspectFinalized(asset: MediaAsset, objectKey: string): Promise<MediaInspectionResult> {
    try {
      const stored = await this.infrastructure.mediaObjectStore.read(objectKey);
      return await this.inspector.inspect(asset, stored.body);
    } catch {
      return {
        status: "failed",
        inspectedAt: new Date().toISOString(),
        inspector: "originpost/storage-read-v1",
        errorCode: "stored_media_unavailable",
        errorSummary: "The finalized file could not be read for metadata inspection.",
      };
    }
  }

  async download(workspaceId: string, id: string, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view media.");
    const asset = await this.infrastructure.mediaRepository.get(workspaceId, id);
    if (!asset || asset.status !== "ready") throw new NotFoundException("Ready media asset not found.");
    const download = await this.infrastructure.mediaObjectStore.createDownload(asset.objectKey, asset.fileName);
    const secret = this.config.get<string>("MEDIA_DELIVERY_SECRET") ?? "";
    if ((asset.rights !== "owned" && asset.rights !== "cleared") || Buffer.byteLength(secret, "utf8") < 32) return download;
    const expiresAt = Date.now() + 300_000;
    const token = createMediaDeliveryToken({ workspaceId, mediaId: asset.id, sha256: asset.sha256, expiresAt }, secret);
    return { ...download, previewUrl: `/v1/media-assets/preview?token=${encodeURIComponent(token)}` };
  }

  async trash(workspaceId: string, id: string, expectedVersion: number, actor: Actor) {
    if (!can(actor.role, "media:delete")) throw new ForbiddenException("Only a manager or owner can move media to Trash.");
    const asset = await this.infrastructure.mediaRepository.get(workspaceId, id);
    if (!asset) throw new NotFoundException("Media asset not found.");
    const references = await this.infrastructure.mediaRepository.references(workspaceId, id);
    if (await this.infrastructure.agentPostRepository?.referencesAsset(workspaceId, id)) throw new ForbiddenException("This image belongs to a saved post template and must remain available.");
    const retentionDays = Number(this.config.get<string>("MEDIA_TRASH_RETENTION_DAYS") ?? DEFAULT_MEDIA_TRASH_RETENTION_DAYS);
    const trashed = requestMediaTrash({ asset, references, expectedVersion, actorId: actor.id, now: new Date().toISOString(), retentionDays });
    if (trashed === asset) return publicAsset(asset);
    await this.infrastructure.mediaRepository.save(trashed, audit(trashed, actor, "media.trashed", { previousStatus: asset.status, deleteAfter: trashed.trashExpiresAt }));
    return publicAsset(trashed);
  }

  async restore(workspaceId: string, id: string, expectedVersion: number, actor: Actor) {
    if (!can(actor.role, "media:delete")) throw new ForbiddenException("Only a manager or owner can restore media.");
    const asset = await this.infrastructure.mediaRepository.get(workspaceId, id);
    if (!asset) throw new NotFoundException("Media asset not found.");
    const restored = restoreMediaFromTrash({ asset, expectedVersion, actorId: actor.id, now: new Date().toISOString() });
    await this.infrastructure.mediaRepository.save(restored, audit(restored, actor, "media.restored", { restoredStatus: restored.status }));
    return publicAsset(restored);
  }

  async cleanup(workspaceId: string, actor: Actor) {
    if (!can(actor.role, "media:delete")) throw new ForbiddenException("Only a manager or owner can run media cleanup.");
    return this.cleanupDue(workspaceId);
  }

  async cleanupDue(workspaceId?: string) {
    const now = new Date().toISOString();
    const candidates = await this.infrastructure.mediaRepository.listCleanupCandidates(now, 100, workspaceId);
    const result = { checked: candidates.length, deleted: 0, expired: 0, failed: 0, skipped: 0 };
    const systemActor: Actor = { id: "originpost-media-lifecycle", name: "Media lifecycle", role: "owner" };
    for (const candidate of candidates) {
      const reason = mediaCleanupReason(candidate, now);
      if (!reason) { result.skipped += 1; continue; }
      try {
        await this.infrastructure.mediaObjectStore.delete(candidate.objectKey);
        const completed = completeMediaCleanup(candidate, reason, now);
        await this.infrastructure.mediaRepository.save(completed, audit(completed, systemActor, reason === "upload-expired" ? "media.upload-expired" : "media.deleted", { reason, attempts: completed.cleanupAttempts }, "system"));
        if (completed.status === "expired") result.expired += 1; else result.deleted += 1;
      } catch (error) {
        const failed = failMediaCleanup(candidate, reason, error instanceof Error ? error.message : "Storage cleanup failed.", now);
        try { await this.infrastructure.mediaRepository.save(failed, audit(failed, systemActor, "media.cleanup-failed", { reason, retryAt: failed.cleanupAfter, error: failed.lastError }, "system")); result.failed += 1 }
        catch { result.skipped += 1 }
      }
    }
    return result;
  }

  async deliver(token: string, rangeHeader?: string) {
    const secret = this.config.get<string>("MEDIA_DELIVERY_SECRET") ?? "";
    let grant;
    try { grant = verifyMediaDeliveryToken(token, secret); }
    catch { throw new NotFoundException("Media delivery link is invalid or expired."); }
    const asset = await this.infrastructure.mediaRepository.get(grant.workspaceId, grant.mediaId);
    if (!asset || asset.status !== "ready" || asset.sha256 !== grant.sha256 || (asset.rights !== "owned" && asset.rights !== "cleared")) throw new NotFoundException("Publishable media asset not found.");
    const range = rangeHeader ? parseSingleByteRange(rangeHeader, asset.sizeBytes) : undefined;
    const object = await this.infrastructure.mediaObjectStore.read(asset.objectKey, range);
    return {
      ...object,
      statusCode: range ? 206 : 200,
      contentType: object.contentType ?? asset.contentType,
      contentLength: range ? range.end - range.start + 1 : object.contentLength ?? asset.sizeBytes,
      totalLength: asset.sizeBytes,
      ...(range ? { range } : {}),
      fileName: asset.fileName,
    };
  }
}
