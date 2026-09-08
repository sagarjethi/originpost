import { describe, expect, it } from "vitest";
import { completeMediaCleanup, failMediaCleanup, InMemoryMediaRepository, mediaCleanupReason, requestMediaTrash, restoreMediaFromTrash, type MediaAsset } from "../src/index.js";

const asset: MediaAsset = {
  id: "media-1", workspaceId: "workspace-1", brandId: "brand-1", version: 1, kind: "image", purpose: "evidence",
  fileName: "photo.png", contentType: "image/png", sizeBytes: 10, sha256: "a".repeat(64), objectKey: "workspace-1/media-1/photo.png",
  status: "pending", inspectionStatus: "pending", rights: "reference-only", createdBy: "owner", createdAt: "2026-08-28T10:00:00.000Z", uploadExpiresAt: "2026-08-28T11:00:00.000Z",
};

describe("media lifecycle", () => {
  it("keeps assets workspace scoped and enforces optimistic versions", async () => {
    const repository = new InMemoryMediaRepository();
    await repository.save(asset, { id: "audit-1", workspaceId: "workspace-1", actorId: "owner", actorType: "human", action: "media.upload-requested", detail: {}, createdAt: asset.createdAt });
    await repository.save({ ...asset, version: 2, status: "ready", readyAt: "2026-08-28T10:01:00.000Z" }, { id: "audit-2", workspaceId: "workspace-1", actorId: "owner", actorType: "human", action: "media.upload-verified", detail: {}, createdAt: "2026-08-28T10:01:00.000Z" });

    expect(await repository.get("workspace-1", "media-1")).toMatchObject({ status: "ready", version: 2 });
    expect(await repository.get("workspace-2", "media-1")).toBeNull();
    await expect(repository.save({ ...asset, version: 2, status: "rejected" }, { id: "audit-3", workspaceId: "workspace-1", actorId: "owner", actorType: "human", action: "media.rejected", detail: {}, createdAt: asset.createdAt })).rejects.toMatchObject({ code: "media_version_conflict" });
  });

  it("blocks deletion while a draft or proof still references the file", () => {
    expect(() => requestMediaTrash({ asset: { ...asset, status: "ready" }, references: { contentItemIds: ["content-1"], draftIds: ["draft-1"], proofIds: ["proof-1"] }, expectedVersion: 1, actorId: "manager", now: "2026-08-28T12:00:00.000Z" })).toThrowError(expect.objectContaining({ code: "media_in_use" }));
  });

  it("blocks deletion while Creative Studio still references the output", () => {
    expect(() => requestMediaTrash({ asset: { ...asset, status: "ready" }, references: { contentItemIds: [], draftIds: [], proofIds: [], creativeProjectIds: ["creative-project-1"], creativeRenderIds: ["creative-render-1"] }, expectedVersion: 1, actorId: "manager", now: "2026-08-28T12:00:00.000Z" })).toThrowError(expect.objectContaining({ code: "media_in_use" }));
  });

  it("moves an unreferenced file to recoverable Trash and restores its prior state", () => {
    const ready = { ...asset, status: "ready" as const, readyAt: "2026-08-28T10:05:00.000Z" };
    const trashed = requestMediaTrash({ asset: ready, references: { contentItemIds: [], draftIds: [], proofIds: [] }, expectedVersion: 1, actorId: "manager", now: "2026-08-28T12:00:00.000Z", retentionDays: 7 });
    expect(trashed).toMatchObject({ version: 2, status: "trashed", statusBeforeTrash: "ready", trashedBy: "manager", cleanupReason: "trash-retention-ended" });
    const restored = restoreMediaFromTrash({ asset: trashed, expectedVersion: 2, actorId: "manager", now: "2026-08-29T12:00:00.000Z" });
    expect(restored).toMatchObject({ version: 3, status: "ready" });
    expect(restored.trashExpiresAt).toBeUndefined();
  });

  it("expires abandoned uploads and retries object cleanup with bounded backoff", () => {
    expect(mediaCleanupReason(asset, "2026-08-28T11:00:00.000Z")).toBe("upload-expired");
    const failed = failMediaCleanup(asset, "upload-expired", "temporary storage error", "2026-08-28T11:00:00.000Z");
    expect(failed).toMatchObject({ version: 2, status: "cleanup_failed", cleanupAttempts: 1, lastError: "temporary storage error" });
    expect(mediaCleanupReason(failed, failed.cleanupAfter!)).toBe("upload-expired");
    const completed = completeMediaCleanup(failed, "upload-expired", failed.cleanupAfter!);
    expect(completed).toMatchObject({ version: 3, status: "expired", cleanupAttempts: 2 });
  });
});
