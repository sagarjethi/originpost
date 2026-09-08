import { DomainError } from "./errors.js";
import type { MediaAsset, MediaCleanupReason, MediaReferenceSummary } from "./types.js";

export const DEFAULT_MEDIA_TRASH_RETENTION_DAYS = 7;
export const DEFAULT_MEDIA_UPLOAD_LEASE_MINUTES = 60;

function assertVersion(asset: MediaAsset, expectedVersion: number): void {
  if (asset.version !== expectedVersion) throw new DomainError("This media record changed while you were working. Refresh it and try again.", "media_version_conflict", 409);
}

function hasReferences(references: MediaReferenceSummary): boolean {
  return references.contentItemIds.length > 0 || references.draftIds.length > 0 || references.proofIds.length > 0 || Boolean(references.creativeProjectIds?.length) || Boolean(references.creativeRenderIds?.length);
}

export function requestMediaTrash(input: {
  asset: MediaAsset;
  references: MediaReferenceSummary;
  expectedVersion: number;
  actorId: string;
  now: string;
  retentionDays?: number;
}): MediaAsset {
  assertVersion(input.asset, input.expectedVersion);
  if (hasReferences(input.references)) throw new DomainError("This file is used by content, a draft, published proof, or Creative Studio render. Remove those links before moving it to Trash.", "media_in_use", 409);
  if (input.asset.status === "deleted") throw new DomainError("This media record has already been deleted.", "media_deleted", 409);
  if (input.asset.status === "trashed") return input.asset;
  if (input.asset.status === "cleanup_failed") throw new DomainError("Cleanup already started for this file. Retry cleanup instead of changing its state.", "media_cleanup_pending", 409);
  const retentionDays = Math.max(1, Math.min(input.retentionDays ?? DEFAULT_MEDIA_TRASH_RETENTION_DAYS, 90));
  return {
    ...input.asset,
    version: input.asset.version + 1,
    statusBeforeTrash: input.asset.status,
    status: "trashed",
    trashedAt: input.now,
    trashExpiresAt: new Date(new Date(input.now).getTime() + retentionDays * 86_400_000).toISOString(),
    trashedBy: input.actorId,
    cleanupReason: "trash-retention-ended",
    cleanupAfter: undefined,
    lastError: undefined,
  };
}

export function restoreMediaFromTrash(input: { asset: MediaAsset; expectedVersion: number; actorId: string; now: string }): MediaAsset {
  assertVersion(input.asset, input.expectedVersion);
  if (input.asset.status !== "trashed" || !input.asset.statusBeforeTrash) throw new DomainError("Only a file in Trash can be restored.", "media_not_trashed", 409);
  if (input.asset.trashExpiresAt && new Date(input.asset.trashExpiresAt) <= new Date(input.now)) throw new DomainError("The restore window has ended and cleanup is due.", "media_restore_window_ended", 409);
  return {
    ...input.asset,
    version: input.asset.version + 1,
    status: input.asset.statusBeforeTrash,
    statusBeforeTrash: undefined,
    trashedAt: undefined,
    trashExpiresAt: undefined,
    trashedBy: undefined,
    cleanupReason: undefined,
    cleanupAfter: undefined,
    lastError: undefined,
  };
}

export function mediaCleanupReason(asset: MediaAsset, now: string): MediaCleanupReason | null {
  const at = new Date(now);
  if (asset.status === "pending" && new Date(asset.uploadExpiresAt) <= at) return "upload-expired";
  if (asset.status === "trashed" && asset.trashExpiresAt && new Date(asset.trashExpiresAt) <= at) return "trash-retention-ended";
  if (asset.status === "cleanup_failed" && asset.cleanupReason && asset.cleanupAfter && new Date(asset.cleanupAfter) <= at) return asset.cleanupReason;
  return null;
}

export function completeMediaCleanup(asset: MediaAsset, reason: MediaCleanupReason, now: string): MediaAsset {
  return {
    ...asset,
    version: asset.version + 1,
    status: reason === "upload-expired" ? "expired" : "deleted",
    cleanupReason: reason,
    cleanupAfter: undefined,
    cleanupAttempts: (asset.cleanupAttempts ?? 0) + 1,
    deletedAt: reason === "trash-retention-ended" ? now : asset.deletedAt,
    lastError: undefined,
  };
}

export function failMediaCleanup(asset: MediaAsset, reason: MediaCleanupReason, error: string, now: string): MediaAsset {
  const attempts = (asset.cleanupAttempts ?? 0) + 1;
  const backoffMinutes = Math.min(24 * 60, 5 * 2 ** Math.min(attempts - 1, 8));
  return {
    ...asset,
    version: asset.version + 1,
    status: "cleanup_failed",
    cleanupReason: reason,
    cleanupAttempts: attempts,
    cleanupAfter: new Date(new Date(now).getTime() + backoffMinutes * 60_000).toISOString(),
    lastError: error.slice(0, 500),
  };
}
