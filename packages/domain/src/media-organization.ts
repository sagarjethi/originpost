import { DomainError } from "./errors.js";
import type { AuditEvent, MediaAsset, MediaKind, MediaRepository, MediaStatus } from "./types.js";

export const MAX_MEDIA_FOLDER_DEPTH = 5;
export const MAX_MEDIA_TAGS = 20;

export interface MediaFolder {
  id: string;
  workspaceId: string;
  brandId: string;
  parentId?: string | undefined;
  name: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface MediaFolderView extends MediaFolder {
  directAssetCount: number;
  childFolderCount: number;
}

export interface MediaAssetOrganization {
  workspaceId: string;
  brandId: string;
  assetId: string;
  folderId?: string | undefined;
  tags: string[];
  favorite: boolean;
  version: number;
  updatedBy?: string | undefined;
  updatedAt?: string | undefined;
}

export interface MediaLibraryEntry {
  asset: MediaAsset;
  organization: MediaAssetOrganization;
}

export type MediaLibraryView = "active" | "trash" | "history";

export interface MediaLibraryQuery {
  workspaceId: string;
  brandId: string;
  view?: MediaLibraryView | undefined;
  search?: string | undefined;
  folderId?: string | undefined;
  unfiled?: boolean | undefined;
  favorite?: boolean | undefined;
  tags?: string[] | undefined;
  kind?: MediaKind | undefined;
  limit?: number | undefined;
}

export interface MediaLibraryPage {
  items: MediaLibraryEntry[];
  total: number;
  availableTags: string[];
}

export interface MediaBulkOrganizationInput {
  workspaceId: string;
  brandId: string;
  assets: Array<{ assetId: string; expectedVersion: number }>;
  folderId?: string | null | undefined;
  addTags?: string[] | undefined;
  removeTags?: string[] | undefined;
  favorite?: boolean | undefined;
  actorId: string;
  at: string;
}

export interface MediaOrganizationRepository {
  listLibrary(query: MediaLibraryQuery): Promise<MediaLibraryPage>;
  listFolders(workspaceId: string, brandId: string): Promise<MediaFolderView[]>;
  createFolder(folder: MediaFolder, event: AuditEvent): Promise<MediaFolder>;
  updateFolder(input: { workspaceId: string; brandId: string; id: string; expectedVersion: number; name: string; parentId?: string | null; actorId: string; at: string }, event: AuditEvent): Promise<MediaFolder>;
  deleteFolder(input: { workspaceId: string; brandId: string; id: string; expectedVersion: number }, event: AuditEvent): Promise<void>;
  bulkOrganize(input: MediaBulkOrganizationInput, event: AuditEvent): Promise<MediaAssetOrganization[]>;
}

export function normalizeMediaFolderName(value: string): string {
  const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!name || name.length > 80 || /[\p{Cc}\/\\]/u.test(name)) {
    throw new DomainError("Folder names must be 1–80 characters and cannot contain slashes or control characters.", "media_folder_name_invalid", 400);
  }
  return name;
}

export function normalizeMediaTag(value: string): string {
  const tag = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  if (!tag || tag.length > 30 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(tag)) {
    throw new DomainError("Tags must be 1–30 letters or numbers and may include spaces, underscores, or hyphens.", "media_tag_invalid", 400);
  }
  return tag;
}

export function normalizeMediaTags(values: readonly string[]): string[] {
  const tags = [...new Set(values.map(normalizeMediaTag))].sort((a, b) => a.localeCompare(b, "en"));
  if (tags.length > MAX_MEDIA_TAGS) throw new DomainError(`A media asset can have at most ${MAX_MEDIA_TAGS} tags.`, "media_tag_limit", 400);
  return tags;
}

export function createMediaFolder(input: Omit<MediaFolder, "name" | "version"> & { name: string }): MediaFolder {
  return { ...input, name: normalizeMediaFolderName(input.name), version: 1 };
}

export function applyMediaOrganizationMutation(current: MediaAssetOrganization, input: Pick<MediaBulkOrganizationInput, "folderId" | "addTags" | "removeTags" | "favorite" | "actorId" | "at">): MediaAssetOrganization {
  const changes = input.folderId !== undefined || input.favorite !== undefined || Boolean(input.addTags?.length) || Boolean(input.removeTags?.length);
  if (!changes) throw new DomainError("Choose a folder, favorite state, or tag change.", "media_organization_change_required", 400);
  const add = normalizeMediaTags(input.addTags ?? []);
  const remove = new Set(normalizeMediaTags(input.removeTags ?? []));
  const tags = normalizeMediaTags([...current.tags.filter((tag) => !remove.has(normalizeMediaTag(tag))), ...add]);
  return {
    ...current,
    ...(input.folderId !== undefined ? input.folderId === null ? { folderId: undefined } : { folderId: input.folderId } : {}),
    ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
    tags,
    version: current.version + 1,
    updatedBy: input.actorId,
    updatedAt: input.at,
  };
}

export function mediaStatusInView(status: MediaStatus, view: MediaLibraryView = "active"): boolean {
  if (view === "active") return status === "ready" || status === "pending";
  if (view === "trash") return status === "trashed" || status === "cleanup_failed";
  return status === "rejected" || status === "expired" || status === "deleted";
}

function organizationKey(workspaceId: string, assetId: string): string { return `${workspaceId}:${assetId}`; }

export class InMemoryMediaOrganizationRepository implements MediaOrganizationRepository {
  private readonly folders = new Map<string, MediaFolder>();
  private readonly organization = new Map<string, MediaAssetOrganization>();

  constructor(private readonly media: MediaRepository) {}

  private folder(workspaceId: string, brandId: string, id: string): MediaFolder | null {
    const folder = this.folders.get(id);
    return folder?.workspaceId === workspaceId && folder.brandId === brandId ? folder : null;
  }

  private assertParent(workspaceId: string, brandId: string, parentId: string | undefined, movingId?: string): void {
    if (!parentId) return;
    if (parentId === movingId) throw new DomainError("A folder cannot contain itself.", "media_folder_cycle", 409);
    let current = this.folder(workspaceId, brandId, parentId);
    if (!current) throw new DomainError("The parent folder is unavailable in this brand.", "media_folder_parent_not_found", 404);
    let depth = 1;
    while (current.parentId) {
      if (current.parentId === movingId) throw new DomainError("A folder cannot move inside one of its descendants.", "media_folder_cycle", 409);
      current = this.folder(workspaceId, brandId, current.parentId);
      if (!current) throw new DomainError("The folder tree is inconsistent.", "media_folder_tree_invalid", 409);
      depth += 1;
    }
    if (depth >= MAX_MEDIA_FOLDER_DEPTH) throw new DomainError(`Folders can be nested at most ${MAX_MEDIA_FOLDER_DEPTH} levels deep.`, "media_folder_depth_limit", 409);
  }

  private assertUniqueName(folder: Pick<MediaFolder, "workspaceId" | "brandId" | "parentId" | "name">, ignoredId?: string): void {
    const duplicate = [...this.folders.values()].find((entry) => entry.id !== ignoredId && entry.workspaceId === folder.workspaceId && entry.brandId === folder.brandId && entry.parentId === folder.parentId && entry.name.localeCompare(folder.name, "en", { sensitivity: "base" }) === 0);
    if (duplicate) throw new DomainError("A folder with this name already exists here.", "media_folder_name_conflict", 409);
  }

  async listLibrary(query: MediaLibraryQuery): Promise<MediaLibraryPage> {
    const all = await this.media.list(query.workspaceId, 10_000, query.brandId);
    const wantedTags = normalizeMediaTags(query.tags ?? []);
    const search = query.search?.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    let entries = all.map((asset): MediaLibraryEntry => ({
      asset,
      organization: structuredClone(this.organization.get(organizationKey(query.workspaceId, asset.id)) ?? {
        workspaceId: asset.workspaceId, brandId: asset.brandId, assetId: asset.id, tags: [], favorite: false, version: 0,
      }),
    })).filter(({ asset, organization }) =>
      mediaStatusInView(asset.status, query.view)
      && (!query.kind || asset.kind === query.kind)
      && (!query.folderId || organization.folderId === query.folderId)
      && (!query.unfiled || !organization.folderId)
      && (!query.favorite || organization.favorite)
      && (!wantedTags.length || wantedTags.every((tag) => organization.tags.includes(tag)))
      && (!search || `${asset.fileName} ${asset.altText ?? ""} ${organization.tags.join(" ")}`.normalize("NFKC").toLocaleLowerCase("en-US").includes(search))
    );
    entries = entries.sort((a, b) => Number(b.organization.favorite) - Number(a.organization.favorite) || b.asset.createdAt.localeCompare(a.asset.createdAt));
    const availableTags = [...new Set(all.flatMap((asset) => this.organization.get(organizationKey(query.workspaceId, asset.id))?.tags ?? []).map(normalizeMediaTag))].sort((a, b) => a.localeCompare(b, "en"));
    return { items: entries.slice(0, Math.max(1, Math.min(200, query.limit ?? 100))).map((entry) => structuredClone(entry)), total: entries.length, availableTags };
  }

  async listFolders(workspaceId: string, brandId: string): Promise<MediaFolderView[]> {
    return [...this.folders.values()].filter((folder) => folder.workspaceId === workspaceId && folder.brandId === brandId).map((folder) => ({
      ...structuredClone(folder),
      childFolderCount: [...this.folders.values()].filter((child) => child.parentId === folder.id && child.workspaceId === workspaceId).length,
      directAssetCount: [...this.organization.values()].filter((entry) => entry.workspaceId === workspaceId && entry.brandId === brandId && entry.folderId === folder.id).length,
    })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  async createFolder(folder: MediaFolder): Promise<MediaFolder> {
    if (this.folders.has(folder.id)) throw new DomainError("This folder already exists.", "media_folder_conflict", 409);
    const normalized = { ...folder, name: normalizeMediaFolderName(folder.name) };
    this.assertParent(folder.workspaceId, folder.brandId, folder.parentId);
    this.assertUniqueName(normalized);
    this.folders.set(folder.id, structuredClone(normalized));
    return structuredClone(normalized);
  }

  async updateFolder(input: { workspaceId: string; brandId: string; id: string; expectedVersion: number; name: string; parentId?: string | null; actorId: string; at: string }): Promise<MediaFolder> {
    const existing = this.folder(input.workspaceId, input.brandId, input.id);
    if (!existing) throw new DomainError("Media folder not found.", "media_folder_not_found", 404);
    if (existing.version !== input.expectedVersion) throw new DomainError("This folder changed while you were working. Refresh and try again.", "media_folder_version_conflict", 409);
    const parentId = input.parentId === undefined ? existing.parentId : input.parentId ?? undefined;
    const next = { ...existing, name: normalizeMediaFolderName(input.name), parentId, version: existing.version + 1, updatedBy: input.actorId, updatedAt: input.at };
    this.assertParent(input.workspaceId, input.brandId, parentId, input.id);
    this.assertUniqueName(next, input.id);
    this.folders.set(input.id, structuredClone(next));
    return structuredClone(next);
  }

  async deleteFolder(input: { workspaceId: string; brandId: string; id: string; expectedVersion: number }): Promise<void> {
    const folder = this.folder(input.workspaceId, input.brandId, input.id);
    if (!folder) throw new DomainError("Media folder not found.", "media_folder_not_found", 404);
    if (folder.version !== input.expectedVersion) throw new DomainError("This folder changed while you were working. Refresh and try again.", "media_folder_version_conflict", 409);
    if ([...this.folders.values()].some((child) => child.parentId === folder.id) || [...this.organization.values()].some((entry) => entry.folderId === folder.id)) {
      throw new DomainError("Move the folder's files and subfolders before deleting it.", "media_folder_not_empty", 409);
    }
    this.folders.delete(folder.id);
  }

  async bulkOrganize(input: MediaBulkOrganizationInput): Promise<MediaAssetOrganization[]> {
    if (!input.assets.length || input.assets.length > 100 || new Set(input.assets.map((entry) => entry.assetId)).size !== input.assets.length) {
      throw new DomainError("Choose 1–100 distinct media assets.", "media_bulk_selection_invalid", 400);
    }
    if (input.folderId !== undefined && input.folderId !== null && !this.folder(input.workspaceId, input.brandId, input.folderId)) {
      throw new DomainError("The selected folder is unavailable in this brand.", "media_folder_not_found", 404);
    }
    const planned: MediaAssetOrganization[] = [];
    for (const selected of input.assets) {
      const asset = await this.media.get(input.workspaceId, selected.assetId);
      if (!asset || asset.brandId !== input.brandId) throw new DomainError("One or more media assets are unavailable in this brand.", "media_asset_not_found", 404);
      const current = this.organization.get(organizationKey(input.workspaceId, selected.assetId)) ?? { workspaceId: input.workspaceId, brandId: input.brandId, assetId: selected.assetId, tags: [], favorite: false, version: 0 };
      if (current.version !== selected.expectedVersion) throw new DomainError("The media organization changed while you were working. Refresh and try again.", "media_organization_version_conflict", 409);
      planned.push(applyMediaOrganizationMutation(current, input));
    }
    for (const entry of planned) this.organization.set(organizationKey(entry.workspaceId, entry.assetId), structuredClone(entry));
    return planned.map((entry) => structuredClone(entry));
  }
}
