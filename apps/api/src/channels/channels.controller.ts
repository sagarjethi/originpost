import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { IdParamDto, WorkspaceQueryDto } from "../content/dto/content.dto.js";
import { ChannelsService } from "./channels.service.js";
import { ChannelOAuthService } from "./channel-oauth.service.js";
import { CreateConnectedAccountDto, UpdateConnectedAccountDto } from "./dto/channel.dto.js";

@Controller({ path: "channels/accounts", version: "1" })
export class ChannelsController {
  constructor(private readonly channels: ChannelsService, private readonly oauth: ChannelOAuthService) {}
  @Get() list(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto) { return this.channels.list(workspaceFrom(request, query.workspaceId), actorFrom(request), query.brandId) }
  @Post() create(@Req() request: FastifyRequest, @Body() dto: CreateConnectedAccountDto) { return this.channels.create({ ...dto, workspaceId: workspaceFrom(request, dto.workspaceId) }, actorFrom(request)) }
  @Patch(":id") update(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto, @Body() dto: UpdateConnectedAccountDto) { return this.channels.update(workspaceFrom(request, query.workspaceId), params.id, dto, actorFrom(request)) }
  @Post(":id/check") check(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.channels.check(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
  @Post(":id/refresh") refresh(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.oauth.refreshConnectedAccount(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
  @Post(":id/disconnect") disconnect(@Req() request: FastifyRequest, @Query() query: WorkspaceQueryDto, @Param() params: IdParamDto) { return this.channels.disconnect(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
}
