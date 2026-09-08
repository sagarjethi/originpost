import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedRequest } from "../common/auth-context.guard.js";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { WorkspaceOptional } from "../common/workspace-optional.decorator.js";
import { BrandParamDto, CreateBrandDto, CreateWorkspaceDto, UpdateBrandDto, UpdateWorkspaceDto, WorkspaceParamDto } from "./dto/organization.dto.js";
import { OrganizationsService } from "./organizations.service.js";

@Controller({ path: "workspaces", version: "1" })
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @WorkspaceOptional() @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.organizations.listWorkspaces(request.originpostUserId!, request.originpostSessionId === undefined);
  }

  @WorkspaceOptional() @Post()
  create(@Req() request: FastifyRequest, @Body() dto: CreateWorkspaceDto) {
    return this.organizations.createWorkspace(dto, actorFrom(request));
  }

  @Patch(":workspaceId")
  update(@Req() request: FastifyRequest, @Param() params: WorkspaceParamDto, @Body() dto: UpdateWorkspaceDto) {
    return this.organizations.updateWorkspace(workspaceFrom(request, params.workspaceId), dto, actorFrom(request));
  }

  @Get(":workspaceId/brands")
  brands(@Req() request: FastifyRequest, @Param() params: WorkspaceParamDto, @Query("includeArchived") includeArchived?: string) {
    return this.organizations.listBrands(workspaceFrom(request, params.workspaceId), actorFrom(request), includeArchived === "true");
  }

  @Post(":workspaceId/brands")
  createBrand(@Req() request: FastifyRequest, @Param() params: WorkspaceParamDto, @Body() dto: CreateBrandDto) {
    return this.organizations.createBrand(workspaceFrom(request, params.workspaceId), dto, actorFrom(request));
  }

  @Patch(":workspaceId/brands/:brandId")
  updateBrand(@Req() request: FastifyRequest, @Param() params: BrandParamDto, @Body() dto: UpdateBrandDto) {
    return this.organizations.updateBrand(workspaceFrom(request, params.workspaceId), params.brandId, dto, actorFrom(request));
  }
}
