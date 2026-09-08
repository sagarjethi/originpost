import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, expectedVersionFrom, workspaceFrom } from "../common/request-context.js";
import { CreateEvergreenPolicyDto, EvergreenQueryDto } from "./dto/evergreen.dto.js";
import { EvergreenService } from "./evergreen.service.js";

@Controller({path:"evergreen",version:"1"})
export class EvergreenController{
  constructor(private readonly evergreen:EvergreenService){}
  @Get("summary")summary(@Req()request:FastifyRequest,@Query()query:EvergreenQueryDto){return this.evergreen.summary(workspaceFrom(request,query.workspaceId),query.brandId,actorFrom(request));}
  @Get("candidates")candidates(@Req()request:FastifyRequest,@Query()query:EvergreenQueryDto){return this.evergreen.candidates(workspaceFrom(request,query.workspaceId),query.brandId,actorFrom(request));}
  @Get()list(@Req()request:FastifyRequest,@Query()query:EvergreenQueryDto){return this.evergreen.list(workspaceFrom(request,query.workspaceId),query,actorFrom(request));}
  @Post()create(@Req()request:FastifyRequest,@Body()dto:CreateEvergreenPolicyDto){return this.evergreen.create(workspaceFrom(request,dto.workspaceId),dto,actorFrom(request));}
  @Get(":id")get(@Req()request:FastifyRequest,@Query()query:EvergreenQueryDto,@Param("id")id:string){return this.evergreen.get(workspaceFrom(request,query.workspaceId),id,actorFrom(request));}
  @Post(":id/pause")pause(@Req()request:FastifyRequest,@Query()query:EvergreenQueryDto,@Param("id")id:string){return this.evergreen.state(workspaceFrom(request,query.workspaceId),id,expectedVersionFrom(request),"pause",actorFrom(request));}
  @Post(":id/resume")resume(@Req()request:FastifyRequest,@Query()query:EvergreenQueryDto,@Param("id")id:string){return this.evergreen.state(workspaceFrom(request,query.workspaceId),id,expectedVersionFrom(request),"resume",actorFrom(request));}
}
