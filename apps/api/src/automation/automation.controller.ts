import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards, VERSION_NEUTRAL } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { Public } from "../common/public.decorator.js";
import { IdParamDto, TargetParamDto } from "../content/dto/content.dto.js";
import { AutomationIdParamDto, AutomationWorkspaceQueryDto, CreateAutomationKeyDto, CreateAutomationSubscriptionDto, PublicContentQueryDto, PublicCreateContentDto, PublicDraftDto, PublicImportPreviewDto, PublicRescheduleDto, PublicScheduleDto } from "./automation.dto.js";
import { automationKeyFrom, AutomationKeyGuard, type AutomationAuthenticatedRequest } from "./automation-key.guard.js";
import { AutomationService } from "./automation.service.js";

function idempotencyKey(value: string | undefined) {
  const key = value?.trim() ?? "";
  if (key.length < 8 || key.length > 200) throw new BadRequestException("Idempotency-Key must contain 8–200 characters.");
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new BadRequestException("Idempotency-Key may use letters, numbers, dot, dash, underscore, and colon only.");
  return key;
}

function requiredVersion(request: FastifyRequest) {
  const version = expectedVersionFrom(request);
  if (version === undefined) throw new BadRequestException("Send If-Match with the current content version.");
  return version;
}

@Controller({ path: "automation", version: "1" })
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}
  @Get("keys") keys(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto) { return this.automation.listKeys(workspaceFrom(request, query.workspaceId), actorFrom(request)) }
  @Post("keys") createKey(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto, @Body() dto: CreateAutomationKeyDto) { return this.automation.createKey(workspaceFrom(request, query.workspaceId), dto, actorFrom(request)) }
  @Post("keys/:id/revoke") revokeKey(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto, @Param() params: AutomationIdParamDto) { return this.automation.revokeKey(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
  @Get("subscriptions") subscriptions(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto) { return this.automation.listSubscriptions(workspaceFrom(request, query.workspaceId), actorFrom(request)) }
  @Post("subscriptions") createSubscription(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto, @Body() dto: CreateAutomationSubscriptionDto) { return this.automation.createSubscription(workspaceFrom(request, query.workspaceId), dto, actorFrom(request)) }
  @Post("subscriptions/:id/disable") disableSubscription(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto, @Param() params: AutomationIdParamDto) { return this.automation.disableSubscription(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
  @Post("subscriptions/:id/test") @HttpCode(HttpStatus.ACCEPTED) testSubscription(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto, @Param() params: AutomationIdParamDto) { return this.automation.sendTestEvent(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
  @Get("events") events(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto) { return this.automation.listEvents(workspaceFrom(request, query.workspaceId), actorFrom(request), query.limit) }
  @Get("deliveries") deliveries(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto) { return this.automation.listDeliveries(workspaceFrom(request, query.workspaceId), actorFrom(request), query.limit) }
  @Post("deliveries/:id/retry") retry(@Req() request: FastifyRequest, @Query() query: AutomationWorkspaceQueryDto, @Param() params: AutomationIdParamDto) { return this.automation.retryDelivery(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
}

@Public()
@UseGuards(AutomationKeyGuard)
@Controller({ path: "public/v1", version: VERSION_NEUTRAL })
export class PublicAutomationController {
  constructor(private readonly automation: AutomationService) {}
  @Get("content-items") list(@Req() request: AutomationAuthenticatedRequest, @Query() query: PublicContentQueryDto) { return this.automation.publicList(automationKeyFrom(request), query.brandId) }
  @Get("content-items/:id") get(@Req() request: AutomationAuthenticatedRequest, @Param() params: IdParamDto) { return this.automation.publicGet(automationKeyFrom(request), params.id) }
  @Post("content-items") create(@Req() request: AutomationAuthenticatedRequest, @Headers("idempotency-key") key: string | undefined, @Body() dto: PublicCreateContentDto) { return this.automation.publicCreate(automationKeyFrom(request), dto, idempotencyKey(key)) }
  @Post("content-items/:id/drafts") draft(@Req() request: AutomationAuthenticatedRequest, @Param() params: IdParamDto, @Body() dto: PublicDraftDto) { return this.automation.publicDraft(automationKeyFrom(request), params.id, dto, requiredVersion(request)) }
  @Post("content-items/:id/submit") submit(@Req() request: AutomationAuthenticatedRequest, @Param() params: IdParamDto) { return this.automation.publicSubmit(automationKeyFrom(request), params.id, requiredVersion(request)) }
  @Post("content-items/:id/schedule") schedule(@Req() request: AutomationAuthenticatedRequest, @Headers("idempotency-key") key: string | undefined, @Param() params: IdParamDto, @Body() dto: PublicScheduleDto) { return this.automation.publicSchedule(automationKeyFrom(request), params.id, dto, idempotencyKey(key), requiredVersion(request)) }
  @Patch("content-items/:id/targets/:targetId/reschedule") reschedule(@Req() request: AutomationAuthenticatedRequest, @Param() params: TargetParamDto, @Body() dto: PublicRescheduleDto) { return this.automation.publicReschedule(automationKeyFrom(request), params.id, params.targetId, dto, requiredVersion(request)) }
  @Post("content-items/:id/targets/:targetId/cancel") cancel(@Req() request: AutomationAuthenticatedRequest, @Param() params: TargetParamDto) { return this.automation.publicCancel(automationKeyFrom(request), params.id, params.targetId, requiredVersion(request)) }
  @Get("content-items/:id/proofs") proofs(@Req() request: AutomationAuthenticatedRequest, @Param() params: IdParamDto) { return this.automation.publicProofs(automationKeyFrom(request), params.id) }
  @Post("imports/preview") previewImport(@Req() request: AutomationAuthenticatedRequest, @Body() dto: PublicImportPreviewDto) { return this.automation.previewImport(automationKeyFrom(request), dto) }
  @Get("imports/:id") getImport(@Req() request: AutomationAuthenticatedRequest, @Param() params: AutomationIdParamDto) { return this.automation.getImport(automationKeyFrom(request), params.id) }
  @Post("imports/:id/commit") commitImport(@Req() request: AutomationAuthenticatedRequest, @Param() params: AutomationIdParamDto) { return this.automation.commitImport(automationKeyFrom(request), params.id) }
}
