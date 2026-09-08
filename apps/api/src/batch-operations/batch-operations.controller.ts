import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { ApproveBatchDto, BatchIdParamDto, BatchVersionDto, BatchWorkspaceQueryDto, PreviewBatchDto } from "./batch-operations.dto.js";
import { BatchOperationsService } from "./batch-operations.service.js";
@Controller({ path: "batch-operations", version: "1" })
export class BatchOperationsController {
  constructor(private readonly batches: BatchOperationsService) {}
  @Get() list(@Req() request: FastifyRequest, @Query() query: BatchWorkspaceQueryDto) { return this.batches.list(workspaceFrom(request, query.workspaceId), query.brandId, query.limit, actorFrom(request)); }
  @Get(":id") get(@Req() request: FastifyRequest, @Query() query: BatchWorkspaceQueryDto, @Param() params: BatchIdParamDto) { return this.batches.get(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)); }
  @Post("preview") preview(@Req() request: FastifyRequest, @Body() dto: PreviewBatchDto) { return this.batches.preview(workspaceFrom(request, dto.workspaceId), dto, actorFrom(request)); }
  @Post(":id/commit") @HttpCode(HttpStatus.ACCEPTED) commit(@Req() request: FastifyRequest, @Param() params: BatchIdParamDto, @Body() dto: BatchVersionDto) { return this.batches.commit(workspaceFrom(request, dto.workspaceId), params.id, dto.version, actorFrom(request)); }
  @Post(":id/approve") @HttpCode(HttpStatus.ACCEPTED) approve(@Req() request: FastifyRequest, @Param() params: BatchIdParamDto, @Body() dto: ApproveBatchDto) { return this.batches.approve(workspaceFrom(request, dto.workspaceId), params.id, dto, actorFrom(request)); }
  @Post(":id/archive") archive(@Req() request: FastifyRequest, @Param() params: BatchIdParamDto, @Body() dto: BatchVersionDto) { return this.batches.archive(workspaceFrom(request, dto.workspaceId), params.id, dto.version, actorFrom(request)); }
}

