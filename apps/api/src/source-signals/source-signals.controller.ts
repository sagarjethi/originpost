import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { DismissSourceSignalDto, SourceSignalQueryDto } from "./dto/source-signal.dto.js";
import { SourceSignalsService } from "./source-signals.service.js";

@Controller({ path: "signals", version: "1" })
export class SourceSignalsController {
  constructor(private readonly signals: SourceSignalsService) {}
  @Get() list(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto) { return this.signals.list(workspaceFrom(request, query.workspaceId), query, actorFrom(request)); }
  @Get("summary") summary(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto) { return this.signals.summary(workspaceFrom(request, query.workspaceId), query.brandId, actorFrom(request)); }
  @Get(":id/sources/:sourceId/screenshot") screenshot(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto, @Param("id") id: string, @Param("sourceId") sourceId: string) { return this.signals.screenshot(workspaceFrom(request, query.workspaceId), id, sourceId, actorFrom(request)); }
  @Get(":id") get(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto, @Param("id") id: string) { return this.signals.get(workspaceFrom(request, query.workspaceId), id, actorFrom(request)); }
  @Post(":id/save") save(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto, @Param("id") id: string) { return this.signals.save(workspaceFrom(request, query.workspaceId), id, expectedVersionFrom(request), actorFrom(request)); }
  @Post(":id/dismiss") dismiss(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto, @Param("id") id: string, @Body() dto: DismissSourceSignalDto) { return this.signals.dismiss(workspaceFrom(request, query.workspaceId), id, expectedVersionFrom(request), dto.reason, actorFrom(request)); }
  @Post(":id/restore") restore(@Req() request: FastifyRequest, @Query() query: SourceSignalQueryDto, @Param("id") id: string) { return this.signals.restore(workspaceFrom(request, query.workspaceId), id, expectedVersionFrom(request), actorFrom(request)); }
}
