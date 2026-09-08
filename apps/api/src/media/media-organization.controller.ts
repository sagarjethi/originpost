import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { BulkOrganizeMediaDto, CreateMediaFolderDto, DeleteMediaFolderQueryDto, MediaFolderIdParamDto, MediaOrganizationQueryDto, UpdateMediaFolderDto } from "./media-organization.dto.js";
import { MediaOrganizationService } from "./media-organization.service.js";

@Controller({ path: "media-assets", version: "1" })
export class MediaOrganizationController {
  constructor(private readonly organization: MediaOrganizationService) {}
  @Get("library") list(@Req() request: FastifyRequest, @Query() query: MediaOrganizationQueryDto) { return this.organization.list(workspaceFrom(request, query.workspaceId), query, actorFrom(request)); }
  @Get("folders") folders(@Req() request: FastifyRequest, @Query() query: MediaOrganizationQueryDto) { return this.organization.folders(workspaceFrom(request, query.workspaceId), query.brandId, actorFrom(request)); }
  @Post("folders") create(@Req() request: FastifyRequest, @Body() dto: CreateMediaFolderDto) { return this.organization.createFolder(workspaceFrom(request, dto.workspaceId), dto, actorFrom(request)); }
  @Patch("folders/:id") update(@Req() request: FastifyRequest, @Param() params: MediaFolderIdParamDto, @Body() dto: UpdateMediaFolderDto) { return this.organization.updateFolder(workspaceFrom(request, dto.workspaceId), params.id, dto, actorFrom(request)); }
  @Delete("folders/:id") @HttpCode(HttpStatus.OK) remove(@Req() request: FastifyRequest, @Param() params: MediaFolderIdParamDto, @Query() query: DeleteMediaFolderQueryDto) { return this.organization.deleteFolder(workspaceFrom(request, query.workspaceId), query.brandId, params.id, query.version, actorFrom(request)); }
  @Post("organize") @HttpCode(HttpStatus.OK) organize(@Req() request: FastifyRequest, @Body() dto: BulkOrganizeMediaDto) { return this.organization.bulkOrganize(workspaceFrom(request, dto.workspaceId), dto, actorFrom(request)); }
}
