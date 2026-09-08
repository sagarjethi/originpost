import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { AnalyticsService } from "./analytics.service.js";
import { AnalyticsProofParamDto, AnalyticsQueryDto } from "./dto/analytics.dto.js";

@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  list(@Req() request: FastifyRequest, @Query() query: AnalyticsQueryDto) {
    return this.analytics.list(workspaceFrom(request, query.workspaceId), query.brandId, actorFrom(request));
  }

  @Post("content-items/:contentItemId/proofs/:proofId/refresh") @HttpCode(HttpStatus.ACCEPTED)
  refresh(@Req() request: FastifyRequest, @Query() query: AnalyticsQueryDto, @Param() params: AnalyticsProofParamDto) {
    return this.analytics.refresh(workspaceFrom(request, query.workspaceId), params.contentItemId, params.proofId, actorFrom(request));
  }
}
