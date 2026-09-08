import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import {
  CreatePrivateReplyDraftDto,
  PrivateConversationDemoAccountParamDto,
  PrivateConversationListQueryDto,
  PrivateConversationParamDto,
  PrivateConversationScopeQueryDto,
  PrivateMessageParamDto,
  PrivateReplyIntentParamDto,
  PrivateReplyIntentVersionDto,
  ProvisionPrivateConversationDemoDto,
  ReconcilePrivateReplyIntentDto,
  RevisePrivateReplyDraftDto,
  UpdatePrivateConversationDto,
} from "./dto/private-conversations.dto.js";
import { PrivateConversationsService } from "./private-conversations.service.js";

@Controller({ path: "private-conversations", version: "1" })
export class PrivateConversationsController {
  constructor(private readonly privateConversations: PrivateConversationsService) {}

  @Get()
  list(@Req() request: FastifyRequest, @Query() query: PrivateConversationListQueryDto) {
    return this.privateConversations.list(workspaceFrom(request, query.workspaceId), query, actorFrom(request));
  }

  @Get("readiness")
  readiness(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto) {
    return this.privateConversations.readiness(workspaceFrom(request, query.workspaceId), query.brandId, actorFrom(request));
  }

  @Post("demo/accounts/:accountId/provision") @HttpCode(HttpStatus.ACCEPTED)
  provisionDemo(
    @Req() request: FastifyRequest,
    @Query() query: PrivateConversationScopeQueryDto,
    @Param() params: PrivateConversationDemoAccountParamDto,
    @Body() body: ProvisionPrivateConversationDemoDto,
  ) {
    return this.privateConversations.provisionDemoAccount(
      workspaceFrom(request, query.workspaceId),
      query.brandId,
      params.accountId,
      body.expectedAccountUpdatedAt,
      actorFrom(request),
    );
  }

  @Get(":conversationId")
  get(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateConversationParamDto) {
    return this.privateConversations.get(workspaceFrom(request, query.workspaceId), query.brandId, params.conversationId, actorFrom(request));
  }

  @Patch(":conversationId")
  update(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateConversationParamDto, @Body() body: UpdatePrivateConversationDto) {
    return this.privateConversations.update(workspaceFrom(request, query.workspaceId), query.brandId, params.conversationId, body, actorFrom(request));
  }

  @Post(":conversationId/read") @HttpCode(HttpStatus.OK)
  read(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateConversationParamDto) {
    return this.privateConversations.markRead(workspaceFrom(request, query.workspaceId), query.brandId, params.conversationId, actorFrom(request));
  }

  @Post(":conversationId/refresh") @HttpCode(HttpStatus.ACCEPTED)
  refresh(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateConversationParamDto) {
    return this.privateConversations.refreshConversation(workspaceFrom(request, query.workspaceId), query.brandId, params.conversationId, actorFrom(request));
  }

  @Post("messages/:messageId/reply-intents")
  draft(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateMessageParamDto, @Body() body: CreatePrivateReplyDraftDto) {
    return this.privateConversations.createReplyDraft(workspaceFrom(request, query.workspaceId), query.brandId, params.messageId, body, actorFrom(request));
  }

  @Patch("reply-intents/:intentId")
  revise(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateReplyIntentParamDto, @Body() body: RevisePrivateReplyDraftDto) {
    return this.privateConversations.reviseReplyDraft(workspaceFrom(request, query.workspaceId), query.brandId, params.intentId, body, actorFrom(request));
  }

  @Post("reply-intents/:intentId/submit") @HttpCode(HttpStatus.OK)
  submit(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateReplyIntentParamDto, @Body() body: PrivateReplyIntentVersionDto) {
    return this.privateConversations.submitReplyDraft(workspaceFrom(request, query.workspaceId), query.brandId, params.intentId, body.version, actorFrom(request));
  }

  @Post("reply-intents/:intentId/approve") @HttpCode(HttpStatus.ACCEPTED)
  approve(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateReplyIntentParamDto, @Body() body: PrivateReplyIntentVersionDto) {
    return this.privateConversations.approve(workspaceFrom(request, query.workspaceId), query.brandId, params.intentId, body.version, actorFrom(request));
  }

  @Post("reply-intents/:intentId/cancel") @HttpCode(HttpStatus.OK)
  cancel(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateReplyIntentParamDto, @Body() body: PrivateReplyIntentVersionDto) {
    return this.privateConversations.cancel(workspaceFrom(request, query.workspaceId), query.brandId, params.intentId, body.version, actorFrom(request));
  }

  @Post("reply-intents/:intentId/reconcile") @HttpCode(HttpStatus.OK)
  reconcile(@Req() request: FastifyRequest, @Query() query: PrivateConversationScopeQueryDto, @Param() params: PrivateReplyIntentParamDto, @Body() body: ReconcilePrivateReplyIntentDto) {
    return this.privateConversations.reconcile(workspaceFrom(request, query.workspaceId), query.brandId, params.intentId, body, actorFrom(request));
  }

}
