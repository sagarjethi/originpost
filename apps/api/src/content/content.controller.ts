import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { ContentService } from "./content.service.js";
import { AddDraftDto, AddSourceDto, AgentDraftDto, ApprovalDto, CreateContentDto, CreateReviewLinkDto, IdParamDto, ManualPublishConfirmationDto, ResearchDto, RescheduleTargetDto, ReviewCommentDto, ReviewLinkParamDto, ScheduleDto, ScheduleExportQueryDto, SchedulePreflightDto, TargetParamDto, TransitionDto, WorkspaceQueryDto } from "./dto/content.dto.js";

@Controller({ path: "content-items", version: "1" })
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get() list(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto) { return this.content.list(workspaceFrom(request, query.workspaceId), query.brandId) }
  @Get("schedule/export.csv")
  async exportSchedule(@Req() request: FastifyRequest, @Query() query: ScheduleExportQueryDto, @Res() reply: FastifyReply) {
    const result = await this.content.exportSchedule(workspaceFrom(request, query.workspaceId), query, actorFrom(request));
    return reply
      .header("cache-control", "private, no-store")
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${result.fileName}"`)
      .header("x-content-type-options", "nosniff")
      .send(result.csv);
  }
  @Get(":id") get(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.content.get(workspaceFrom(request, query.workspaceId), params.id) }
  @Get(":id/audit") audit(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.content.audit(workspaceFrom(request, query.workspaceId), params.id) }
  @Post() create(@Req() request: FastifyRequest, @Body() dto: CreateContentDto) { return this.content.create(dto, actorFrom(request)) }
  @Post(":id/sources") source(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: AddSourceDto) { return this.content.addSource(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/research") @HttpCode(HttpStatus.ACCEPTED) research(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: ResearchDto) { return this.content.startResearch(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/drafts") draft(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: AddDraftDto) { return this.content.addDraft(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/agent-draft") agentDraft(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: AgentDraftDto) { return this.content.agentDraft(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/transitions") transition(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: TransitionDto) { return this.content.transition(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/approvals") approve(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: ApprovalDto) { return this.content.approve(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/review-comments") comment(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: ReviewCommentDto) { return this.content.comment(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/review-links") reviewLink(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: CreateReviewLinkDto) { return this.content.createReviewLink(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/review-links/:linkId/revoke") revokeReviewLink(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: ReviewLinkParamDto) { return this.content.revokeReviewLink(workspaceFrom(request, query.workspaceId), params.id, params.linkId, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/schedule-preflight") preflightSchedule(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: SchedulePreflightDto) { return this.content.schedulePreflight(workspaceFrom(request, query.workspaceId), params.id, dto, expectedVersionFrom(request)) }
  @Post(":id/schedule") schedule(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: ScheduleDto) { return this.content.schedule(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Patch(":id/targets/:targetId/reschedule") reschedule(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: TargetParamDto, @Body() dto: RescheduleTargetDto) { return this.content.reschedule(workspaceFrom(request, query.workspaceId), params.id, params.targetId, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/targets/:targetId/cancel") cancel(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: TargetParamDto) { return this.content.cancel(workspaceFrom(request, query.workspaceId), params.id, params.targetId, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/targets/:targetId/acknowledge") acknowledge(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: TargetParamDto) { return this.content.acknowledgeHandoff(workspaceFrom(request, query.workspaceId), params.id, params.targetId, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/targets/:targetId/manual-confirm") confirmManual(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: TargetParamDto, @Body() dto: ManualPublishConfirmationDto) { return this.content.confirmManual(workspaceFrom(request, query.workspaceId), params.id, params.targetId, dto, actorFrom(request), expectedVersionFrom(request)) }
  @Post(":id/targets/:targetId/provider-confirm") confirmProvider(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: TargetParamDto, @Body() dto: ManualPublishConfirmationDto) { return this.content.confirmProvider(workspaceFrom(request, query.workspaceId), params.id, params.targetId, dto, actorFrom(request), expectedVersionFrom(request)) }
}
