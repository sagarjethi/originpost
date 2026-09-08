import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { AgentRuntimeService } from "./agent-runtime.service.js";
import { AgentRuntimeQueryDto, AssignAgentRuntimeDto, CreateAgentRuntimeDto, UpdateAgentRuntimeDto } from "./dto/agent-runtime.dto.js";

@Controller({path:"agent-runtimes",version:"1"})
export class AgentRuntimeController{
  constructor(private readonly runtimes:AgentRuntimeService){}
  @Get()list(@Req()request:FastifyRequest,@Query()query:AgentRuntimeQueryDto){return this.runtimes.list(workspaceFrom(request,query.workspaceId),query,actorFrom(request));}
  @Post()create(@Req()request:FastifyRequest,@Body()dto:CreateAgentRuntimeDto){return this.runtimes.create(workspaceFrom(request,dto.workspaceId),dto,actorFrom(request));}
  @Patch(":id")update(@Req()request:FastifyRequest,@Query()query:AgentRuntimeQueryDto,@Param("id")id:string,@Body()dto:UpdateAgentRuntimeDto){return this.runtimes.update(workspaceFrom(request,query.workspaceId),id,expectedVersionFrom(request),dto,actorFrom(request));}
  @Delete(":id")remove(@Req()request:FastifyRequest,@Query()query:AgentRuntimeQueryDto,@Param("id")id:string){return this.runtimes.remove(workspaceFrom(request,query.workspaceId),id,expectedVersionFrom(request),actorFrom(request));}
  @Post(":id/test")test(@Req()request:FastifyRequest,@Query()query:AgentRuntimeQueryDto,@Param("id")id:string){return this.runtimes.test(workspaceFrom(request,query.workspaceId),id,actorFrom(request));}
  @Post(":id/assign")assign(@Req()request:FastifyRequest,@Param("id")id:string,@Body()dto:AssignAgentRuntimeDto){return this.runtimes.assign(workspaceFrom(request,dto.workspaceId),id,dto,actorFrom(request));}
  @Delete("assignments/:brandId")unassign(@Req()request:FastifyRequest,@Query()query:AgentRuntimeQueryDto,@Param("brandId")brandId:string){return this.runtimes.unassign(workspaceFrom(request,query.workspaceId),brandId,actorFrom(request));}
  @Get(":id/runs")runs(@Req()request:FastifyRequest,@Query()query:AgentRuntimeQueryDto,@Param("id")id:string){return this.runtimes.runs(workspaceFrom(request,query.workspaceId),id,query.limit,actorFrom(request));}
}
