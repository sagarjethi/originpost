import { describe, expect, it } from "vitest";
import { createShareCaptureDraftContent, InMemoryShareCaptureRepository, normalizeSharedUrl, prepareShareCapture, publicShareCapture, shareCaptureContentItemId, shareCaptureMaterializationSha256, shareCaptureMediaAssetId, type ShareCaptureReceipt } from "../src/share-capture.js";
import type { Actor, MediaAsset } from "../src/types.js";

describe("mobile share capture", () => {
  it("keeps the original link while removing tracking only from the dedupe form", () => {
    expect(normalizeSharedUrl("https://example.com/story?utm_source=ig&b=2&a=1#comments")).toEqual({
      originalUrl: "https://example.com/story?utm_source=ig&b=2&a=1#comments",
      normalizedUrl: "https://example.com/story?a=1&b=2",
    });
  });

  it("extracts a shared URL from text and gives tracking variants the same dedupe hash", () => {
    const first = prepareShareCapture({ text: "Worth reading https://example.com/post?utm_medium=social" });
    const second = prepareShareCapture({ title: "Different share title", url: "https://example.com/post?fbclid=secret" });
    expect(first.originalUrl).toBe("https://example.com/post?utm_medium=social");
    expect(first.dedupeSha256).toBe(second.dedupeSha256);
  });

  it("rejects unsafe schemes and credentials", () => {
    expect(() => prepareShareCapture({ url: "javascript:alert(1)" })).toThrow(/HTTP or HTTPS|valid web address/u);
    expect(() => prepareShareCapture({ url: "https://user:pass@example.com/private" })).toThrow(/embedded credentials/u);
  });

  it("creates deterministic content IDs scoped by workspace, brand, and owner", () => {
    const a = shareCaptureContentItemId("w", "b", "u", "a".repeat(64));
    expect(a).toBe(shareCaptureContentItemId("w", "b", "u", "a".repeat(64)));
    expect(a).not.toBe(shareCaptureContentItemId("w", "b2", "u", "a".repeat(64)));
  });

  it("accepts a file-only share while keeping quarantine and claims out of its public view", () => {
    const prepared = prepareShareCapture({ media: { fileName: "phone-photo.jpg", sha256: "f".repeat(64) } });
    expect(prepared).toMatchObject({ title: "phone-photo.jpg", dedupeSha256: "f".repeat(64) });
    const receipt: ShareCaptureReceipt = {
      id: "capture-file", createdWorkspaceId: "w", userId: "u", tokenHash: "a".repeat(64), version: 2,
      status: "materializing", ...prepared,
      media: { kind: "image", fileName: "phone-photo.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", sizeBytes: 123, sha256: "f".repeat(64), quarantineObjectKey: "w/private/quarantine", inspectionStatus: "ready", widthPixels: 1080, heightPixels: 1080 },
      materializationSha256: "b".repeat(64), materializationWorkspaceId: "w", materializationBrandId: "b", materializationClaimOwner: "worker-secret", materializationClaimExpiresAt: "2026-09-01T00:10:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:15:00.000Z",
    };
    const visible = publicShareCapture(receipt);
    expect(visible.media).not.toHaveProperty("quarantineObjectKey");
    expect(visible).not.toHaveProperty("tokenHash");
    expect(visible).not.toHaveProperty("materializationClaimOwner");
  });

  it("derives one exact Library ID and a canonical rights-and-destination intent hash", () => {
    expect(shareCaptureMediaAssetId("capture-a")).toBe(shareCaptureMediaAssetId("capture-a"));
    const base = { workspaceId: "w", brandId: "b", purpose: "creative" as const, rights: "owned" as const, mode: "content" as const, title: "Phone visual", platform: "instagram" as const, format: "image" as const, caption: "Caption" };
    expect(shareCaptureMaterializationSha256(base)).toBe(shareCaptureMaterializationSha256({ ...base, title: " Phone visual " }));
    expect(shareCaptureMaterializationSha256(base)).not.toBe(shareCaptureMaterializationSha256({ ...base, rights: "cleared" }));
  });

  it("creates only an unapproved draft bound to the exact inspected creative asset", () => {
    const actor: Actor = { id: "u", name: "Owner", role: "owner", actorType: "human" };
    const receipt: ShareCaptureReceipt = {
      id: "capture-draft", createdWorkspaceId: "w", userId: "u", tokenHash: "a".repeat(64), version: 3, status: "materializing", title: "Phone visual", dedupeSha256: "d".repeat(64),
      media: { kind: "image", fileName: "phone.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", sizeBytes: 123, sha256: "e".repeat(64), quarantineObjectKey: "private", inspectionStatus: "ready", widthPixels: 1080, heightPixels: 1080 },
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:15:00.000Z",
    };
    const asset: MediaAsset = { id: shareCaptureMediaAssetId(receipt.id), workspaceId: "w", brandId: "b", version: 2, kind: "image", purpose: "creative", fileName: "phone.jpg", contentType: "image/jpeg", sizeBytes: 123, sha256: "e".repeat(64), objectKey: "w/final", status: "ready", inspectionStatus: "ready", detectedContentType: "image/jpeg", widthPixels: 1080, heightPixels: 1080, rights: "owned", createdBy: "u", createdAt: receipt.createdAt, uploadExpiresAt: receipt.expiresAt, readyAt: receipt.updatedAt };
    const result = createShareCaptureDraftContent({ receipt, workspaceId: "w", brandId: "b", mediaAsset: asset, intent: { workspaceId: "w", brandId: "b", purpose: "creative", rights: "owned", mode: "content", title: "Phone visual", platform: "instagram", format: "image", caption: "A reviewable caption" }, actor, now: "2026-09-01T00:02:00.000Z" });
    expect(result.item).toMatchObject({ status: "drafting", version: 1, approvals: [], targets: [], proofs: [] });
    expect(result.item.drafts).toEqual([expect.objectContaining({ id: result.draftId, mediaIds: [asset.id], platform: "instagram", format: "image" })]);
    expect(() => createShareCaptureDraftContent({ receipt, workspaceId: "w", brandId: "b", mediaAsset: asset, intent: { workspaceId: "w", brandId: "b", purpose: "source", rights: "reference-only", mode: "content", title: "Unsafe", platform: "instagram", format: "image", caption: "No" }, actor })).toThrow(/owned or cleared rights/u);
  });

  it("uses repository time to fence expired materialization claims", async () => {
    let now = new Date("2026-09-01T00:01:00.000Z");
    const repo = new InMemoryShareCaptureRepository(() => now);
    const receipt: ShareCaptureReceipt = { id: "capture-lease", createdWorkspaceId: "w", userId: "u", tokenHash: "c".repeat(64), version: 1, status: "pending_review", title: "File", dedupeSha256: "d".repeat(64), media: { kind: "image", fileName: "a.jpg", declaredContentType: "image/jpeg", sizeBytes: 10, sha256: "e".repeat(64), quarantineObjectKey: "q", inspectionStatus: "ready", detectedContentType: "image/jpeg", widthPixels: 10, heightPixels: 10 }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:20:00.000Z" };
    await repo.create(receipt);
    const claimed = await repo.claimMaterialization({ id: receipt.id, userId: "u", expectedVersion: 1, intentSha256: "f".repeat(64), workspaceId: "w", brandId: "b", claimOwner: "first", leaseSeconds: 30 });
    expect(claimed?.status).toBe("materializing");
    now = new Date("2026-09-01T00:02:00.000Z");
    expect(await repo.markConverted({ id: receipt.id, userId: "u", expectedVersion: claimed!.version, workspaceId: "w", brandId: "b", mediaAssetId: "media", claimOwner: "first", convertedAt: "2026-09-01T00:01:10.000Z" })).toBeNull();
    const reclaimed = await repo.claimMaterialization({ id: receipt.id, userId: "u", expectedVersion: claimed!.version, intentSha256: "f".repeat(64), workspaceId: "w", brandId: "b", claimOwner: "second", leaseSeconds: 60 });
    expect(reclaimed?.materializationClaimOwner).toBe("second");
  });

  it("expires payload data and converts a receipt only once", async () => {
    const repo = new InMemoryShareCaptureRepository(() => new Date("2026-09-01T00:01:00.000Z"));
    const receipt = { id: "capture_1", createdWorkspaceId: "default", userId: "u", tokenHash: "a".repeat(64), version: 1, status: "pending" as const, title: "Story", originalUrl: "https://example.com", normalizedUrl: "https://example.com/", dedupeSha256: "b".repeat(64), createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:15:00.000Z" };
    await repo.create(receipt);
    const converted = await repo.markConverted({ id: receipt.id, userId: "u", expectedVersion: 1, workspaceId: "default", brandId: "brand_default", contentItemId: "content_1", convertedAt: "2026-09-01T00:01:00.000Z" });
    expect(converted).toMatchObject({ status: "converted", convertedContentItemId: "content_1" });
    expect(converted?.originalUrl).toBeUndefined();
    expect(await repo.markConverted({ id: receipt.id, userId: "u", expectedVersion: 1, workspaceId: "default", brandId: "brand_default", contentItemId: "content_2", convertedAt: "2026-09-01T00:02:00.000Z" })).toBeNull();
  });
});
