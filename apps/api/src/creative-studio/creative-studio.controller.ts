import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { AddCreativeRevisionDto, CreateCreativeProjectDto, CreativeStudioQueryDto, RenderCreativeRevisionDto } from "./creative-studio.dto.js";
import { CreativeStudioService } from "./creative-studio.service.js";

@Controller({ path: "creative-studio", version: "1" })
export class CreativeStudioController {
  constructor(private readonly creative: CreativeStudioService) {}
  @Get("templates") templates(@Req() request: FastifyRequest) { return this.creative.templates(actorFrom(request)) }
  @Get("projects") list(@Req() request: FastifyRequest, @Query() query: CreativeStudioQueryDto) { return this.creative.list(workspaceFrom(request, query.workspaceId), query.brandId, query.limit, actorFrom(request)) }
  @Get("projects/:projectId") detail(@Req() request: FastifyRequest, @Query() query: CreativeStudioQueryDto, @Param("projectId") projectId: string) { return this.creative.detail(workspaceFrom(request, query.workspaceId), projectId, actorFrom(request)) }
  @Post("projects") create(@Req() request: FastifyRequest, @Body() dto: CreateCreativeProjectDto) { return this.creative.create(workspaceFrom(request, dto.workspaceId), dto, actorFrom(request)) }
  @Post("projects/:projectId/revisions") revision(@Req() request: FastifyRequest, @Param("projectId") projectId: string, @Body() dto: AddCreativeRevisionDto) { return this.creative.addRevision(workspaceFrom(request, dto.workspaceId), projectId, expectedVersionFrom(request), dto, actorFrom(request)) }
  @Post("projects/:projectId/revisions/:revisionId/render") render(@Req() request: FastifyRequest, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Body() dto: RenderCreativeRevisionDto) { return this.creative.render(workspaceFrom(request, dto.workspaceId), projectId, revisionId, expectedVersionFrom(request), actorFrom(request)) }
}
