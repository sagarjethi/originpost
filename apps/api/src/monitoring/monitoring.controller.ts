import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { IdParamDto, WorkspaceQueryDto } from "../content/dto/content.dto.js";
import { CreateMonitorDto, UpdateMonitorDto } from "./dto/monitor.dto.js";
import { MonitoringService } from "./monitoring.service.js";

@Controller({ path: "monitors", version: "1" })
export class MonitoringController {
  constructor(private readonly monitors: MonitoringService) {}
  @Get() list(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto) { return this.monitors.list(workspaceFrom(request, query.workspaceId), actorFrom(request), query.brandId) }
  @Get("status") status(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto) { return this.monitors.status(workspaceFrom(request, query.workspaceId), actorFrom(request), query.brandId) }
  @Get(":id/runs") runs(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.monitors.runs(workspaceFrom(request, query.workspaceId), params.id) }
  @Post() create(@Req() request: FastifyRequest, @Body() dto: CreateMonitorDto) { return this.monitors.create(dto, actorFrom(request)) }
  @Post(":id/run") run(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.monitors.trigger(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
  @Patch(":id") update(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: UpdateMonitorDto) { return this.monitors.update(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request)) }
}
