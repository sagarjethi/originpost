import { ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  addSource, can, createContentItem, createShareCaptureDraftContent, DomainError, normalizeSharedUrl, prepareShareCapture,
  publicShareCapture, shareCaptureContentItemId, shareCaptureMaterializationSha256, shareCaptureMediaAssetId,
  type Actor, type ShareCaptureMaterializationIntent, type ShareCaptureMedia, type ShareCaptureReceipt,
} from "@originpost/domain";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { INFRASTRUCTURE } from "../common/tokens.js";
import { resolveActiveBrand } from "../common/brand-context.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { MediaService } from "../media/media.service.js";
import type { ConvertShareCaptureDto, MaterializeShareCaptureDto, ShareTargetInputDto } from "./share-capture.dto.js";

const COOKIE = "originpost_share_capture";
const TTL_MS = 15 * 60_000;
const MATERIALIZATION_LEASE_SECONDS = 120;

export interface CapturedMultipartFile {
  kind: "image" | "video";
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  body: AsyncIterable<Uint8Array>;
}

export function shareCaptureCookie(token: string, secure: boolean, maxAge = 900): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function shareCaptureTokenFromCookie(value?: string): string | undefined {
  for (const part of (value ?? "").split(";")) { const [key, ...rest] = part.trim().split("="); if (key === COOKIE) return rest.join("=") || undefined; }
  return undefined;
}

@Injectable()
export class ShareCaptureService implements OnModuleInit, OnModuleDestroy {
  private cleanup?: ReturnType<typeof setInterval>;
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly media: MediaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.cleanup = setInterval(() => void this.cleanupDue(), 60_000);
    this.cleanup.unref?.();
  }
  onModuleDestroy() { if (this.cleanup) clearInterval(this.cleanup); }
  secureCookie() { return (this.config.get<string>("NODE_ENV") ?? "development") === "production"; }

  private async cleanupDue() {
    await this.infrastructure.shareCaptureRepository.expireDue(new Date().toISOString(), 250).catch(() => 0);
    const candidates = await this.infrastructure.shareCaptureRepository.listQuarantineCleanup(250).catch(() => []);
    for (const candidate of candidates) {
      try {
        await this.media.deleteCapturedObject(candidate.quarantineObjectKey);
        await this.infrastructure.shareCaptureRepository.clearQuarantine(candidate.id, candidate.userId, candidate.quarantineObjectKey);
      } catch {
        // The durable cleanup candidate remains visible to the next bounded pass.
      }
    }
  }

  async intake(dto: ShareTargetInputDto, actor: Actor, workspaceId: string, file?: CapturedMultipartFile) {
    if (!can(actor.role, "content:create") || !can(actor.role, "content:edit")) throw new DomainError("This role cannot add mobile captures.", "permission_denied", 403);
    const prepared = prepareShareCapture({ ...dto, ...(file ? { media: { fileName: file.fileName, sha256: file.sha256 } } : {}) });
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const id = `share_capture_${randomUUID()}`;
    const objectKey = file ? `${workspaceId}/share-capture-quarantine/${id}/${file.sha256}` : undefined;
    const initialMedia: ShareCaptureMedia | undefined = file && objectKey ? {
      kind: file.kind,
      fileName: file.fileName,
      declaredContentType: file.contentType.toLowerCase(),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      quarantineObjectKey: objectKey,
      inspectionStatus: "pending",
    } : undefined;
    let receipt: ShareCaptureReceipt = {
      id,
      createdWorkspaceId: workspaceId,
      userId: actor.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      version: 1,
      status: file ? "receiving" : "pending",
      ...prepared,
      ...(initialMedia ? { media: initialMedia } : {}),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    };
    await this.infrastructure.shareCaptureRepository.create(receipt);
    if (!file || !initialMedia) return { token, receipt: publicShareCapture(receipt) };
    try {
      const inspected = await this.media.stageShareCapture({ objectKey: initialMedia.quarantineObjectKey, kind: file.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes, sha256: file.sha256, body: file.body });
      const inspecting = await this.infrastructure.shareCaptureRepository.updateMedia({ id, userId: actor.id, expectedVersion: receipt.version, from: "receiving", to: "inspecting", media: inspected, at: new Date().toISOString() });
      if (!inspecting) throw new ConflictException("The mobile receipt changed before inspection finished.");
      receipt = inspecting;
      const ready = inspected.inspectionStatus === "ready";
      const reviewed = await this.infrastructure.shareCaptureRepository.updateMedia({
        id,
        userId: actor.id,
        expectedVersion: receipt.version,
        from: "inspecting",
        to: ready ? "pending_review" : "rejected",
        media: inspected,
        ...(!ready ? { failureCode: inspected.errorCode ?? "share_capture_inspection_failed" } : {}),
        at: new Date().toISOString(),
      });
      if (!reviewed) throw new ConflictException("The mobile receipt changed before inspection could be recorded.");
      receipt = reviewed;
    } catch (error) {
      await this.media.deleteCapturedObject(initialMedia.quarantineObjectKey).catch(() => undefined);
      const failed = await this.infrastructure.shareCaptureRepository.markFailed(id, actor.id, receipt.version, error instanceof Error ? "share_capture_intake_failed" : "share_capture_intake_failed", new Date().toISOString());
      if (failed) receipt = failed;
    }
    return { token, receipt: publicShareCapture(receipt) };
  }

  async current(token: string | undefined, actor: Actor) {
    if (!token) throw new DomainError("No mobile share is waiting. Share a link, text, photo, or video to OriginPost first.", "share_capture_missing", 404);
    const receipt = await this.infrastructure.shareCaptureRepository.getByTokenHash(actor.id, createHash("sha256").update(token).digest("hex"), new Date().toISOString());
    if (!receipt) throw new DomainError("This mobile share is not available for your account.", "share_capture_not_found", 404);
    return publicShareCapture(receipt);
  }

  async preview(token: string | undefined, actor: Actor) {
    const receipt = await this.receipt(token, actor);
    if (!receipt.media) throw new NotFoundException("This capture has no media preview.");
    return this.media.capturedPreview(receipt.media);
  }

  private async receipt(token: string | undefined, actor: Actor) {
    if (!token) throw new DomainError("No mobile share is waiting.", "share_capture_missing", 404);
    const found = await this.infrastructure.shareCaptureRepository.getByTokenHash(actor.id, createHash("sha256").update(token).digest("hex"), new Date().toISOString());
    if (!found) throw new DomainError("This mobile share is not available for your account.", "share_capture_not_found", 404);
    return found;
  }

  async convert(token: string | undefined, dto: ConvertShareCaptureDto, actor: Actor) {
    if (!can(actor.role, "content:create") || !can(actor.role, "content:edit")) throw new DomainError("This role cannot add mobile captures.", "permission_denied", 403);
    const tokenHash = token ? createHash("sha256").update(token).digest("hex") : "";
    const now = new Date().toISOString();
    let receipt = await this.receipt(token, actor);
    if (receipt.media) throw new DomainError("Choose Save to Library or Create Content Item for this media capture.", "share_capture_media_materialization_required", 409);
    if (receipt.status === "expired") throw new DomainError("This mobile share expired. Share it again from your phone.", "share_capture_expired", 410);
    if (receipt.status === "failed" || receipt.status === "rejected") throw new DomainError("This mobile share could not be converted. Share it again.", receipt.failureCode ?? "share_capture_failed", 409);
    if (receipt.status === "converted") return this.convertedReplay(receipt, dto.workspaceId, dto.brandId, actor, true);
    if (receipt.status !== "pending") throw new ConflictException("This mobile share is still being prepared.");

    const prepared = prepareShareCapture({ title: dto.title ?? receipt.title, text: dto.text ?? receipt.sharedText, url: dto.url ?? receipt.originalUrl });
    const changed = prepared.title !== receipt.title || prepared.sharedText !== receipt.sharedText || prepared.originalUrl !== receipt.originalUrl || prepared.dedupeSha256 !== receipt.dedupeSha256;
    if (changed) {
      const revised = await this.infrastructure.shareCaptureRepository.revise({ id: receipt.id, userId: actor.id, expectedVersion: receipt.version, prepared, at: now });
      if (!revised) throw new DomainError("This mobile share changed in another tab. Refresh and try again.", "share_capture_version_conflict", 409);
      receipt = revised;
    }
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, dto.workspaceId, dto.brandId);
    const contentItemId = shareCaptureContentItemId(dto.workspaceId, brandId, actor.id, receipt.dedupeSha256);
    let item = await this.infrastructure.repository.get(dto.workspaceId, contentItemId);
    let replay = Boolean(item);
    if (!item) {
      const created = createContentItem({ contentId: contentItemId, workspaceId: dto.workspaceId, brandId, title: receipt.title!, summary: receipt.sharedText?.slice(0, 2000), actor, researchDepth: "quick", riskLevel: "low", now });
      await this.infrastructure.repository.commit(created.item, { ...created.event, detail: { ...created.event.detail, transport: "mobile-share-target", captureReceiptId: receipt.id, dedupeSha256: receipt.dedupeSha256 } });
      item = created.item;
    } else if (item.brandId !== brandId || item.createdBy !== actor.id) {
      await this.infrastructure.shareCaptureRepository.markFailed(receipt.id, actor.id, receipt.version, "share_capture_content_conflict", now);
      throw new DomainError("A conflicting Content Item already uses this capture identity.", "share_capture_content_conflict", 409);
    }
    const hasCapturedSource = item.sources.some((source) => {
      if (!receipt.originalUrl) return source.notes === receipt.sharedText;
      if (!source.url) return false;
      try { return normalizeSharedUrl(source.url).normalizedUrl === receipt.normalizedUrl; }
      catch { return source.url === receipt.originalUrl; }
    });
    if (!hasCapturedSource) {
      const sourced = addSource(item, { kind: receipt.originalUrl ? "url" : "note", title: receipt.title!, ...(receipt.originalUrl ? { url: receipt.originalUrl } : {}), rights: "reference-only", confidence: 25, notes: (receipt.sharedText ?? "Shared through OriginPost mobile capture.").slice(0, 2000) }, actor);
      await this.infrastructure.repository.commit(sourced.item, { ...sourced.event, detail: { ...sourced.event.detail, transport: "mobile-share-target", captureReceiptId: receipt.id, dedupeSha256: receipt.dedupeSha256, rights: "reference-only" } });
      item = sourced.item;
    }
    const converted = await this.infrastructure.shareCaptureRepository.markConverted({ id: receipt.id, userId: actor.id, expectedVersion: receipt.version, workspaceId: dto.workspaceId, brandId, contentItemId, convertedAt: now });
    if (!converted) {
      const recovered = await this.infrastructure.shareCaptureRepository.getByTokenHash(actor.id, tokenHash, now);
      if (!recovered || recovered.status !== "converted" || recovered.convertedContentItemId !== contentItemId) throw new DomainError("The Content Item was saved, but this capture needs a refresh.", "share_capture_finalize_conflict", 409);
      receipt = recovered; replay = true;
    } else receipt = converted;
    return { receipt: publicShareCapture(receipt), contentItem: item, idempotentReplay: replay };
  }

  async materialize(token: string | undefined, dto: MaterializeShareCaptureDto, actor: Actor) {
    if (!can(actor.role, "content:create") || !can(actor.role, "content:edit")) throw new DomainError("This role cannot add mobile media.", "permission_denied", 403);
    const tokenHash = token ? createHash("sha256").update(token).digest("hex") : "";
    const now = new Date().toISOString();
    let receipt = await this.receipt(token, actor);
    if (!receipt.media) throw new DomainError("This capture has no media file.", "share_capture_media_missing", 409);
    if (receipt.status === "expired") throw new DomainError("This mobile share expired. Share it again from your phone.", "share_capture_expired", 410);
    if (receipt.status === "rejected" || receipt.status === "failed") throw new DomainError("This media file did not pass secure inspection.", receipt.failureCode ?? "share_capture_inspection_failed", 409);
    if (receipt.status === "converted") return this.convertedReplay(receipt, dto.workspaceId, dto.brandId, actor, true);
    if (receipt.status !== "pending_review" && receipt.status !== "materializing") throw new ConflictException("This shared file is still being inspected.");

    const prepared = prepareShareCapture({ title: dto.title ?? receipt.title, text: dto.text ?? receipt.sharedText, url: dto.url ?? receipt.originalUrl, media: { fileName: receipt.media.fileName, sha256: receipt.media.sha256 } });
    if (receipt.status === "pending_review") {
      const changed = prepared.title !== receipt.title || prepared.sharedText !== receipt.sharedText || prepared.originalUrl !== receipt.originalUrl;
      if (changed) {
        const revised = await this.infrastructure.shareCaptureRepository.revise({ id: receipt.id, userId: actor.id, expectedVersion: receipt.version, prepared, at: now });
        if (!revised) throw new DomainError("This mobile share changed in another tab. Refresh and try again.", "share_capture_version_conflict", 409);
        receipt = revised;
      }
    }
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, dto.workspaceId, dto.brandId);
    const intent: ShareCaptureMaterializationIntent = {
      workspaceId: dto.workspaceId,
      brandId,
      purpose: dto.purpose,
      rights: dto.rights,
      ...(dto.altText?.trim() ? { altText: dto.altText.trim() } : {}),
      mode: dto.mode,
      title: prepared.title,
      ...(dto.platform ? { platform: dto.platform } : {}),
      ...(dto.format ? { format: dto.format } : {}),
      ...(dto.caption?.trim() ? { caption: dto.caption.trim() } : {}),
    };
    if (intent.mode === "content" && (!intent.platform || !intent.format || !intent.caption)) throw new DomainError("Choose a platform, format, and caption to create a draft.", "share_capture_draft_fields_required", 400);
    const intentSha256 = shareCaptureMaterializationSha256(intent);
    if (receipt.materializationSha256 && receipt.materializationSha256 !== intentSha256) throw new DomainError("This capture already started with different Library choices. Refresh to continue that exact operation.", "share_capture_materialization_intent_conflict", 409);
    const claimOwner = `share-materialize-${randomUUID()}`;
    const claimed = await this.infrastructure.shareCaptureRepository.claimMaterialization({ id: receipt.id, userId: actor.id, expectedVersion: receipt.version, intentSha256, workspaceId: dto.workspaceId, brandId, claimOwner, leaseSeconds: MATERIALIZATION_LEASE_SECONDS });
    if (!claimed) {
      const current = await this.infrastructure.shareCaptureRepository.getByTokenHash(actor.id, tokenHash, now);
      if (current?.status === "converted") return this.convertedReplay(current, dto.workspaceId, brandId, actor, true);
      if (current?.status === "materializing") throw new DomainError("This capture is already being saved. Wait a moment and refresh.", "share_capture_materialization_busy", 409);
      throw new DomainError("This capture changed while it was being saved. Refresh and try again.", "share_capture_version_conflict", 409);
    }
    receipt = claimed;
    const capturedMedia = receipt.media;
    if (!capturedMedia) throw new DomainError("This capture has no media file.", "share_capture_media_missing", 409);
    const assetId = shareCaptureMediaAssetId(receipt.id);
    const asset = await this.media.materializeShareCapture({ id: assetId, workspaceId: dto.workspaceId, brandId, purpose: intent.purpose, rights: intent.rights, ...(intent.altText ? { altText: intent.altText } : {}), ...(receipt.originalUrl ? { sourceUrl: receipt.originalUrl } : {}), media: capturedMedia, createdAt: receipt.createdAt, actor, captureReceiptId: receipt.id });
    let item;
    let draftId: string | undefined;
    if (intent.mode === "content") {
      const contentItemId = shareCaptureContentItemId(dto.workspaceId, brandId, actor.id, receipt.dedupeSha256);
      item = await this.infrastructure.repository.get(dto.workspaceId, contentItemId);
      if (!item) {
        const created = createShareCaptureDraftContent({ receipt, workspaceId: dto.workspaceId, brandId, mediaAsset: asset, intent, actor, now });
        try { await this.infrastructure.repository.commit(created.item, created.event); item = created.item; draftId = created.draftId }
        catch (error) {
          item = await this.infrastructure.repository.get(dto.workspaceId, contentItemId);
          if (!item) throw error;
        }
      }
      if (item.brandId !== brandId || item.createdBy !== actor.id) throw new DomainError("A conflicting Content Item already uses this capture identity.", "share_capture_content_conflict", 409);
      const matchingDraft = item.drafts.find((draft) => draft.platform === intent.platform && draft.format === intent.format && draft.title === intent.title && draft.caption === intent.caption && draft.mediaIds.length === 1 && draft.mediaIds[0] === asset.id);
      if (!matchingDraft) throw new DomainError("The saved Content Item does not contain the exact captured draft.", "share_capture_draft_lineage_conflict", 409);
      draftId = matchingDraft.id;
    }
    const converted = await this.infrastructure.shareCaptureRepository.markConverted({ id: receipt.id, userId: actor.id, expectedVersion: receipt.version, workspaceId: dto.workspaceId, brandId, mediaAssetId: asset.id, ...(item ? { contentItemId: item.id } : {}), ...(draftId ? { draftId } : {}), convertedAt: new Date().toISOString(), claimOwner });
    if (!converted) {
      const recovered = await this.infrastructure.shareCaptureRepository.getByTokenHash(actor.id, tokenHash, new Date().toISOString());
      if (!recovered || recovered.status !== "converted" || recovered.convertedMediaAssetId !== asset.id) throw new DomainError("The asset was saved, but this capture needs a refresh.", "share_capture_finalize_conflict", 409);
      receipt = recovered;
    } else receipt = converted;
    if (receipt.media?.quarantineObjectKey) {
      const key = receipt.media.quarantineObjectKey;
      await this.media.deleteCapturedObject(key).then(() => this.infrastructure.shareCaptureRepository.clearQuarantine(receipt.id, actor.id, key)).catch(() => undefined);
    }
    const { objectKey: _objectKey, ...publicAsset } = asset;
    return { receipt: publicShareCapture(receipt), mediaAsset: publicAsset, ...(item ? { contentItem: item } : {}), ...(draftId ? { draftId } : {}), idempotentReplay: false };
  }

  private async convertedReplay(receipt: ShareCaptureReceipt, workspaceId: string, brandId: string, actor: Actor, replay: boolean) {
    if (receipt.convertedWorkspaceId !== workspaceId || receipt.convertedBrandId !== brandId) throw new DomainError("This share was already saved to another selected brand.", "share_capture_already_converted", 409);
    const mediaAsset = receipt.convertedMediaAssetId ? await this.infrastructure.mediaRepository.get(workspaceId, receipt.convertedMediaAssetId) : undefined;
    const contentItem = receipt.convertedContentItemId ? await this.infrastructure.repository.get(workspaceId, receipt.convertedContentItemId) : undefined;
    if (receipt.convertedMediaAssetId && !mediaAsset) throw new DomainError("The saved Library asset is unavailable.", "share_capture_media_missing", 409);
    if (receipt.convertedContentItemId && !contentItem) throw new DomainError("The saved Content Item is unavailable.", "share_capture_content_missing", 409);
    if (contentItem && contentItem.createdBy !== actor.id && actor.role !== "owner" && actor.role !== "manager") throw new DomainError("The saved Content Item is unavailable.", "share_capture_content_missing", 404);
    const publicMediaAsset = mediaAsset ? (({ objectKey: _objectKey, ...safe }) => safe)(mediaAsset) : undefined;
    return { receipt: publicShareCapture(receipt), ...(publicMediaAsset ? { mediaAsset: publicMediaAsset } : {}), ...(contentItem ? { contentItem } : {}), ...(receipt.convertedDraftId ? { draftId: receipt.convertedDraftId } : {}), idempotentReplay: replay };
  }
}
