import { Inject, Injectable } from "@nestjs/common";
import { can, createBrand, createWorkspaceOrganization, DomainError, renameWorkspace, updateBrand, type Actor } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { CreateBrandDto, CreateWorkspaceDto, UpdateBrandDto, UpdateWorkspaceDto } from "./dto/organization.dto.js";

@Injectable()
export class OrganizationsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  listWorkspaces(userId: string, allForLocalOwner: boolean) {
    return this.infrastructure.organizationRepository.listWorkspaces(allForLocalOwner ? undefined : userId);
  }

  async createWorkspace(dto: CreateWorkspaceDto, actor: Actor) {
    const result = createWorkspaceOrganization({ ...dto, actor });
    return this.infrastructure.organizationRepository.createWorkspace({
      ...result,
      ownerUserId: actor.id,
      ownerDisplayName: actor.name,
    });
  }

  async updateWorkspace(workspaceId: string, dto: UpdateWorkspaceDto, actor: Actor) {
    const current = await this.infrastructure.organizationRepository.getWorkspace(workspaceId);
    if (!current) throw new DomainError("Workspace not found.", "workspace_not_found", 404);
    const result = renameWorkspace(current, dto, actor);
    return this.infrastructure.organizationRepository.updateWorkspace(result.workspace, result.event);
  }

  listBrands(workspaceId: string, actor: Actor, includeArchived = false) {
    if (!can(actor.role, "content:read")) throw new DomainError("Workspace access is required.", "permission_denied", 403);
    return this.infrastructure.organizationRepository.listBrands(workspaceId, includeArchived && can(actor.role, "workspace:manage"));
  }

  async createBrand(workspaceId: string, dto: CreateBrandDto, actor: Actor) {
    if (!await this.infrastructure.organizationRepository.getWorkspace(workspaceId)) throw new DomainError("Workspace not found.", "workspace_not_found", 404);
    const result = createBrand({ workspaceId, ...dto, actor });
    return this.infrastructure.organizationRepository.saveBrand(result.brand, result.event);
  }

  async updateBrand(workspaceId: string, brandId: string, dto: UpdateBrandDto, actor: Actor) {
    const current = await this.infrastructure.organizationRepository.getBrand(workspaceId, brandId);
    if (!current) throw new DomainError("Brand not found.", "brand_not_found", 404);
    const result = updateBrand(current, dto, actor);
    if (result.brand.status === "archived") {
      const active = await this.infrastructure.organizationRepository.listBrands(workspaceId);
      if (active.length <= 1 && active.some((brand) => brand.id === brandId)) throw new DomainError("A workspace must keep at least one active brand.", "last_active_brand_required", 409);
    }
    return this.infrastructure.organizationRepository.saveBrand(result.brand, result.event);
  }
}
