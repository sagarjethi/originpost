import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { ApproveFirstCommentDto, AttestFirstCommentDto, CreateFirstCommentDto, FirstCommentCapabilityDto, FirstCommentIntentParamDto, FirstCommentParamDto, FirstCommentScopeDto, FirstCommentVersionDto, ReconcileFirstCommentDto, ReviseFirstCommentDto } from "./first-comment.dto.js";
import { FirstCommentService } from "./first-comment.service.js";

@Controller({path:"content-items/:contentItemId/first-comments",version:"1"})
export class FirstCommentController {
  constructor(private readonly service:FirstCommentService){}
  @Get("capability") capability(@Req() req:FastifyRequest,@Param() p:FirstCommentParamDto,@Query() q:FirstCommentCapabilityDto){return this.service.capability(workspaceFrom(req,q.workspaceId),p.contentItemId,q.targetId,actorFrom(req));}
  @Get() list(@Req() req:FastifyRequest,@Param() p:FirstCommentParamDto,@Query() q:FirstCommentScopeDto){return this.service.list(workspaceFrom(req,q.workspaceId),p.contentItemId,actorFrom(req));}
  @Post() create(@Req() req:FastifyRequest,@Param() p:FirstCommentParamDto,@Body() b:CreateFirstCommentDto){return this.service.create(workspaceFrom(req,b.workspaceId),p.contentItemId,b,actorFrom(req));}
  @Get(":intentId") get(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Query() q:FirstCommentScopeDto){return this.service.get(workspaceFrom(req,q.workspaceId),p.contentItemId,p.intentId,actorFrom(req));}
  @Patch(":intentId") revise(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Body() b:ReviseFirstCommentDto){return this.service.revise(workspaceFrom(req,b.workspaceId),p.contentItemId,p.intentId,b,actorFrom(req));}
  @Post(":intentId/submit") submit(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Body() b:FirstCommentVersionDto){return this.service.submit(workspaceFrom(req,b.workspaceId),p.contentItemId,p.intentId,b,actorFrom(req));}
  @Post(":intentId/approve") @HttpCode(HttpStatus.ACCEPTED) approve(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Body() b:ApproveFirstCommentDto){return this.service.approve(workspaceFrom(req,b.workspaceId),p.contentItemId,p.intentId,b,actorFrom(req));}
  @Post(":intentId/cancel") cancel(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Body() b:FirstCommentVersionDto){return this.service.cancel(workspaceFrom(req,b.workspaceId),p.contentItemId,p.intentId,b,actorFrom(req));}
  @Post(":intentId/reconcile") @HttpCode(HttpStatus.ACCEPTED) reconcile(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Body() b:ReconcileFirstCommentDto){return this.service.reconcile(workspaceFrom(req,b.workspaceId),p.contentItemId,p.intentId,b,actorFrom(req));}
  @Post(":intentId/manual-attestation") attest(@Req() req:FastifyRequest,@Param() p:FirstCommentIntentParamDto,@Body() b:AttestFirstCommentDto){return this.service.attest(workspaceFrom(req,b.workspaceId),p.contentItemId,p.intentId,b,actorFrom(req));}
}
