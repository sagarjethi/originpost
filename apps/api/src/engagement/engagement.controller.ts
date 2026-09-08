import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import {
  CreateReplyDraftDto,
  EngagementActionParamDto,
  EngagementActionVersionDto,
  EngagementCommentParamDto,
  EngagementIdParamDto,
  EngagementListQueryDto,
  EngagementProofParamDto,
  ReconcileEngagementActionDto,
  EngagementScopeQueryDto,
  UpdateEngagementThreadDto,
} from "./dto/engagement.dto.js";
import { EngagementService } from "./engagement.service.js";

@Controller({ path: "engagement", version: "1" })
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get()
  list(@Req() request: FastifyRequest, @Query() query: EngagementListQueryDto) {
    return this.engagement.list(workspaceFrom(request, query.workspaceId), query, actorFrom(request));
  }

  @Get("threads/:threadId")
  get(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementIdParamDto) {
    return this.engagement.get(workspaceFrom(request, query.workspaceId), query.brandId, params.threadId, actorFrom(request));
  }

  @Patch("threads/:threadId")
  update(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementIdParamDto, @Body() body: UpdateEngagementThreadDto) {
    return this.engagement.updateThread(workspaceFrom(request, query.workspaceId), query.brandId, params.threadId, body, actorFrom(request));
  }

  @Post("threads/:threadId/read") @HttpCode(HttpStatus.OK)
  read(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementIdParamDto) {
    return this.engagement.markRead(workspaceFrom(request, query.workspaceId), query.brandId, params.threadId, actorFrom(request));
  }

  @Post("comments/:commentId/reply-drafts")
  draft(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementCommentParamDto, @Body() body: CreateReplyDraftDto) {
    return this.engagement.createReplyDraft(workspaceFrom(request, query.workspaceId), query.brandId, params.commentId, body, actorFrom(request));
  }

  @Post("actions/:actionId/approve") @HttpCode(HttpStatus.ACCEPTED)
  approve(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementActionParamDto, @Body() body: EngagementActionVersionDto) {
    return this.engagement.approve(workspaceFrom(request, query.workspaceId), query.brandId, params.actionId, body.version, actorFrom(request));
  }

  @Post("actions/:actionId/cancel") @HttpCode(HttpStatus.OK)
  cancel(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementActionParamDto, @Body() body: EngagementActionVersionDto) {
    return this.engagement.cancel(workspaceFrom(request, query.workspaceId), query.brandId, params.actionId, body.version, actorFrom(request));
  }

  @Post("actions/:actionId/reconcile") @HttpCode(HttpStatus.OK)
  reconcile(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementActionParamDto, @Body() body: ReconcileEngagementActionDto) {
    return this.engagement.reconcileAction(workspaceFrom(request, query.workspaceId), query.brandId, params.actionId, body, actorFrom(request));
  }

  @Post("proofs/:proofId/refresh") @HttpCode(HttpStatus.ACCEPTED)
  refresh(@Req() request: FastifyRequest, @Query() query: EngagementScopeQueryDto, @Param() params: EngagementProofParamDto) {
    return this.engagement.refreshProof(workspaceFrom(request, query.workspaceId), query.brandId, params.proofId, actorFrom(request));
  }
}
