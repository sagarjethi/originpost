import {
  DomainError,
  MAX_MEDIA_FOLDER_DEPTH,
  applyMediaOrganizationMutation,
  normalizeMediaFolderName,
  normalizeMediaTag,
  normalizeMediaTags,
  type AuditEvent,
  type MediaAssetOrganization,
  type MediaBulkOrganizationInput,
  type MediaFolder,
  type MediaFolderView,
  type MediaLibraryPage,
  type MediaLibraryQuery,
  type MediaOrganizationRepository,
} from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";
import { hydrateMediaRow, type MediaRow } from "./postgres-media-repository.js";

type FolderRow = {
  id: string; workspace_id: string; brand_id: string; parent_id: string | null; name: string; version: number;
  created_by: string; created_at: Date | string; updated_by: string; updated_at: Date | string;
  direct_asset_count?: string | number; child_folder_count?: string | number;
};
type OrganizationRow = { asset_id: string; workspace_id: string; brand_id: string; folder_id: string | null; tags: string[]; favorite: boolean; version: number; updated_by: string; updated_at: Date | string };
type LibraryRow = MediaRow & { folder_id: string | null; tags: string[] | null; favorite: boolean | null; organization_version: number | null; organized_by: string | null; organized_at: Date | string | null; total_count: string | number };

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function folder(row: FolderRow): MediaFolder {
  return { id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, ...(row.parent_id ? { parentId: row.parent_id } : {}), name: row.name, version: row.version, createdBy: row.created_by, createdAt: iso(row.created_at), updatedBy: row.updated_by, updatedAt: iso(row.updated_at) };
}
function organization(row: OrganizationRow): MediaAssetOrganization {
  return { workspaceId: row.workspace_id, brandId: row.brand_id, assetId: row.asset_id, ...(row.folder_id ? { folderId: row.folder_id } : {}), tags: normalizeMediaTags(row.tags), favorite: row.favorite, version: row.version, updatedBy: row.updated_by, updatedAt: iso(row.updated_at) };
}

export class PostgresMediaOrganizationRepository implements MediaOrganizationRepository {
  constructor(private readonly sql: Sql) {}

  private async audit(sql: Sql | TransactionSql, event: AuditEvent): Promise<void> {
    await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at)
      values(${event.id},${event.workspaceId},${event.contentItemId ?? null},${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt})`;
  }

  async listLibrary(query: MediaLibraryQuery): Promise<MediaLibraryPage> {
    const statuses = query.view === "trash" ? ["trashed", "cleanup_failed"] : query.view === "history" ? ["rejected", "expired", "deleted"] : ["ready", "pending"];
    const tags = normalizeMediaTags(query.tags ?? []);
    const search = query.search?.normalize("NFKC").trim().toLocaleLowerCase("en-US") || null;
    const limit = Math.max(1, Math.min(200, query.limit ?? 100));
    const rows = await this.sql<LibraryRow[]>`
      select m.brand_id,m.version,m.status,m.upload_expires_at,m.inspection_status,m.detected_content_type,m.width_pixels,m.height_pixels,m.duration_ms,m.inspected_at,m.inspector,m.inspection_error_code,m.inspection_error_summary,m.status_before_trash,m.trashed_at,m.trash_expires_at,m.trashed_by,m.cleanup_reason,m.cleanup_after,m.cleanup_attempts,m.deleted_at,m.payload,
        o.folder_id,o.tags,o.favorite,o.version as organization_version,o.updated_by as organized_by,o.updated_at as organized_at,count(*) over() as total_count
      from media_assets m left join media_asset_organization o on o.asset_id=m.id and o.workspace_id=m.workspace_id and o.brand_id=m.brand_id
      where m.workspace_id=${query.workspaceId} and m.brand_id=${query.brandId}
        and m.status=any(${this.sql.array(statuses)}::text[])
        and (${query.kind ?? null}::text is null or m.kind=${query.kind ?? null})
        and (${query.folderId ?? null}::text is null or o.folder_id=${query.folderId ?? null})
        and (${Boolean(query.unfiled)}=false or o.folder_id is null)
        and (${Boolean(query.favorite)}=false or coalesce(o.favorite,false)=true)
        and (${tags.length}=0 or coalesce(o.tags,'{}'::text[]) @> ${this.sql.array(tags)}::text[])
        and (${search}::text is null or lower(concat_ws(' ',m.file_name,m.alt_text,array_to_string(coalesce(o.tags,'{}'::text[]),' '))) like ${search ? `%${search}%` : null})
      order by coalesce(o.favorite,false) desc,m.created_at desc,m.id desc limit ${limit}
    `;
    const tagRows = await this.sql<{ tag: string }[]>`
      select distinct unnest(o.tags) as tag from media_asset_organization o
      join media_assets m on m.id=o.asset_id and m.workspace_id=o.workspace_id and m.brand_id=o.brand_id
      where o.workspace_id=${query.workspaceId} and o.brand_id=${query.brandId} and m.status not in ('deleted','expired') order by tag
    `;
    return {
      items: rows.map((row) => ({
        asset: hydrateMediaRow(row),
        organization: {
          workspaceId: query.workspaceId, brandId: query.brandId, assetId: row.payload.id,
          ...(row.folder_id ? { folderId: row.folder_id } : {}), tags: normalizeMediaTags(row.tags ?? []), favorite: row.favorite ?? false,
          version: row.organization_version ?? 0, ...(row.organized_by ? { updatedBy: row.organized_by } : {}), ...(row.organized_at ? { updatedAt: iso(row.organized_at) } : {}),
        },
      })),
      total: rows[0] ? Number(rows[0].total_count) : 0,
      availableTags: tagRows.map((row) => normalizeMediaTag(row.tag)),
    };
  }

  async listFolders(workspaceId: string, brandId: string): Promise<MediaFolderView[]> {
    const rows = await this.sql<FolderRow[]>`
      select f.*,
        (select count(*) from media_asset_organization o where o.workspace_id=f.workspace_id and o.brand_id=f.brand_id and o.folder_id=f.id) as direct_asset_count,
        (select count(*) from media_folders c where c.workspace_id=f.workspace_id and c.brand_id=f.brand_id and c.parent_id=f.id) as child_folder_count
      from media_folders f where f.workspace_id=${workspaceId} and f.brand_id=${brandId} order by f.name,f.id
    `;
    return rows.map((row) => ({ ...folder(row), directAssetCount: Number(row.direct_asset_count ?? 0), childFolderCount: Number(row.child_folder_count ?? 0) }));
  }

  async createFolder(value: MediaFolder, event: AuditEvent): Promise<MediaFolder> {
    const name = normalizeMediaFolderName(value.name);
    try {
      return await this.sql.begin(async (sql) => {
        if (value.parentId) {
          const ancestors = await sql<{ id: string; depth: number }[]>`
            with recursive ancestors as (
              select id,parent_id,1 as depth from media_folders where id=${value.parentId} and workspace_id=${value.workspaceId} and brand_id=${value.brandId}
              union all select f.id,f.parent_id,a.depth+1 from media_folders f join ancestors a on f.id=a.parent_id where f.workspace_id=${value.workspaceId} and f.brand_id=${value.brandId}
            ) select id,depth from ancestors order by depth desc`;
          if (!ancestors.length) throw new DomainError("The parent folder is unavailable in this brand.", "media_folder_parent_not_found", 404);
          if (Math.max(...ancestors.map((entry) => entry.depth)) >= MAX_MEDIA_FOLDER_DEPTH) throw new DomainError(`Folders can be nested at most ${MAX_MEDIA_FOLDER_DEPTH} levels deep.`, "media_folder_depth_limit", 409);
        }
        const rows = await sql<FolderRow[]>`insert into media_folders(id,workspace_id,brand_id,parent_id,name,normalized_name,version,created_by,created_at,updated_by,updated_at)
          values(${value.id},${value.workspaceId},${value.brandId},${value.parentId ?? null},${name},${name.toLocaleLowerCase("en-US")},1,${value.createdBy},${value.createdAt},${value.updatedBy},${value.updatedAt}) returning *`;
        await this.audit(sql, event);
        return folder(rows[0]!);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError("A folder with this name already exists here.", "media_folder_name_conflict", 409);
      throw error;
    }
  }

  async updateFolder(input: { workspaceId: string; brandId: string; id: string; expectedVersion: number; name: string; parentId?: string | null; actorId: string; at: string }, event: AuditEvent): Promise<MediaFolder> {
    const name = normalizeMediaFolderName(input.name);
    try {
      return await this.sql.begin(async (sql) => {
        const currentRows = await sql<FolderRow[]>`select * from media_folders where id=${input.id} and workspace_id=${input.workspaceId} and brand_id=${input.brandId} for update`;
        const current = currentRows[0];
        if (!current) throw new DomainError("Media folder not found.", "media_folder_not_found", 404);
        if (current.version !== input.expectedVersion) throw new DomainError("This folder changed while you were working. Refresh and try again.", "media_folder_version_conflict", 409);
        const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
        if (parentId === input.id) throw new DomainError("A folder cannot contain itself.", "media_folder_cycle", 409);
        let parentDepth = 0;
        if (parentId) {
          const ancestors = await sql<{ id: string; depth: number }[]>`
            with recursive ancestors as (
              select id,parent_id,1 as depth from media_folders where id=${parentId} and workspace_id=${input.workspaceId} and brand_id=${input.brandId}
              union all select f.id,f.parent_id,a.depth+1 from media_folders f join ancestors a on f.id=a.parent_id where f.workspace_id=${input.workspaceId} and f.brand_id=${input.brandId}
            ) select id,depth from ancestors`;
          if (!ancestors.length) throw new DomainError("The parent folder is unavailable in this brand.", "media_folder_parent_not_found", 404);
          if (ancestors.some((entry) => entry.id === input.id)) throw new DomainError("A folder cannot move inside one of its descendants.", "media_folder_cycle", 409);
          parentDepth = Math.max(...ancestors.map((entry) => entry.depth));
        }
        const descendants = await sql<{ depth: number }[]>`
          with recursive descendants as (
            select id,1 as depth from media_folders where id=${input.id}
            union all select f.id,d.depth+1 from media_folders f join descendants d on f.parent_id=d.id where f.workspace_id=${input.workspaceId} and f.brand_id=${input.brandId}
          ) select depth from descendants`;
        const subtreeDepth = Math.max(...descendants.map((entry) => entry.depth));
        if (parentDepth + subtreeDepth > MAX_MEDIA_FOLDER_DEPTH) throw new DomainError(`Folders can be nested at most ${MAX_MEDIA_FOLDER_DEPTH} levels deep.`, "media_folder_depth_limit", 409);
        const rows = await sql<FolderRow[]>`update media_folders set parent_id=${parentId},name=${name},normalized_name=${name.toLocaleLowerCase("en-US")},version=version+1,updated_by=${input.actorId},updated_at=${input.at}
          where id=${input.id} and workspace_id=${input.workspaceId} and brand_id=${input.brandId} and version=${input.expectedVersion} returning *`;
        if (!rows[0]) throw new DomainError("This folder changed while you were working. Refresh and try again.", "media_folder_version_conflict", 409);
        await this.audit(sql, event);
        return folder(rows[0]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError("A folder with this name already exists here.", "media_folder_name_conflict", 409);
      throw error;
    }
  }

  async deleteFolder(input: { workspaceId: string; brandId: string; id: string; expectedVersion: number }, event: AuditEvent): Promise<void> {
    await this.sql.begin(async (sql) => {
      const rows = await sql<FolderRow[]>`select * from media_folders where id=${input.id} and workspace_id=${input.workspaceId} and brand_id=${input.brandId} for update`;
      if (!rows[0]) throw new DomainError("Media folder not found.", "media_folder_not_found", 404);
      if (rows[0].version !== input.expectedVersion) throw new DomainError("This folder changed while you were working. Refresh and try again.", "media_folder_version_conflict", 409);
      const usage = await sql<{ children: string | number; assets: string | number }[]>`select
        (select count(*) from media_folders where parent_id=${input.id} and workspace_id=${input.workspaceId} and brand_id=${input.brandId}) as children,
        (select count(*) from media_asset_organization where folder_id=${input.id} and workspace_id=${input.workspaceId} and brand_id=${input.brandId}) as assets`;
      if (Number(usage[0]?.children ?? 0) || Number(usage[0]?.assets ?? 0)) throw new DomainError("Move the folder's files and subfolders before deleting it.", "media_folder_not_empty", 409);
      await sql`delete from media_folders where id=${input.id} and workspace_id=${input.workspaceId} and brand_id=${input.brandId} and version=${input.expectedVersion}`;
      await this.audit(sql, event);
    });
  }

  async bulkOrganize(input: MediaBulkOrganizationInput, event: AuditEvent): Promise<MediaAssetOrganization[]> {
    if (!input.assets.length || input.assets.length > 100 || new Set(input.assets.map((entry) => entry.assetId)).size !== input.assets.length) throw new DomainError("Choose 1–100 distinct media assets.", "media_bulk_selection_invalid", 400);
    return this.sql.begin(async (sql) => {
      if (input.folderId !== undefined && input.folderId !== null) {
        const folders = await sql<{ id: string }[]>`select id from media_folders where id=${input.folderId} and workspace_id=${input.workspaceId} and brand_id=${input.brandId}`;
        if (!folders[0]) throw new DomainError("The selected folder is unavailable in this brand.", "media_folder_not_found", 404);
      }
      const ids = input.assets.map((entry) => entry.assetId);
      const assets = await sql<{ id: string }[]>`select id from media_assets where workspace_id=${input.workspaceId} and brand_id=${input.brandId} and id=any(${sql.array(ids)}::text[]) for update`;
      if (assets.length !== ids.length) throw new DomainError("One or more media assets are unavailable in this brand.", "media_asset_not_found", 404);
      const rows = await sql<OrganizationRow[]>`select * from media_asset_organization where workspace_id=${input.workspaceId} and brand_id=${input.brandId} and asset_id=any(${sql.array(ids)}::text[]) for update`;
      const byId = new Map(rows.map((row) => [row.asset_id, organization(row)]));
      const planned = input.assets.map((selected) => {
        const current = byId.get(selected.assetId) ?? { workspaceId: input.workspaceId, brandId: input.brandId, assetId: selected.assetId, tags: [], favorite: false, version: 0 };
        if (current.version !== selected.expectedVersion) throw new DomainError("The media organization changed while you were working. Refresh and try again.", "media_organization_version_conflict", 409);
        return applyMediaOrganizationMutation(current, input);
      });
      for (const next of planned) await sql`insert into media_asset_organization(asset_id,workspace_id,brand_id,folder_id,tags,favorite,version,updated_by,updated_at)
        values(${next.assetId},${next.workspaceId},${next.brandId},${next.folderId ?? null},${sql.array(next.tags)},${next.favorite},${next.version},${next.updatedBy!},${next.updatedAt!})
        on conflict(asset_id) do update set folder_id=excluded.folder_id,tags=excluded.tags,favorite=excluded.favorite,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`;
      await this.audit(sql, event);
      return planned;
    });
  }
}
