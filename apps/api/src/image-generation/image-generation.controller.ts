import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { CreateImageGenerationDto, ImageGenerationQueryDto } from "./image-generation.dto.js";
import { ImageGenerationService } from "./image-generation.service.js";

@Controller({ path: "image-generations", version: "1" })
export class ImageGenerationController {
  constructor(private readonly generations: ImageGenerationService) {}
  @Get("capability") capability(@Req() request: FastifyRequest, @Query() query: ImageGenerationQueryDto) { return this.generations.capability(workspaceFrom(request, query.workspaceId), actorFrom(request)); }
  @Get() list(@Req() request: FastifyRequest, @Query() query: ImageGenerationQueryDto) { return this.generations.list(workspaceFrom(request, query.workspaceId), query.brandId, query.limit, actorFrom(request)); }
  @Get(":id") detail(@Req() request: FastifyRequest, @Query() query: ImageGenerationQueryDto, @Param("id") id: string) { return this.generations.detail(workspaceFrom(request, query.workspaceId), id, actorFrom(request)); }
  @Post() create(@Req() request: FastifyRequest, @Headers("idempotency-key") idempotencyKey: string | undefined, @Body() dto: CreateImageGenerationDto) { return this.generations.create(workspaceFrom(request, dto.workspaceId), dto, idempotencyKey, actorFrom(request)); }
}
