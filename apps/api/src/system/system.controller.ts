import { Controller, Get, Param, Post, Query, Req, VERSION_NEUTRAL, Version } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { Public } from "../common/public.decorator.js";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { OperationIdParamDto, OutboxQueryDto } from "./system.dto.js";
import { SystemService } from "./system.service.js";

@Controller()
export class SystemController {
  constructor(private readonly system: SystemService) {}
  @Public()
  @Get("health")
  @Version(VERSION_NEUTRAL)
  health() { return this.system.health() }
  @Get("connectors")
  @Version("1")
  connectors() { return this.system.connectors() }
  @Get("agents/status")
  @Version("1")
  agents() { return this.system.agents() }
  @Get("plugins/catalog")
  @Version("1")
  plugins() { return this.system.plugins() }
  @Get("operations/health")
  @Version("1")
  operations(@Req() request: FastifyRequest, @Query("workspaceId") workspaceId?: string) { return this.system.operations(workspaceFrom(request, workspaceId?.trim() || "default"), actorFrom(request)) }
  @Get("operations/outbox")
  @Version("1")
  outbox(@Query("workspaceId") workspaceId?: string) { return this.system.outboxStats(workspaceId?.trim() || "default") }

  @Get("operations/outbox/messages")
  @Version("1")
  messages(@Query() query: OutboxQueryDto) { return this.system.outboxMessages(query) }

  @Post("operations/outbox/:id/retry")
  @Version("1")
  retry(@Req() request: FastifyRequest, @Param() params: OperationIdParamDto, @Query("workspaceId") workspaceId?: string) { return this.system.retryOutbox(workspaceId?.trim() || "default", params.id, actorFrom(request)) }
}
