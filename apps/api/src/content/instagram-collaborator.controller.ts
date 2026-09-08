import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { ApproveInstagramCollaboratorCandidateDto, CreateInstagramCollaboratorCandidateDto, InstagramCollaboratorCandidateParamDto, InstagramCollaboratorCapabilityQueryDto, InstagramCollaboratorProofParamDto } from "./dto/instagram-collaborator.dto.js";
import { InstagramCollaboratorService } from "./instagram-collaborator.service.js";

@Controller({path:"content-items/:id/instagram-collaborators",version:"1"})
export class InstagramCollaboratorController {
  constructor(private readonly service:InstagramCollaboratorService){}
  @Get("capability") capability(@Req() req:FastifyRequest,@Param("id") id:string,@Query() query:InstagramCollaboratorCapabilityQueryDto){return this.service.capability(workspaceFrom(req,query.workspaceId),id,query.draftId,query.accountId);}
  @Post("candidates") create(@Req() req:FastifyRequest,@Param("id") id:string,@Query("workspaceId") workspaceId:string|undefined,@Body() dto:CreateInstagramCollaboratorCandidateDto){return this.service.createCandidate(workspaceFrom(req,workspaceId),id,dto,actorFrom(req));}
  @Post("candidates/:candidateId/approve") approve(@Req() req:FastifyRequest,@Param() params:InstagramCollaboratorCandidateParamDto,@Query("workspaceId") workspaceId:string|undefined,@Body() dto:ApproveInstagramCollaboratorCandidateDto){return this.service.approve(workspaceFrom(req,workspaceId),params.id,params.candidateId,dto.note,actorFrom(req));}
  @Get("approvals") list(@Req() req:FastifyRequest,@Param("id") id:string,@Query("workspaceId") workspaceId:string|undefined){return this.service.list(workspaceFrom(req,workspaceId),id);}
  @Get("proofs/:proofId/status") status(@Req() req:FastifyRequest,@Param() params:InstagramCollaboratorProofParamDto,@Query("workspaceId") workspaceId:string|undefined){return this.service.status(workspaceFrom(req,workspaceId),params.id,params.proofId);}
}
