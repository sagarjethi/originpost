import { ForbiddenException, Injectable } from "@nestjs/common";
import { can, createMediaFolder, type Actor, type AuditEvent, type MediaLibraryEntry } from "@originpost/domain";
import { resolveActiveBrand, resolveBrandFilter } from "../common/brand-context.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { Inject } from "@nestjs/common";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { BulkOrganizeMediaDto, CreateMediaFolderDto, MediaOrganizationQueryDto, UpdateMediaFolderDto } from "./media-organization.dto.js";

function audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent {
  return { id: `audit_${crypto.randomUUID()}`, workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human", action, detail, createdAt: new Date().toISOString() };
}
function publicEntry(entry: MediaLibraryEntry) {
  const { objectKey: _privateObjectKey, ...asset } = entry.asset;
  return { asset, organization: entry.organization };
}

@Injectable()
export class MediaOrganizationService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  async list(workspaceId: string, query: MediaOrganizationQueryDto, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view media.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, query.brandId);
    if (!brandId) return { items: [], total: 0, availableTags: [] };
    const page = await this.infrastructure.mediaOrganizationRepository.listLibrary({ workspaceId, brandId, view: query.view, search: query.search, folderId: query.folderId, unfiled: query.unfiled, favorite: query.favorite, tags: query.tags, kind: query.kind, limit: query.limit });
    return { ...page, items: page.items.map(publicEntry) };
  }

  async folders(workspaceId: string, requestedBrandId: string | undefined, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view media folders.");
    const brandId = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    return brandId ? this.infrastructure.mediaOrganizationRepository.listFolders(workspaceId, brandId) : [];
  }

  async createFolder(workspaceId: string, dto: CreateMediaFolderDto, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot organize media.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, dto.brandId);
    const at = new Date().toISOString();
    const value = createMediaFolder({ id: `media_folder_${crypto.randomUUID()}`, workspaceId, brandId, ...(dto.parentId ? { parentId: dto.parentId } : {}), name: dto.name, createdBy: actor.id, createdAt: at, updatedBy: actor.id, updatedAt: at });
    return this.infrastructure.mediaOrganizationRepository.createFolder(value, audit(workspaceId, actor, "media.folder-created", { folderId: value.id, parentId: value.parentId, name: value.name, brandId }));
  }

  async updateFolder(workspaceId: string, id: string, dto: UpdateMediaFolderDto, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot organize media.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, dto.brandId);
    const at = new Date().toISOString();
    return this.infrastructure.mediaOrganizationRepository.updateFolder({ workspaceId, brandId, id, expectedVersion: dto.version, name: dto.name, ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}), actorId: actor.id, at }, audit(workspaceId, actor, "media.folder-updated", { folderId: id, parentId: dto.parentId, name: dto.name, brandId, expectedVersion: dto.version }));
  }

  async deleteFolder(workspaceId: string, brandIdInput: string | undefined, id: string, version: number, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot organize media.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, brandIdInput);
    await this.infrastructure.mediaOrganizationRepository.deleteFolder({ workspaceId, brandId, id, expectedVersion: version }, audit(workspaceId, actor, "media.folder-deleted", { folderId: id, brandId, expectedVersion: version }));
    return { deleted: true };
  }

  async bulkOrganize(workspaceId: string, dto: BulkOrganizeMediaDto, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot organize media.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, dto.brandId);
    const at = new Date().toISOString();
    const organized = await this.infrastructure.mediaOrganizationRepository.bulkOrganize({ workspaceId, brandId, assets: dto.assets, ...(dto.folderId !== undefined ? { folderId: dto.folderId } : {}), ...(dto.addTags ? { addTags: dto.addTags } : {}), ...(dto.removeTags ? { removeTags: dto.removeTags } : {}), ...(dto.favorite !== undefined ? { favorite: dto.favorite } : {}), actorId: actor.id, at }, audit(workspaceId, actor, "media.assets-organized", { brandId, assetIds: dto.assets.map((entry) => entry.assetId), folderId: dto.folderId, addTags: dto.addTags, removeTags: dto.removeTags, favorite: dto.favorite }));
    return { organized };
  }
}
