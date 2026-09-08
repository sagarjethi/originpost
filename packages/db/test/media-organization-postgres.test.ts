import { createMediaFolder, type AuditEvent, type MediaAsset } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMediaOrganizationRepository } from "../src/postgres-media-organization-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-media-organization-integration";
const brandId = "brand-media-organization-integration";
const otherBrandId = "brand-media-organization-other";
const at = "2026-09-01T12:00:00.000Z";
const audit = (id: string): AuditEvent => ({ id, workspaceId, actorId: "media-owner", actorType: "human", action: id, detail: {}, createdAt: at });

function asset(id: string, brand = brandId): MediaAsset {
  return { id, workspaceId, brandId: brand, version: 1, kind: "image", purpose: "creative", fileName: `${id}.jpg`, contentType: "image/jpeg", sizeBytes: 100, sha256: id.endsWith("2") ? "b".repeat(64) : "a".repeat(64), objectKey: `${workspaceId}/${id}.jpg`, status: "ready", inspectionStatus: "ready", detectedContentType: "image/jpeg", widthPixels: 1080, heightPixels: 1080, inspectedAt: at, inspector: "test", rights: "owned", altText: "Mumbai campaign hero", createdBy: "media-owner", createdAt: at, uploadExpiresAt: "2026-09-02T12:00:00.000Z", readyAt: at };
}

suite("Postgres Media Organization repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresMediaOrganizationRepository(sql);

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Media organization','media-organization',${at},${at}) on conflict(id) do nothing`;
    for (const [id, slug] of [[brandId, "media-org"], [otherBrandId, "media-org-other"]]) await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${id},${workspaceId},${id},${slug},'English','UTC','active','media-owner',${at},${at}) on conflict(id) do nothing`;
    for (const value of [asset("media-org-1"), asset("media-org-2"), asset("media-org-other", otherBrandId)]) await sql`insert into media_assets(id,workspace_id,brand_id,version,kind,purpose,file_name,content_type,size_bytes,sha256,object_key,status,inspection_status,detected_content_type,width_pixels,height_pixels,inspected_at,inspector,rights_state,alt_text,created_by,created_at,upload_expires_at,ready_at,payload)
      values(${value.id},${value.workspaceId},${value.brandId},1,${value.kind},${value.purpose},${value.fileName},${value.contentType},${value.sizeBytes},${value.sha256},${value.objectKey},${value.status},${value.inspectionStatus},${value.detectedContentType!},${value.widthPixels!},${value.heightPixels!},${value.inspectedAt!},${value.inspector!},${value.rights},${value.altText!},${value.createdBy},${value.createdAt},${value.uploadExpiresAt},${value.readyAt!},${sql.json(value as never)}) on conflict(id) do nothing`;
  });

  afterAll(async () => {
    await sql`delete from media_asset_organization where workspace_id=${workspaceId}`;
    await sql`delete from media_folders where workspace_id=${workspaceId}`;
    await sql`delete from media_assets where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("persists nested folders and atomically organizes multiple scoped assets", async () => {
    const root = createMediaFolder({ id: "media-folder-campaigns", workspaceId, brandId, name: "Campaigns", createdBy: "media-owner", createdAt: at, updatedBy: "media-owner", updatedAt: at });
    const child = createMediaFolder({ id: "media-folder-mumbai", workspaceId, brandId, parentId: root.id, name: "Mumbai Launch", createdBy: "media-owner", createdAt: at, updatedBy: "media-owner", updatedAt: at });
    await repository.createFolder(root, audit("media-folder-root-created"));
    await repository.createFolder(child, audit("media-folder-child-created"));
    const organized = await repository.bulkOrganize({ workspaceId, brandId, assets: [{ assetId: "media-org-1", expectedVersion: 0 }, { assetId: "media-org-2", expectedVersion: 0 }], folderId: child.id, addTags: ["Launch", "Mumbai"], favorite: true, actorId: "media-owner", at }, audit("media-assets-organized"));
    expect(organized).toHaveLength(2);
    await expect(repository.listLibrary({ workspaceId, brandId, folderId: child.id, tags: ["launch"], search: "mumbai", favorite: true })).resolves.toMatchObject({ total: 2, availableTags: ["launch", "mumbai"] });
    await expect(repository.listFolders(workspaceId, brandId)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: child.id, directAssetCount: 2 })]));
    await expect(repository.bulkOrganize({ workspaceId, brandId, assets: [{ assetId: "media-org-1", expectedVersion: 1 }, { assetId: "media-org-2", expectedVersion: 0 }], removeTags: ["launch"], actorId: "media-owner", at }, audit("media-assets-stale"))).rejects.toMatchObject({ code: "media_organization_version_conflict" });
    await expect(repository.listLibrary({ workspaceId, brandId, tags: ["launch"] })).resolves.toMatchObject({ total: 2 });
    await expect(repository.bulkOrganize({ workspaceId, brandId, assets: [{ assetId: "media-org-other", expectedVersion: 0 }], favorite: true, actorId: "media-owner", at }, audit("media-assets-cross-brand"))).rejects.toMatchObject({ code: "media_asset_not_found" });
    await expect(repository.deleteFolder({ workspaceId, brandId, id: child.id, expectedVersion: 1 }, audit("media-folder-delete-blocked"))).rejects.toMatchObject({ code: "media_folder_not_empty" });
  });
});
