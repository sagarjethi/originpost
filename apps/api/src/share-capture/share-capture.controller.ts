import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import type { AuthenticatedRequest } from "../common/auth-context.guard.js";
import { AllowShareTargetPost } from "../common/share-target.decorator.js";
import { WorkspaceOptional } from "../common/workspace-optional.decorator.js";
import { ConvertShareCaptureDto, MaterializeShareCaptureDto, ShareTargetInputDto } from "./share-capture.dto.js";
import { parseShareTargetMultipart } from "./share-capture.multipart.js";
import { ShareCaptureService, shareCaptureCookie, shareCaptureTokenFromCookie } from "./share-capture.service.js";

@Controller({ path: "share-captures", version: "1" })
export class ShareCaptureController {
  constructor(private readonly captures: ShareCaptureService) {}

  @WorkspaceOptional() @AllowShareTargetPost() @Post("intake") @HttpCode(303)
  async intake(@Req() request: AuthenticatedRequest, @Body() dto: ShareTargetInputDto | undefined, @Res() reply: FastifyReply) {
    if (request.isMultipart()) {
      const parsed = await parseShareTargetMultipart(request);
      try {
        const result = await this.captures.intake(parsed.dto, actorFrom(request), workspaceFrom(request), parsed.file);
        return reply.header("set-cookie", shareCaptureCookie(result.token, this.captures.secureCookie())).header("location", "/capture").code(303).send();
      } finally { await parsed.cleanup() }
    }
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) throw new BadRequestException("Use form-encoded text or multipart media for Share Capture.");
    const result = await this.captures.intake(dto ?? {}, actorFrom(request), workspaceFrom(request));
    return reply.header("set-cookie", shareCaptureCookie(result.token, this.captures.secureCookie())).header("location", "/capture").code(303).send();
  }

  @WorkspaceOptional() @Post("uploads") @HttpCode(HttpStatus.CREATED)
  async upload(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = await parseShareTargetMultipart(request);
    try {
      if (!parsed.file) throw new BadRequestException("Choose one photo or video from this phone.");
      const result = await this.captures.intake(parsed.dto, actorFrom(request), workspaceFrom(request), parsed.file);
      reply.header("set-cookie", shareCaptureCookie(result.token, this.captures.secureCookie()));
      return { data: { receipt: result.receipt } };
    } finally { await parsed.cleanup() }
  }

  @WorkspaceOptional() @Get("current")
  current(@Req() request: AuthenticatedRequest) { return this.captures.current(shareCaptureTokenFromCookie(request.headers.cookie), actorFrom(request)); }

  @WorkspaceOptional() @Get("current/preview")
  async preview(@Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const result = await this.captures.preview(shareCaptureTokenFromCookie(request.headers.cookie), actorFrom(request));
    const safeName = result.fileName.replace(/["\r\n]/gu, "_");
    return reply.header("cache-control", "private, no-store").header("content-type", result.contentType).header("content-length", String(result.contentLength)).header("content-disposition", `inline; filename="${safeName}"`).send(result.body);
  }

  @Post("current/convert")
  async convert(@Req() request: FastifyRequest, @Body() dto: ConvertShareCaptureDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.captures.convert(shareCaptureTokenFromCookie(request.headers.cookie), dto, actorFrom(request));
    reply.header("set-cookie", shareCaptureCookie("", this.captures.secureCookie(), 0));
    return { data: { receipt: result.receipt, contentItem: result.contentItem }, meta: { idempotentReplay: result.idempotentReplay } };
  }

  @Post("current/materialize")
  async materialize(@Req() request: FastifyRequest, @Body() dto: MaterializeShareCaptureDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.captures.materialize(shareCaptureTokenFromCookie(request.headers.cookie), dto, actorFrom(request));
    reply.header("set-cookie", shareCaptureCookie("", this.captures.secureCookie(), 0));
    return { data: { receipt: result.receipt, mediaAsset: result.mediaAsset, ...(result.contentItem ? { contentItem: result.contentItem } : {}), ...(result.draftId ? { draftId: result.draftId } : {}) }, meta: { idempotentReplay: result.idempotentReplay } };
  }
}
