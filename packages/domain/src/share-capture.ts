import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { addDraft, addSource, createContentItem } from "./workflow.js";
import { validateMeasuredMedia } from "./media-policy.js";
import type { Actor, AuditEvent, ContentFormat, ContentItem, MediaAsset, MediaKind, MediaPurpose, Platform, RightsState } from "./types.js";

export type ShareCaptureStatus =
  | "pending"
  | "receiving"
  | "inspecting"
  | "pending_review"
  | "materializing"
  | "converted"
  | "rejected"
  | "failed"
  | "expired";

export interface ShareCaptureMedia {
  kind: Extract<MediaKind, "image" | "video">;
  fileName: string;
  declaredContentType: string;
  sizeBytes: number;
  sha256: string;
  quarantineObjectKey: string;
  inspectionStatus: "pending" | "ready" | "failed" | "unavailable";
  malwareScanStatus?: "pending" | "clean" | "infected" | "unavailable" | "disabled";
  malwareScannedAt?: string;
  malwareScanner?: string;
  malwareThreatName?: string;
  malwareScanErrorCode?: string;
  malwareScanErrorSummary?: string;
  detectedContentType?: string;
  widthPixels?: number;
  heightPixels?: number;
  durationMs?: number;
  inspectedAt?: string;
  inspector?: string;
  errorCode?: string;
  errorSummary?: string;
}

export type ShareCaptureMode = "library" | "content";

export interface ShareCaptureMaterializationIntent {
  workspaceId: string;
  brandId: string;
  purpose: MediaPurpose;
  rights: RightsState;
  altText?: string;
  mode: ShareCaptureMode;
  title: string;
  platform?: Platform;
  format?: ContentFormat;
  caption?: string;
}

export interface ShareCaptureReceipt {
  id: string;
  createdWorkspaceId: string;
  userId: string;
  tokenHash: string;
  version: number;
  status: ShareCaptureStatus;
  title?: string;
  sharedText?: string;
  originalUrl?: string;
  normalizedUrl?: string;
  dedupeSha256: string;
  media?: ShareCaptureMedia;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  materializationSha256?: string | undefined;
  materializationWorkspaceId?: string | undefined;
  materializationBrandId?: string | undefined;
  materializationClaimOwner?: string | undefined;
  materializationClaimExpiresAt?: string | undefined;
  convertedMediaAssetId?: string | undefined;
  convertedContentItemId?: string | undefined;
  convertedDraftId?: string | undefined;
  convertedWorkspaceId?: string | undefined;
  convertedBrandId?: string | undefined;
  convertedAt?: string | undefined;
  failureCode?: string | undefined;
}

export interface ShareCapturePublicMedia extends Omit<ShareCaptureMedia, "quarantineObjectKey"> {}
export interface ShareCapturePublicView extends Omit<ShareCaptureReceipt,
  "tokenHash" | "normalizedUrl" | "media" | "materializationClaimOwner" | "materializationClaimExpiresAt"> {
  media?: ShareCapturePublicMedia;
}

export interface ShareCaptureCleanupCandidate {
  id: string;
  userId: string;
  quarantineObjectKey: string;
}

export interface ShareCaptureRepository {
  create(receipt: ShareCaptureReceipt): Promise<void>;
  getByTokenHash(userId: string, tokenHash: string, now: string): Promise<ShareCaptureReceipt | null>;
  revise(input: { id: string; userId: string; expectedVersion: number; prepared: ReturnType<typeof prepareShareCapture>; at: string }): Promise<ShareCaptureReceipt | null>;
  updateMedia(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    from: "receiving" | "inspecting";
    to: "inspecting" | "pending_review" | "rejected";
    media: ShareCaptureMedia;
    failureCode?: string;
    at: string;
  }): Promise<ShareCaptureReceipt | null>;
  claimMaterialization(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    intentSha256: string;
    workspaceId: string;
    brandId: string;
    claimOwner: string;
    leaseSeconds: number;
  }): Promise<ShareCaptureReceipt | null>;
  markConverted(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    workspaceId: string;
    brandId: string;
    contentItemId?: string;
    draftId?: string;
    mediaAssetId?: string;
    convertedAt: string;
    claimOwner?: string;
  }): Promise<ShareCaptureReceipt | null>;
  markFailed(id: string, userId: string, expectedVersion: number, failureCode: string, at: string): Promise<ShareCaptureReceipt | null>;
  expireDue(now: string, limit?: number): Promise<number>;
  listQuarantineCleanup(limit?: number): Promise<ShareCaptureCleanupCandidate[]>;
  clearQuarantine(id: string, userId: string, quarantineObjectKey: string): Promise<boolean>;
}

const trackingKeys = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "si"]);

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFC").replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n").trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) throw new DomainError(`Shared ${max === 180 ? "title" : "text"} is too long.`, "share_capture_too_long", 400);
  return cleaned;
}

function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError("The shared link is not a valid web address.", "share_capture_invalid_url", 400); }
  if (!( ["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
    throw new DomainError("Only normal HTTP or HTTPS links without embedded credentials can be captured.", "share_capture_invalid_url", 400);
  }
  if (url.href.length > 2048) throw new DomainError("The shared link is too long.", "share_capture_too_long", 400);
  return url;
}

function linkFromText(text?: string): string | undefined {
  const match = text?.match(/https?:\/\/[^\s<>"']+/iu)?.[0];
  return match?.replace(/[),.;!?]+$/u, "");
}

export function normalizeSharedUrl(value: string): { originalUrl: string; normalizedUrl: string } {
  const original = safeUrl(value.trim());
  const normalized = new URL(original.href);
  normalized.hash = "";
  for (const key of [...normalized.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || trackingKeys.has(key.toLowerCase())) normalized.searchParams.delete(key);
  }
  normalized.searchParams.sort();
  return { originalUrl: original.href, normalizedUrl: normalized.href };
}

export function prepareShareCapture(input: {
  title?: unknown;
  text?: unknown;
  url?: unknown;
  media?: { fileName: string; sha256: string };
}) {
  const suppliedTitle = cleanText(input.title, 180);
  const sharedText = cleanText(input.text, 4_000);
  const explicitUrl = cleanText(input.url, 2_048);
  const discoveredUrl = explicitUrl ?? linkFromText(sharedText);
  if (!discoveredUrl && !sharedText && !input.media) throw new DomainError("Share a link, some text, or one media file to continue.", "share_capture_empty", 400);
  const link = discoveredUrl ? normalizeSharedUrl(discoveredUrl) : undefined;
  const fallbackTitle = input.media?.fileName || (link ? new URL(link.originalUrl).hostname.replace(/^www\./u, "") : sharedText!.split("\n")[0]!.slice(0, 180));
  const title = suppliedTitle ?? fallbackTitle;
  const dedupeSha256 = input.media?.sha256 ?? createHash("sha256").update(JSON.stringify(link
    ? { normalizedUrl: link.normalizedUrl }
    : { text: sharedText!.replace(/\s+/gu, " ").toLocaleLowerCase("en-US") }
  )).digest("hex");
  return { title, ...(sharedText ? { sharedText } : {}), ...(link ?? {}), dedupeSha256 };
}

export function shareCaptureContentItemId(workspaceId: string, brandId: string, userId: string, dedupeSha256: string): string {
  return `content_share_${createHash("sha256").update(`${workspaceId}\u0000${brandId}\u0000${userId}\u0000${dedupeSha256}`).digest("hex").slice(0, 32)}`;
}

export function shareCaptureMediaAssetId(receiptId: string): string {
  return `media_share_${createHash("sha256").update(receiptId).digest("hex").slice(0, 32)}`;
}

export function shareCaptureMaterializationSha256(input: ShareCaptureMaterializationIntent): string {
  const normalized = {
    workspaceId: input.workspaceId.trim(), brandId: input.brandId.trim(), purpose: input.purpose, rights: input.rights,
    altText: input.altText?.normalize("NFC").trim() || null, mode: input.mode, title: input.title.normalize("NFC").trim(),
    platform: input.platform ?? null, format: input.format ?? null, caption: input.caption?.normalize("NFC").trim() ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function publicShareCapture(receipt: ShareCaptureReceipt): ShareCapturePublicView {
  const {
    tokenHash: _tokenHash, normalizedUrl: _normalizedUrl, materializationClaimOwner: _claimOwner,
    materializationClaimExpiresAt: _claimExpiresAt, media, ...safe
  } = receipt;
  if (!media) return safe;
  const { quarantineObjectKey: _quarantineObjectKey, ...publicMedia } = media;
  return { ...safe, media: publicMedia };
}

function withoutSharedPayload(receipt: ShareCaptureReceipt): ShareCaptureReceipt {
  const { title: _title, sharedText: _sharedText, originalUrl: _originalUrl, normalizedUrl: _normalizedUrl, ...rest } = receipt;
  return rest;
}

function validateDraftIntent(intent: ShareCaptureMaterializationIntent, media: ShareCaptureMedia): void {
  if (intent.mode !== "content") return;
  if (intent.purpose !== "creative" || (intent.rights !== "owned" && intent.rights !== "cleared")) {
    throw new DomainError("A draft needs creative media with owned or cleared rights.", "share_capture_draft_rights_required", 409);
  }
  if (!intent.platform || !intent.format || !intent.caption?.trim()) {
    throw new DomainError("Choose a platform, compatible format, and caption for the draft.", "share_capture_draft_fields_required", 400);
  }
  const issues = validateMeasuredMedia({
    platform: intent.platform,
    format: intent.format,
    media: [{ id: "capture", type: media.kind, mimeType: media.detectedContentType, inspectionStatus: media.inspectionStatus === "ready" ? "ready" : "failed", malwareScanStatus: media.malwareScanStatus, widthPixels: media.widthPixels, heightPixels: media.heightPixels, durationMs: media.durationMs, rights: intent.rights }],
  });
  if (issues[0]) throw new DomainError(issues[0].message, issues[0].code, 400);
}

export function createShareCaptureDraftContent(input: {
  receipt: ShareCaptureReceipt;
  workspaceId: string;
  brandId: string;
  mediaAsset: MediaAsset;
  intent: ShareCaptureMaterializationIntent;
  actor: Actor;
  now?: string;
}): { item: ContentItem; draftId: string; event: AuditEvent } {
  const { receipt, mediaAsset, intent, actor } = input;
  if (!receipt.media || receipt.media.sha256 !== mediaAsset.sha256 || receipt.media.kind !== mediaAsset.kind) {
    throw new DomainError("The captured file no longer matches the Library asset.", "share_capture_media_lineage_mismatch", 409);
  }
  validateDraftIntent(intent, receipt.media);
  const now = input.now ?? new Date().toISOString();
  const contentItemId = shareCaptureContentItemId(input.workspaceId, input.brandId, actor.id, receipt.dedupeSha256);
  const created = createContentItem({ contentId: contentItemId, workspaceId: input.workspaceId, brandId: input.brandId, title: intent.title, summary: receipt.sharedText?.slice(0, 2000), actor, researchDepth: "quick", riskLevel: "low", now });
  const sourced = addSource(created.item, {
    kind: mediaAsset.kind,
    title: intent.title,
    ...(receipt.originalUrl ? { url: receipt.originalUrl } : {}),
    sha256: mediaAsset.sha256,
    rights: intent.rights,
    confidence: intent.rights === "owned" || intent.rights === "cleared" ? 100 : 25,
    notes: (receipt.sharedText ?? "Shared from a phone into the governed Media Library.").slice(0, 2000),
    capturedAt: now,
  }, actor);
  const drafted = addDraft(sourced.item, { platform: intent.platform!, format: intent.format!, title: intent.title, caption: intent.caption!.trim(), mediaIds: [mediaAsset.id] }, actor, now);
  const draft = drafted.item.drafts.at(-1)!;
  const item: ContentItem = { ...drafted.item, version: 1 };
  return {
    item,
    draftId: draft.id,
    event: {
      id: `audit_${randomUUID()}`,
      workspaceId: input.workspaceId,
      contentItemId: item.id,
      actorId: actor.id,
      actorType: actor.actorType ?? "human",
      action: "share-capture.content-created",
      detail: { captureReceiptId: receipt.id, mediaAssetId: mediaAsset.id, draftId: draft.id, platform: draft.platform, format: draft.format, rights: intent.rights },
      createdAt: now,
    },
  };
}

export class InMemoryShareCaptureRepository implements ShareCaptureRepository {
  private readonly receipts = new Map<string, ShareCaptureReceipt>();
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async create(receipt: ShareCaptureReceipt): Promise<void> {
    if ([...this.receipts.values()].some((entry) => entry.tokenHash === receipt.tokenHash)) throw new DomainError("Capture token already exists.", "share_capture_token_conflict", 409);
    this.receipts.set(receipt.id, structuredClone(receipt));
  }

  async getByTokenHash(userId: string, tokenHash: string, now: string): Promise<ShareCaptureReceipt | null> {
    const found = [...this.receipts.values()].find((entry) => entry.userId === userId && entry.tokenHash === tokenHash);
    if (!found) return null;
    const expirable = ["pending", "receiving", "inspecting", "pending_review", "rejected", "failed"].includes(found.status)
      || found.status === "materializing" && (!found.materializationClaimExpiresAt || found.materializationClaimExpiresAt <= now);
    if (expirable && found.expiresAt <= now) {
      const expired: ShareCaptureReceipt = { ...withoutSharedPayload(found), version: found.version + 1, status: "expired", updatedAt: now, materializationClaimOwner: undefined, materializationClaimExpiresAt: undefined };
      this.receipts.set(found.id, expired);
      return structuredClone(expired);
    }
    return structuredClone(found);
  }

  async revise(input: { id: string; userId: string; expectedVersion: number; prepared: ReturnType<typeof prepareShareCapture>; at: string }): Promise<ShareCaptureReceipt | null> {
    const current = this.receipts.get(input.id);
    if (!current || current.userId !== input.userId || current.version !== input.expectedVersion || !["pending", "pending_review"].includes(current.status) || current.expiresAt <= input.at) return null;
    const revised: ShareCaptureReceipt = { ...current, ...input.prepared, version: current.version + 1, updatedAt: input.at };
    this.receipts.set(current.id, revised); return structuredClone(revised);
  }

  async updateMedia(input: { id: string; userId: string; expectedVersion: number; from: "receiving" | "inspecting"; to: "inspecting" | "pending_review" | "rejected"; media: ShareCaptureMedia; failureCode?: string; at: string }): Promise<ShareCaptureReceipt | null> {
    const current = this.receipts.get(input.id);
    if (!current || current.userId !== input.userId || current.version !== input.expectedVersion || current.status !== input.from || current.expiresAt <= input.at) return null;
    const next: ShareCaptureReceipt = { ...current, version: current.version + 1, status: input.to, media: structuredClone(input.media), updatedAt: input.at, ...(input.failureCode ? { failureCode: input.failureCode.slice(0, 100) } : {}) };
    this.receipts.set(current.id, next); return structuredClone(next);
  }

  async claimMaterialization(input: { id: string; userId: string; expectedVersion: number; intentSha256: string; workspaceId: string; brandId: string; claimOwner: string; leaseSeconds: number }): Promise<ShareCaptureReceipt | null> {
    const current = this.receipts.get(input.id);
    const now = this.clock().toISOString();
    const claimable = current?.status === "pending_review" || current?.status === "pending" || current?.status === "materializing" && Boolean(current.materializationClaimExpiresAt) && current.materializationClaimExpiresAt! <= now;
    if (!current || current.userId !== input.userId || current.version !== input.expectedVersion || !claimable || current.expiresAt <= now || (current.materializationSha256 && current.materializationSha256 !== input.intentSha256)) return null;
    const claimed: ShareCaptureReceipt = { ...current, version: current.version + 1, status: "materializing", materializationSha256: input.intentSha256, materializationWorkspaceId: input.workspaceId, materializationBrandId: input.brandId, materializationClaimOwner: input.claimOwner, materializationClaimExpiresAt: new Date(this.clock().getTime() + Math.max(30, Math.min(input.leaseSeconds, 900)) * 1000).toISOString(), updatedAt: now };
    this.receipts.set(current.id, claimed); return structuredClone(claimed);
  }

  async markConverted(input: { id: string; userId: string; expectedVersion: number; workspaceId: string; brandId: string; contentItemId?: string; draftId?: string; mediaAssetId?: string; convertedAt: string; claimOwner?: string }): Promise<ShareCaptureReceipt | null> {
    const current = this.receipts.get(input.id);
    const repositoryNow = this.clock().toISOString();
    const fileClaimValid = current?.media ? current.status === "materializing" && current.materializationClaimOwner === input.claimOwner && Boolean(current.materializationClaimExpiresAt) && current.materializationClaimExpiresAt! > repositoryNow : current?.status === "pending";
    if (!current || current.userId !== input.userId || current.version !== input.expectedVersion || !fileClaimValid || current.expiresAt <= repositoryNow) return null;
    const converted: ShareCaptureReceipt = { ...withoutSharedPayload(current), version: current.version + 1, status: "converted", convertedMediaAssetId: input.mediaAssetId, convertedContentItemId: input.contentItemId, convertedDraftId: input.draftId, convertedWorkspaceId: input.workspaceId, convertedBrandId: input.brandId, convertedAt: input.convertedAt, updatedAt: input.convertedAt, materializationClaimOwner: undefined, materializationClaimExpiresAt: undefined, failureCode: undefined };
    this.receipts.set(current.id, converted); return structuredClone(converted);
  }

  async markFailed(id: string, userId: string, expectedVersion: number, failureCode: string, at: string): Promise<ShareCaptureReceipt | null> {
    const current = this.receipts.get(id);
    if (!current || current.userId !== userId || current.version !== expectedVersion || !["pending", "receiving", "inspecting", "pending_review", "materializing"].includes(current.status)) return null;
    const failed: ShareCaptureReceipt = { ...current, version: current.version + 1, status: current.media ? "rejected" : "failed", failureCode: failureCode.slice(0, 100), updatedAt: at, materializationClaimOwner: undefined, materializationClaimExpiresAt: undefined };
    this.receipts.set(id, failed); return structuredClone(failed);
  }

  async expireDue(now: string, limit = 100): Promise<number> {
    let count = 0;
    for (const receipt of this.receipts.values()) {
      const expirable = receipt.status !== "converted" && receipt.status !== "expired" && !(receipt.status === "materializing" && receipt.materializationClaimExpiresAt && receipt.materializationClaimExpiresAt > now);
      if (count >= limit || !expirable || receipt.expiresAt > now) continue;
      this.receipts.set(receipt.id, { ...withoutSharedPayload(receipt), version: receipt.version + 1, status: "expired", updatedAt: now, materializationClaimOwner: undefined, materializationClaimExpiresAt: undefined }); count += 1;
    }
    return count;
  }

  async listQuarantineCleanup(limit = 100): Promise<ShareCaptureCleanupCandidate[]> {
    return [...this.receipts.values()].filter((receipt) => Boolean(receipt.media?.quarantineObjectKey) && ["converted", "expired", "rejected", "failed"].includes(receipt.status)).slice(0, limit).map((receipt) => ({ id: receipt.id, userId: receipt.userId, quarantineObjectKey: receipt.media!.quarantineObjectKey }));
  }

  async clearQuarantine(id: string, userId: string, quarantineObjectKey: string): Promise<boolean> {
    const current = this.receipts.get(id);
    if (!current || current.userId !== userId || current.media?.quarantineObjectKey !== quarantineObjectKey || !["converted", "expired", "rejected", "failed"].includes(current.status)) return false;
    const media = { ...current.media, quarantineObjectKey: "" };
    this.receipts.set(id, { ...current, version: current.version + 1, media, updatedAt: this.clock().toISOString() });
    return true;
  }
}
