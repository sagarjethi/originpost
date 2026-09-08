import { prepareShareCapture, shareCaptureMaterializationSha256, type ShareCaptureReceipt } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresShareCaptureRepository } from "../src/postgres-share-capture-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-share-integration";
const brandId = "brand-share-integration";
const ownerId = "owner-share-integration";
const at = "2026-09-01T06:00:00.000Z";

suite("Postgres mobile share capture repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresShareCaptureRepository(sql);

  beforeAll(async () => {
    await sql`insert into workspaces (id,name,slug,created_at) values (${workspaceId},'Share integration','share-integration',${at}) on conflict (id) do nothing`;
    await sql`insert into auth_users (id,email,display_name,password_hash,status,created_at,updated_at) values (${ownerId},'share-integration@example.invalid','Share owner','disabled','active',${at},${at}) on conflict (id) do nothing`;
    await sql`insert into workspace_members (workspace_id,user_id,display_name,role,created_at,updated_at) values (${workspaceId},${ownerId},'Share owner','owner',${at},${at}) on conflict (workspace_id,user_id) do nothing`;
    await sql`insert into brands (id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values (${brandId},${workspaceId},'Share brand','share','English','UTC','active',${ownerId},${at},${at}) on conflict (id) do nothing`;
  });

  afterAll(async () => { await sql`delete from workspaces where id=${workspaceId}`; await sql`delete from auth_users where id=${ownerId}`; await sql.end(); });

  it("round-trips, revises, converts with exact lineage, and redacts converted payload", async () => {
    const receipt: ShareCaptureReceipt = { id: "share-postgres", createdWorkspaceId: workspaceId, userId: ownerId, tokenHash: "a".repeat(64), version: 1, status: "pending", ...prepareShareCapture({ title: "Original", url: "https://example.com/post?utm_source=mobile" }), createdAt: at, updatedAt: at, expiresAt: "2099-09-01T06:15:00.000Z" };
    await repository.create(receipt);
    expect(await repository.getByTokenHash(ownerId, receipt.tokenHash, "2026-09-01T06:01:00.000Z")).toMatchObject({ id: receipt.id, status: "pending", originalUrl: "https://example.com/post?utm_source=mobile" });
    const revised = await repository.revise({ id: receipt.id, userId: ownerId, expectedVersion: 1, prepared: prepareShareCapture({ title: "Revised", url: "https://example.com/post" }), at: "2026-09-01T06:02:00.000Z" });
    expect(revised).toMatchObject({ version: 2, title: "Revised" });
    await sql`insert into content_items (id,workspace_id,brand_id,version,title,status,risk_level,payload,created_at,updated_at) values ('content-share-postgres',${workspaceId},${brandId},1,'Revised','inbox','low',${sql.json({} as never)},${at},${at})`;
    const converted = await repository.markConverted({ id: receipt.id, userId: ownerId, expectedVersion: 2, workspaceId, brandId, contentItemId: "content-share-postgres", convertedAt: "2026-09-01T06:03:00.000Z" });
    expect(converted).toMatchObject({ status: "converted", version: 3, convertedContentItemId: "content-share-postgres" });
    expect(converted).not.toHaveProperty("title"); expect(converted).not.toHaveProperty("originalUrl");
    expect(await repository.markConverted({ id: receipt.id, userId: ownerId, expectedVersion: 2, workspaceId, brandId, contentItemId: "content-share-postgres", convertedAt: "2026-09-01T06:04:00.000Z" })).toBeNull();
  });

  it("expires due payloads", async () => {
    const receipt: ShareCaptureReceipt = { id: "share-postgres-expired", createdWorkspaceId: workspaceId, userId: ownerId, tokenHash: "b".repeat(64), version: 1, status: "pending", ...prepareShareCapture({ text: "Short note" }), createdAt: at, updatedAt: at, expiresAt: "2026-09-01T06:05:00.000Z" };
    await repository.create(receipt);
    expect(await repository.expireDue("2026-09-01T06:06:00.000Z")).toBeGreaterThanOrEqual(1);
    expect(await repository.getByTokenHash(ownerId, receipt.tokenHash, "2026-09-01T06:06:00.000Z")).toMatchObject({ status: "expired" });
  });

  it("elects one materializer and rejects a stale owner using the database clock", async () => {
    const receipt: ShareCaptureReceipt = {
      id: "share-postgres-media", createdWorkspaceId: workspaceId, userId: ownerId, tokenHash: "c".repeat(64), version: 1, status: "pending_review", title: "Phone image", dedupeSha256: "d".repeat(64),
      media: { kind: "image", fileName: "phone.png", declaredContentType: "image/png", detectedContentType: "image/png", sizeBytes: 123, sha256: "e".repeat(64), quarantineObjectKey: `${workspaceId}/private`, inspectionStatus: "ready", widthPixels: 16, heightPixels: 16 },
      createdAt: at, updatedAt: at, expiresAt: "2099-09-01T06:15:00.000Z",
    };
    await repository.create(receipt);
    const intent = { workspaceId, brandId, purpose: "creative" as const, rights: "owned" as const, mode: "library" as const, title: "Phone image" };
    const intentSha256 = shareCaptureMaterializationSha256(intent);
    const [first, second] = await Promise.all([
      repository.claimMaterialization({ id: receipt.id, userId: ownerId, expectedVersion: 1, intentSha256, workspaceId, brandId, claimOwner: "worker-a", leaseSeconds: 60 }),
      repository.claimMaterialization({ id: receipt.id, userId: ownerId, expectedVersion: 1, intentSha256, workspaceId, brandId, claimOwner: "worker-b", leaseSeconds: 60 }),
    ]);
    const winner = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(winner?.status).toBe("materializing");

    await sql`update mobile_share_capture_receipts set materialization_claim_expires_at=clock_timestamp()-interval '1 second' where id=${receipt.id}`;
    await sql`insert into media_assets (id,workspace_id,brand_id,version,kind,purpose,file_name,content_type,size_bytes,sha256,object_key,status,inspection_status,detected_content_type,width_pixels,height_pixels,inspected_at,inspector,rights_state,created_by,created_at,ready_at,upload_expires_at,payload) values ('media-share-postgres',${workspaceId},${brandId},2,'image','creative','phone.png','image/png',123,${"e".repeat(64)},${`${workspaceId}/final`},'ready','ready','image/png',16,16,${at},'test', 'owned',${ownerId},${at},${at},'2099-09-01T07:00:00.000Z',${sql.json({} as never)})`;
    expect(await repository.markConverted({ id: receipt.id, userId: ownerId, expectedVersion: winner!.version, workspaceId, brandId, mediaAssetId: "media-share-postgres", claimOwner: winner!.materializationClaimOwner!, convertedAt: "2026-09-01T06:01:00.000Z" })).toBeNull();
    const reclaimed = await repository.claimMaterialization({ id: receipt.id, userId: ownerId, expectedVersion: winner!.version, intentSha256, workspaceId, brandId, claimOwner: "worker-c", leaseSeconds: 60 });
    expect(reclaimed?.materializationClaimOwner).toBe("worker-c");
    const converted = await repository.markConverted({ id: receipt.id, userId: ownerId, expectedVersion: reclaimed!.version, workspaceId, brandId, mediaAssetId: "media-share-postgres", claimOwner: "worker-c", convertedAt: "2026-09-01T06:02:00.000Z" });
    expect(converted).toMatchObject({ status: "converted", convertedMediaAssetId: "media-share-postgres" });
  });
});
