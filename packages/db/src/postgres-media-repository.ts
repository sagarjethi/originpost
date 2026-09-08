import { DomainError, type AuditEvent, type ContentItem, type InstagramPublishSettings, type MediaAsset, type MediaInspectionStatus, type MediaMalwareScanStatus, type MediaReferenceSummary, type MediaRepository, type MediaStatus, type MediaStorageSummary } from "@originpost/domain";
import type { Sql } from "postgres";

export type MediaRow = {
  brand_id: string; version: number; status: MediaStatus; upload_expires_at: Date | string;
  inspection_status: MediaInspectionStatus; detected_content_type: string | null; width_pixels: number | null;
  height_pixels: number | null; duration_ms: string | number | null; inspected_at: Date | string | null;
  inspector: string | null; inspection_error_code: string | null; inspection_error_summary: string | null;
  malware_scan_status: MediaMalwareScanStatus; malware_scanned_at: Date | string | null; malware_scanner: string | null;
  malware_threat_name: string | null; malware_scan_error_code: string | null; malware_scan_error_summary: string | null;
  status_before_trash: MediaAsset["statusBeforeTrash"] | null; trashed_at: Date | string | null;
  trash_expires_at: Date | string | null; trashed_by: string | null; cleanup_reason: MediaAsset["cleanupReason"] | null;
  cleanup_after: Date | string | null; cleanup_attempts: number; deleted_at: Date | string | null; payload: MediaAsset;
};

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }

export function hydrateMediaRow(row: MediaRow): MediaAsset {
  return {
    ...row.payload, brandId: row.brand_id, version: row.version, status: row.status, uploadExpiresAt: iso(row.upload_expires_at),
    inspectionStatus: row.inspection_status,
    ...(row.detected_content_type ? { detectedContentType: row.detected_content_type } : {}),
    ...(row.width_pixels !== null ? { widthPixels: row.width_pixels } : {}), ...(row.height_pixels !== null ? { heightPixels: row.height_pixels } : {}),
    ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}), ...(row.inspected_at ? { inspectedAt: iso(row.inspected_at) } : {}),
    ...(row.inspector ? { inspector: row.inspector } : {}), ...(row.inspection_error_code ? { inspectionErrorCode: row.inspection_error_code } : {}),
    ...(row.inspection_error_summary ? { inspectionErrorSummary: row.inspection_error_summary } : {}),
    malwareScanStatus: row.malware_scan_status,
    ...(row.malware_scanned_at ? { malwareScannedAt: iso(row.malware_scanned_at) } : {}),
    ...(row.malware_scanner ? { malwareScanner: row.malware_scanner } : {}),
    ...(row.malware_threat_name ? { malwareThreatName: row.malware_threat_name } : {}),
    ...(row.malware_scan_error_code ? { malwareScanErrorCode: row.malware_scan_error_code } : {}),
    ...(row.malware_scan_error_summary ? { malwareScanErrorSummary: row.malware_scan_error_summary } : {}),
    ...(row.status_before_trash ? { statusBeforeTrash: row.status_before_trash } : {}),
    ...(row.trashed_at ? { trashedAt: iso(row.trashed_at) } : {}), ...(row.trash_expires_at ? { trashExpiresAt: iso(row.trash_expires_at) } : {}),
    ...(row.trashed_by ? { trashedBy: row.trashed_by } : {}), ...(row.cleanup_reason ? { cleanupReason: row.cleanup_reason } : {}),
    ...(row.cleanup_after ? { cleanupAfter: iso(row.cleanup_after) } : {}), cleanupAttempts: row.cleanup_attempts,
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
  };
}

export class PostgresMediaRepository implements MediaRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, limit = 100, brandId?: string): Promise<MediaAsset[]> {
    const rows = brandId
      ? await this.sql<MediaRow[]>`select brand_id, version, status, upload_expires_at, inspection_status, detected_content_type, width_pixels, height_pixels, duration_ms, inspected_at, inspector, inspection_error_code, inspection_error_summary, malware_scan_status, malware_scanned_at, malware_scanner, malware_threat_name, malware_scan_error_code, malware_scan_error_summary, status_before_trash, trashed_at, trash_expires_at, trashed_by, cleanup_reason, cleanup_after, cleanup_attempts, deleted_at, payload from media_assets where workspace_id = ${workspaceId} and brand_id = ${brandId} order by created_at desc limit ${limit}`
      : await this.sql<MediaRow[]>`select brand_id, version, status, upload_expires_at, inspection_status, detected_content_type, width_pixels, height_pixels, duration_ms, inspected_at, inspector, inspection_error_code, inspection_error_summary, malware_scan_status, malware_scanned_at, malware_scanner, malware_threat_name, malware_scan_error_code, malware_scan_error_summary, status_before_trash, trashed_at, trash_expires_at, trashed_by, cleanup_reason, cleanup_after, cleanup_attempts, deleted_at, payload from media_assets where workspace_id = ${workspaceId} order by created_at desc limit ${limit}`;
    return rows.map(hydrateMediaRow);
  }

  async get(workspaceId: string, id: string): Promise<MediaAsset | null> {
    const rows = await this.sql<MediaRow[]>`select brand_id, version, status, upload_expires_at, inspection_status, detected_content_type, width_pixels, height_pixels, duration_ms, inspected_at, inspector, inspection_error_code, inspection_error_summary, malware_scan_status, malware_scanned_at, malware_scanner, malware_threat_name, malware_scan_error_code, malware_scan_error_summary, status_before_trash, trashed_at, trash_expires_at, trashed_by, cleanup_reason, cleanup_after, cleanup_attempts, deleted_at, payload from media_assets where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0] ? hydrateMediaRow(rows[0]) : null;
  }

  async save(asset: MediaAsset, event: AuditEvent): Promise<void> {
    if (asset.workspaceId !== event.workspaceId) throw new Error("Media and audit event must belong to the same workspace.");
    if (asset.contentItemId && event.contentItemId !== asset.contentItemId) throw new Error("Linked media audit must use the same content item.");
    await this.sql.begin(async (sql) => {
      const saved = await sql<{ id: string }[]>`
        insert into media_assets (
          id, workspace_id, brand_id, content_item_id, version, kind, purpose, file_name, content_type, size_bytes,
          sha256, object_key, status, inspection_status, detected_content_type, width_pixels, height_pixels, duration_ms,
          inspected_at, inspector, inspection_error_code, inspection_error_summary, malware_scan_status, malware_scanned_at, malware_scanner,
          malware_threat_name, malware_scan_error_code, malware_scan_error_summary, rights_state, alt_text, source_url, last_error, created_by, created_at,
          upload_expires_at, ready_at, status_before_trash, trashed_at, trash_expires_at, trashed_by,
          cleanup_reason, cleanup_after, cleanup_attempts, deleted_at, payload
        ) values (
          ${asset.id}, ${asset.workspaceId}, ${asset.brandId}, ${asset.contentItemId ?? null}, ${asset.version}, ${asset.kind}, ${asset.purpose},
          ${asset.fileName}, ${asset.contentType}, ${asset.sizeBytes}, ${asset.sha256}, ${asset.objectKey}, ${asset.status},
          ${asset.inspectionStatus}, ${asset.detectedContentType ?? null}, ${asset.widthPixels ?? null}, ${asset.heightPixels ?? null}, ${asset.durationMs ?? null},
          ${asset.inspectedAt ?? null}, ${asset.inspector ?? null}, ${asset.inspectionErrorCode ?? null}, ${asset.inspectionErrorSummary ?? null},
          ${asset.malwareScanStatus ?? "unavailable"}, ${asset.malwareScannedAt ?? null}, ${asset.malwareScanner ?? null}, ${asset.malwareThreatName ?? null},
          ${asset.malwareScanErrorCode ?? null}, ${asset.malwareScanErrorSummary ?? null}, ${asset.rights},
          ${asset.altText ?? null}, ${asset.sourceUrl ?? null}, ${asset.lastError ?? null}, ${asset.createdBy}, ${asset.createdAt},
          ${asset.uploadExpiresAt}, ${asset.readyAt ?? null}, ${asset.statusBeforeTrash ?? null}, ${asset.trashedAt ?? null},
          ${asset.trashExpiresAt ?? null}, ${asset.trashedBy ?? null}, ${asset.cleanupReason ?? null}, ${asset.cleanupAfter ?? null},
          ${asset.cleanupAttempts ?? 0}, ${asset.deletedAt ?? null}, ${sql.json(asset as never)}
        )
        on conflict (id) do update set
          brand_id = excluded.brand_id, version = excluded.version, status = excluded.status, object_key = excluded.object_key,
          inspection_status = excluded.inspection_status, detected_content_type = excluded.detected_content_type,
          width_pixels = excluded.width_pixels, height_pixels = excluded.height_pixels, duration_ms = excluded.duration_ms,
          inspected_at = excluded.inspected_at, inspector = excluded.inspector, inspection_error_code = excluded.inspection_error_code,
          inspection_error_summary = excluded.inspection_error_summary,
          malware_scan_status = excluded.malware_scan_status, malware_scanned_at = excluded.malware_scanned_at,
          malware_scanner = excluded.malware_scanner, malware_threat_name = excluded.malware_threat_name,
          malware_scan_error_code = excluded.malware_scan_error_code, malware_scan_error_summary = excluded.malware_scan_error_summary,
          last_error = excluded.last_error, ready_at = excluded.ready_at, upload_expires_at = excluded.upload_expires_at,
          status_before_trash = excluded.status_before_trash, trashed_at = excluded.trashed_at, trash_expires_at = excluded.trash_expires_at,
          trashed_by = excluded.trashed_by, cleanup_reason = excluded.cleanup_reason, cleanup_after = excluded.cleanup_after,
          cleanup_attempts = excluded.cleanup_attempts, deleted_at = excluded.deleted_at, payload = excluded.payload
        where media_assets.workspace_id = excluded.workspace_id and media_assets.version = excluded.version - 1
        returning id
      `;
      if (!saved[0]) throw new DomainError("This media record changed while you were working. Refresh it and try again.", "media_version_conflict", 409);
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, ${event.contentItemId ?? null}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
    });
  }

  async references(workspaceId: string, id: string): Promise<MediaReferenceSummary> {
    const rows = await this.sql<{ id: string; payload: ContentItem }[]>`
      select id, payload from content_items
      where workspace_id = ${workspaceId}
        and (jsonb_path_exists(payload, '$.drafts[*].mediaIds[*] ? (@ == $mediaId)', jsonb_build_object('mediaId', to_jsonb(${id}::text)))
          or jsonb_path_exists(payload, '$.targets[*].settings.reelCover ? (@.mode == "custom_image" && @.mediaId == $mediaId)', jsonb_build_object('mediaId', to_jsonb(${id}::text)))
          or jsonb_path_exists(payload, '$.proofs[*].instagramReelCoverProof ? (@.mode == "custom_image" && @.mediaId == $mediaId)', jsonb_build_object('mediaId', to_jsonb(${id}::text))))
    `;
    const draftIds = new Set<string>(); const proofIds = new Set<string>();
    for (const row of rows) {
      const matchingDraftIds = row.payload.drafts.filter((draft) => draft.mediaIds.includes(id)).map((draft) => draft.id);
      for(const target of row.payload.targets){const cover=target.platform==="instagram"?(target.settings as InstagramPublishSettings|undefined)?.reelCover:undefined;if(cover?.mode==="custom_image"&&cover.mediaId===id)matchingDraftIds.push(target.draftId);}
      for (const draftId of matchingDraftIds) draftIds.add(draftId);
      for (const proof of row.payload.proofs) if (matchingDraftIds.includes(proof.draftId)||proof.instagramReelCoverProof?.mode==="custom_image"&&proof.instagramReelCoverProof.mediaId===id) proofIds.add(proof.id);
    }
    const creativeRows = await this.sql<{ project_id: string; render_id: string | null }[]>`
      select project.id as project_id, render.id as render_id
      from creative_projects project
      left join creative_renders render on render.workspace_id=project.workspace_id and render.project_id=project.id and render.output_media_id=${id}
      where project.workspace_id=${workspaceId} and (project.output_media_id=${id} or render.id is not null)
    `;
    return { contentItemIds: rows.map((row) => row.id), draftIds: [...draftIds], proofIds: [...proofIds], creativeProjectIds: [...new Set(creativeRows.map((row) => row.project_id))], creativeRenderIds: [...new Set(creativeRows.flatMap((row) => row.render_id ? [row.render_id] : []))] };
  }

  async summary(workspaceId: string, brandId?: string): Promise<MediaStorageSummary> {
    const rows = brandId
      ? await this.sql<{ status: MediaStatus; count: number; bytes: string }[]>`select status, count(*)::int as count, coalesce(sum(size_bytes), 0)::bigint::text as bytes from media_assets where workspace_id = ${workspaceId} and brand_id = ${brandId} group by status`
      : await this.sql<{ status: MediaStatus; count: number; bytes: string }[]>`select status, count(*)::int as count, coalesce(sum(size_bytes), 0)::bigint::text as bytes from media_assets where workspace_id = ${workspaceId} group by status`;
    const counts: Partial<Record<MediaStatus, number>> = {};
    let totalAssets = 0; let storedBytes = 0; let reclaimableBytes = 0; let pendingBytes = 0;
    for (const row of rows) {
      const count = Number(row.count); const bytes = Number(row.bytes); counts[row.status] = count; totalAssets += count;
      if (!["rejected", "expired", "deleted"].includes(row.status)) storedBytes += bytes;
      if (row.status === "trashed" || row.status === "cleanup_failed") reclaimableBytes += bytes;
      if (row.status === "pending") pendingBytes += bytes;
    }
    return { totalAssets, storedBytes, reclaimableBytes, pendingBytes, counts };
  }

  async listCleanupCandidates(now: string, limit = 100, workspaceId?: string): Promise<MediaAsset[]> {
    const rows = workspaceId ? await this.sql<MediaRow[]>`
      select brand_id, version, status, upload_expires_at, inspection_status, detected_content_type, width_pixels, height_pixels, duration_ms, inspected_at, inspector, inspection_error_code, inspection_error_summary, malware_scan_status, malware_scanned_at, malware_scanner, malware_threat_name, malware_scan_error_code, malware_scan_error_summary, status_before_trash, trashed_at, trash_expires_at, trashed_by, cleanup_reason, cleanup_after, cleanup_attempts, deleted_at, payload
      from media_assets
      where workspace_id = ${workspaceId}
        and ((status = 'pending' and upload_expires_at <= ${now})
          or (status = 'trashed' and trash_expires_at <= ${now})
          or (status = 'cleanup_failed' and cleanup_after <= ${now}))
      order by coalesce(cleanup_after, trash_expires_at, upload_expires_at), id
      limit ${Math.max(1, Math.min(limit, 500))}
    ` : await this.sql<MediaRow[]>`
      select brand_id, version, status, upload_expires_at, inspection_status, detected_content_type, width_pixels, height_pixels, duration_ms, inspected_at, inspector, inspection_error_code, inspection_error_summary, malware_scan_status, malware_scanned_at, malware_scanner, malware_threat_name, malware_scan_error_code, malware_scan_error_summary, status_before_trash, trashed_at, trash_expires_at, trashed_by, cleanup_reason, cleanup_after, cleanup_attempts, deleted_at, payload
      from media_assets
      where (status = 'pending' and upload_expires_at <= ${now})
         or (status = 'trashed' and trash_expires_at <= ${now})
         or (status = 'cleanup_failed' and cleanup_after <= ${now})
      order by coalesce(cleanup_after, trash_expires_at, upload_expires_at), id
      limit ${Math.max(1, Math.min(limit, 500))}
    `;
    return rows.map(hydrateMediaRow);
  }
}
