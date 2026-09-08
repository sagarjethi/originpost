import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { Public } from "../common/public.decorator.js";
import { AnalyticsReportService } from "./analytics-report.service.js";
import { AnalyticsReportParamDto, AnalyticsReportQueryDto, AnalyticsReportShareIdParamDto, AnalyticsReportSnapshotParamDto, AnalyticsReportTokenParamDto, CreateAnalyticsReportDto, CreateAnalyticsReportShareDto } from "./dto/analytics.dto.js";

@Controller({ path: "analytics/reports", version: "1" })
export class AnalyticsReportController {
  constructor(private readonly reports: AnalyticsReportService) {}

  @Get()
  list(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto) {
    return this.reports.list(workspaceFrom(request, query.workspaceId), actorFrom(request), query.includeArchived === "true");
  }

  @Post()
  create(@Req() request: FastifyRequest, @Body() dto: CreateAnalyticsReportDto) {
    return this.reports.create(workspaceFrom(request, dto.workspaceId), dto, actorFrom(request));
  }

  @Get(":reportId")
  get(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto, @Param() params: AnalyticsReportParamDto) {
    return this.reports.get(workspaceFrom(request, query.workspaceId), params.reportId, actorFrom(request));
  }

  @Post(":reportId/generate") @HttpCode(HttpStatus.CREATED)
  generate(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto, @Param() params: AnalyticsReportParamDto) {
    return this.reports.generate(workspaceFrom(request, query.workspaceId), params.reportId, actorFrom(request));
  }

  @Post(":reportId/archive")
  archive(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto, @Param() params: AnalyticsReportParamDto) {
    return this.reports.archive(workspaceFrom(request, query.workspaceId), params.reportId, actorFrom(request));
  }

  @Get(":reportId/snapshots/:snapshotId")
  snapshot(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto, @Param() params: AnalyticsReportSnapshotParamDto) {
    return this.reports.snapshot(workspaceFrom(request, query.workspaceId), params.reportId, params.snapshotId, actorFrom(request));
  }

  @Get(":reportId/snapshots/:snapshotId/export.csv")
  async exportCsv(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto, @Param() params: AnalyticsReportSnapshotParamDto, @Res() reply: FastifyReply) {
    const result = await this.reports.exportCsv(workspaceFrom(request, query.workspaceId), params.reportId, params.snapshotId, actorFrom(request));
    return reply.header("cache-control", "private, no-store").header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${result.fileName}"`).send(result.csv);
  }

  @Post(":reportId/snapshots/:snapshotId/shares")
  share(@Req() request: FastifyRequest, @Param() params: AnalyticsReportSnapshotParamDto, @Body() dto: CreateAnalyticsReportShareDto) {
    return this.reports.share(workspaceFrom(request, dto.workspaceId), params.reportId, params.snapshotId, dto.expiresInDays, actorFrom(request));
  }

  @Post(":reportId/shares/:shareId/revoke")
  revoke(@Req() request: FastifyRequest, @Query() query: AnalyticsReportQueryDto, @Param() params: AnalyticsReportShareIdParamDto) {
    return this.reports.revoke(workspaceFrom(request, query.workspaceId), params.reportId, params.shareId, actorFrom(request));
  }
}

@Public()
@Controller({ path: "analytics-reports", version: "1" })
export class PublicAnalyticsReportController {
  constructor(private readonly reports: AnalyticsReportService) {}

  @Get(":token") @Header("Cache-Control", "no-store")
  view(@Param() params: AnalyticsReportTokenParamDto) { return this.reports.publicView(params.token); }

  @Get(":token/export.csv")
  async exportCsv(@Param() params: AnalyticsReportTokenParamDto, @Res() reply: FastifyReply) {
    const result = await this.reports.publicCsv(params.token);
    return reply.header("cache-control", "no-store").header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${result.fileName}"`).send(result.csv);
  }
}
