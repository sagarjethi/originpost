import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { AgentPostsService } from "./agent-posts.service.js";
import {
  AgentPostQueryDto,
  AgentPostTemplateDto,
  CreateAgentPostDto,
} from "./agent-posts.dto.js";
@Controller({ path: "agent-posts", version: "1" })
export class AgentPostsController {
  constructor(private readonly posts: AgentPostsService) {}
  @Get("capability") capability(
    @Req() r: FastifyRequest,
    @Query() q: AgentPostQueryDto,
  ) {
    return this.posts.capability(
      workspaceFrom(r, q.workspaceId),
      q.brandId,
      actorFrom(r),
    );
  }
  @Get("templates") templates(
    @Req() r: FastifyRequest,
    @Query() q: AgentPostQueryDto,
  ) {
    return this.posts.templates(
      workspaceFrom(r, q.workspaceId),
      q.brandId,
      actorFrom(r),
    );
  }
  @Post("templates") template(
    @Req() r: FastifyRequest,
    @Body() d: AgentPostTemplateDto,
  ) {
    return this.posts.saveTemplate(
      workspaceFrom(r, d.workspaceId),
      d,
      actorFrom(r),
    );
  }
  @Get() list(@Req() r: FastifyRequest, @Query() q: AgentPostQueryDto) {
    return this.posts.list(
      workspaceFrom(r, q.workspaceId),
      q.brandId,
      actorFrom(r),
    );
  }
  @Get(":id") get(
    @Req() r: FastifyRequest,
    @Query() q: AgentPostQueryDto,
    @Param("id") id: string,
  ) {
    return this.posts.detail(
      workspaceFrom(r, q.workspaceId),
      q.brandId,
      id,
      actorFrom(r),
    );
  }
  @Post() start(
    @Req() r: FastifyRequest,
    @Body() d: CreateAgentPostDto,
    @Headers("idempotency-key") key: string | undefined,
  ) {
    return this.posts.start(
      workspaceFrom(r, d.workspaceId),
      d,
      key,
      actorFrom(r),
    );
  }
}
