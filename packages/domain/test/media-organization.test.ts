import { describe, expect, it } from "vitest";
import {
  InMemoryMediaOrganizationRepository,
  InMemoryMediaRepository,
  applyMediaOrganizationMutation,
  createMediaFolder,
  normalizeMediaTags,
  type MediaAsset,
} from "../src/index.js";

const at = "2026-09-01T12:00:00.000Z";
const asset: MediaAsset = {
  id: "media-1", workspaceId: "workspace-1", brandId: "brand-1", version: 1, kind: "image", purpose: "creative",
  fileName: "Launch Hero.JPG", contentType: "image/jpeg", sizeBytes: 1234, sha256: "a".repeat(64), objectKey: "private/key",
  status: "ready", inspectionStatus: "ready", rights: "owned", altText: "Mumbai launch stage", createdBy: "creator-1",
  createdAt: at, uploadExpiresAt: at, readyAt: at,
};

const event = { id: "audit-1", workspaceId: "workspace-1", actorId: "owner-1", actorType: "human" as const, action: "media.folder-created", detail: {}, createdAt: at };

describe("media organization", () => {
  it("normalizes human tags and applies versioned organization changes", () => {
    expect(normalizeMediaTags([" Campaign ", "campaign", "Mumbai_Event"])).toEqual(["campaign", "mumbai_event"]);
    expect(applyMediaOrganizationMutation(
      { workspaceId: "workspace-1", brandId: "brand-1", assetId: "media-1", tags: ["old"], favorite: false, version: 0 },
      { folderId: "folder-1", addTags: ["Launch"], removeTags: ["old"], favorite: true, actorId: "owner-1", at },
    )).toMatchObject({ folderId: "folder-1", tags: ["launch"], favorite: true, version: 1 });
  });

  it("supports nested folders, filtered search, and atomic bulk organization", async () => {
    const media = new InMemoryMediaRepository();
    await media.save(asset, event);
    const repository = new InMemoryMediaOrganizationRepository(media);
    const root = createMediaFolder({ id: "folder-root", workspaceId: "workspace-1", brandId: "brand-1", name: "Campaigns", createdBy: "owner-1", createdAt: at, updatedBy: "owner-1", updatedAt: at });
    const child = createMediaFolder({ id: "folder-child", workspaceId: "workspace-1", brandId: "brand-1", parentId: root.id, name: "Mumbai Launch", createdBy: "owner-1", createdAt: at, updatedBy: "owner-1", updatedAt: at });
    await repository.createFolder(root, event);
    await repository.createFolder(child, event);
    await repository.bulkOrganize({ workspaceId: "workspace-1", brandId: "brand-1", assets: [{ assetId: asset.id, expectedVersion: 0 }], folderId: child.id, addTags: ["Event", "Mumbai"], favorite: true, actorId: "owner-1", at }, event);

    await expect(repository.listLibrary({ workspaceId: "workspace-1", brandId: "brand-1", folderId: child.id, search: "launch", tags: ["event"], favorite: true })).resolves.toMatchObject({
      total: 1,
      availableTags: ["event", "mumbai"],
      items: [{ asset: { id: "media-1" }, organization: { folderId: "folder-child", favorite: true, version: 1 } }],
    });
    await expect(repository.listFolders("workspace-1", "brand-1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "folder-root", childFolderCount: 1, directAssetCount: 0 }),
      expect.objectContaining({ id: "folder-child", childFolderCount: 0, directAssetCount: 1 }),
    ]));
  });

  it("rejects stale bulk versions without partially changing other assets", async () => {
    const media = new InMemoryMediaRepository();
    await media.save(asset, event);
    await media.save({ ...asset, id: "media-2", version: 1, fileName: "Second.jpg", objectKey: "private/two" }, { ...event, id: "audit-2" });
    const repository = new InMemoryMediaOrganizationRepository(media);
    await repository.bulkOrganize({ workspaceId: "workspace-1", brandId: "brand-1", assets: [{ assetId: "media-2", expectedVersion: 0 }], favorite: true, actorId: "owner-1", at }, event);
    await expect(repository.bulkOrganize({ workspaceId: "workspace-1", brandId: "brand-1", assets: [{ assetId: "media-1", expectedVersion: 0 }, { assetId: "media-2", expectedVersion: 0 }], addTags: ["campaign"], actorId: "owner-1", at }, event)).rejects.toMatchObject({ code: "media_organization_version_conflict" });
    await expect(repository.listLibrary({ workspaceId: "workspace-1", brandId: "brand-1", search: "campaign" })).resolves.toMatchObject({ total: 0 });
  });

  it("prevents cycles and deletion of non-empty folders", async () => {
    const repository = new InMemoryMediaOrganizationRepository(new InMemoryMediaRepository());
    const root = createMediaFolder({ id: "root", workspaceId: "workspace-1", brandId: "brand-1", name: "Root", createdBy: "owner-1", createdAt: at, updatedBy: "owner-1", updatedAt: at });
    const child = createMediaFolder({ id: "child", workspaceId: "workspace-1", brandId: "brand-1", parentId: root.id, name: "Child", createdBy: "owner-1", createdAt: at, updatedBy: "owner-1", updatedAt: at });
    await repository.createFolder(root, event); await repository.createFolder(child, event);
    await expect(repository.updateFolder({ workspaceId: "workspace-1", brandId: "brand-1", id: root.id, expectedVersion: 1, name: "Root", parentId: child.id, actorId: "owner-1", at }, event)).rejects.toMatchObject({ code: "media_folder_cycle" });
    await expect(repository.deleteFolder({ workspaceId: "workspace-1", brandId: "brand-1", id: root.id, expectedVersion: 1 }, event)).rejects.toMatchObject({ code: "media_folder_not_empty" });
  });
});
