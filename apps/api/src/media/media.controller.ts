import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseFilters } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { Public } from "../common/public.decorator.js";
import { CompleteMediaUploadDto, CreateMediaUploadDto, MediaIdParamDto, MediaMutationDto, MediaQueryDto } from "./media.dto.js";
import { MediaRangeNotSatisfiableFilter } from "./media-range.filter.js";
import { MediaService } from "./media.service.js";

@Controller({ path: "media-assets", version: "1" })
export class MediaController {
  constructor(private readonly media: MediaService) {}
  private async sendDelivery(token: string, range: string | undefined, reply: FastifyReply) {
    const result = await this.media.deliver(token, range);
    const safeName = result.fileName.replace(/["\r\n]/g, "_");
    reply.status(result.statusCode).header("cache-control", "private, no-store").header("accept-ranges", "bytes").header("content-type", result.contentType).header("content-length", String(result.contentLength)).header("content-disposition", `inline; filename="${safeName}"`);
    if (result.range) reply.header("content-range", `bytes ${result.range.start}-${result.range.end}/${result.totalLength}`);
    return reply.send(result.body);
  }
  @Get() list(@Req() request: FastifyRequest, @Query() query: MediaQueryDto) { return this.media.list(workspaceFrom(request, query.workspaceId), query.limit, actorFrom(request), query.brandId) }
  @Get("summary") summary(@Req() request: FastifyRequest, @Query() query: MediaQueryDto) { return this.media.summary(workspaceFrom(request, query.workspaceId), actorFrom(request), query.brandId) }
  @Post("cleanup") cleanup(@Req() request: FastifyRequest, @Body() dto: CompleteMediaUploadDto) { return this.media.cleanup(workspaceFrom(request, dto.workspaceId), actorFrom(request)) }
  @Post("uploads") create(@Req() request: FastifyRequest, @Body() dto: CreateMediaUploadDto) { return this.media.createUpload({ ...dto, workspaceId: workspaceFrom(request, dto.workspaceId) }, actorFrom(request)) }
  @Post(":id/complete") @HttpCode(HttpStatus.OK) complete(@Req() request: FastifyRequest, @Param() params: MediaIdParamDto, @Body() dto: CompleteMediaUploadDto) { return this.media.complete(workspaceFrom(request, dto.workspaceId), params.id, actorFrom(request)) }
  @Post(":id/trash") @HttpCode(HttpStatus.OK) trash(@Req() request: FastifyRequest, @Param() params: MediaIdParamDto, @Body() dto: MediaMutationDto) { return this.media.trash(workspaceFrom(request, dto.workspaceId), params.id, dto.version, actorFrom(request)) }
  @Post(":id/restore") @HttpCode(HttpStatus.OK) restore(@Req() request: FastifyRequest, @Param() params: MediaIdParamDto, @Body() dto: MediaMutationDto) { return this.media.restore(workspaceFrom(request, dto.workspaceId), params.id, dto.version, actorFrom(request)) }
  @Public() @Get("delivery/:token") @UseFilters(MediaRangeNotSatisfiableFilter) async deliver(@Param("token") token: string, @Headers("range") range: string | undefined, @Res() reply: FastifyReply) {
    return this.sendDelivery(token, range, reply);
  }
  @Public() @Get("preview") @UseFilters(MediaRangeNotSatisfiableFilter) async preview(@Query("token") token: string, @Headers("range") range: string | undefined, @Res() reply: FastifyReply) { return this.sendDelivery(token, range, reply) }
  @Get(":id/download-url") download(@Req() request: FastifyRequest, @Param() params: MediaIdParamDto, @Query() query: MediaQueryDto) { return this.media.download(workspaceFrom(request, query.workspaceId), params.id, actorFrom(request)) }
}
