import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { ApproveRemoteCorrectionDto, CreateRemoteCorrectionDto, ManualAttestationDto, RemoteCorrectionCapabilityDto, RemoteCorrectionOperationParamDto, RemoteCorrectionParamDto, RemoteCorrectionQueryDto, RemoteCorrectionScopeDto } from "./remote-correction.dto.js";
import { RemoteCorrectionService } from "./remote-correction.service.js";

@Controller({ path:"content-items/:contentItemId/remote-corrections", version:"1" })
export class RemoteCorrectionController {
  constructor(private readonly service: RemoteCorrectionService) {}
  @Get("capabilities") capabilities(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionParamDto,@Query() q:RemoteCorrectionCapabilityDto){return this.service.capabilities(workspaceFrom(req,q.workspaceId),p.contentItemId,q.publishProofId,actorFrom(req));}
  @Post() create(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionParamDto,@Body() b:CreateRemoteCorrectionDto){return this.service.create(workspaceFrom(req,b.workspaceId),p.contentItemId,b,actorFrom(req));}
  @Get() list(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionParamDto,@Query() q:RemoteCorrectionQueryDto){return this.service.list(workspaceFrom(req,q.workspaceId),p.contentItemId,q.publishProofId,actorFrom(req));}
  @Get(":operationId") get(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionOperationParamDto,@Query() q:RemoteCorrectionScopeDto){return this.service.get(workspaceFrom(req,q.workspaceId),p.contentItemId,p.operationId,actorFrom(req));}
  @Post(":operationId/approve") @HttpCode(HttpStatus.ACCEPTED) approve(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionOperationParamDto,@Body() b:ApproveRemoteCorrectionDto){return this.service.approve(workspaceFrom(req,b.workspaceId),p.contentItemId,p.operationId,b,actorFrom(req));}
  @Post(":operationId/reconcile") @HttpCode(HttpStatus.ACCEPTED) reconcile(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionOperationParamDto,@Body() b:RemoteCorrectionScopeDto){return this.service.reconcile(workspaceFrom(req,b.workspaceId),p.contentItemId,p.operationId,actorFrom(req));}
  @Post(":operationId/manual-attestation") @HttpCode(HttpStatus.OK) attest(@Req() req:FastifyRequest,@Param() p:RemoteCorrectionOperationParamDto,@Body() b:ManualAttestationDto){return this.service.attest(workspaceFrom(req,b.workspaceId),p.contentItemId,p.operationId,b,actorFrom(req));}
}
