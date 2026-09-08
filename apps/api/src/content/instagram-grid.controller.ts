import { Controller, Get, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { InstagramGridQueryDto } from "./instagram-grid.dto.js";
import { InstagramGridService } from "./instagram-grid.service.js";

@Controller({ path: "instagram-grid", version: "1" })
export class InstagramGridController {
  constructor(private readonly grid: InstagramGridService) {}
  @Get() view(@Req() request: FastifyRequest, @Query() query: InstagramGridQueryDto) {
    return this.grid.view(workspaceFrom(request, query.workspaceId), query, actorFrom(request));
  }
}
