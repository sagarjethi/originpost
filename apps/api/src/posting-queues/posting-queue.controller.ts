import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { PostingQueueService } from "./posting-queue.service.js";
import { PostingQueueDraftPreviewDto, PostingQueuePreviewQueryDto, PostingQueueProfileDto, PostingQueueQueryDto, QueueAccountParamDto, QueueContentParamDto, ScheduleNextDto } from "./posting-queue.dto.js";

function requiredIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new BadRequestException("Idempotency-Key must contain 8–200 letters, numbers, dots, dashes, underscores, or colons.");
  return key;
}

@Controller({ path: "posting-queue-profiles", version: "1" })
export class PostingQueueController {
  constructor(private readonly queues: PostingQueueService) {}
  @Get() list(@Req() request: FastifyRequest, @Query() query: PostingQueueQueryDto) { return this.queues.list(workspaceFrom(request, query.workspaceId), query.brandId); }
  @Put(":connectedAccountId") save(@Req() request: FastifyRequest, @Param() params: QueueAccountParamDto, @Body() dto: PostingQueueProfileDto) { return this.queues.save(workspaceFrom(request, dto.workspaceId), params.connectedAccountId, dto, actorFrom(request)); }
  @Get(":connectedAccountId/preview") preview(@Req() request: FastifyRequest, @Param() params: QueueAccountParamDto, @Query() query: PostingQueuePreviewQueryDto) { return this.queues.preview(workspaceFrom(request, query.workspaceId), query.brandId, params.connectedAccountId, query.count); }
  @Post(":connectedAccountId/preview") previewDraft(@Req() request: FastifyRequest, @Param() params: QueueAccountParamDto, @Body() dto: PostingQueueDraftPreviewDto) { return this.queues.previewDraft(workspaceFrom(request, dto.workspaceId), params.connectedAccountId, dto, actorFrom(request)); }
}

@Controller({ path: "content-items", version: "1" })
export class ScheduleNextController {
  constructor(private readonly queues: PostingQueueService) {}
  @Post(":contentItemId/schedule-next") schedule(@Req() request: FastifyRequest, @Param() params: QueueContentParamDto, @Headers("idempotency-key") key: string | undefined, @Body() dto: ScheduleNextDto) { return this.queues.scheduleNext(workspaceFrom(request, dto.workspaceId), params.contentItemId, dto, actorFrom(request), expectedVersionFrom(request), requiredIdempotencyKey(key)); }
}
