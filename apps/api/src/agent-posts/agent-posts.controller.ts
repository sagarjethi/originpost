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
import { AgentPostPublishingService } from "./agent-post-publishing.service.js";
import { AgentPostsService } from "./agent-posts.service.js";
import {
  AgentPostQueryDto,
  AgentPostPublishDto,
  AgentPostPublishPreviewDto,
  AgentPostTemplateDto,
  CreateAgentPostDto,
  ImportAgentPostImageDto,
  RecoverAgentPostCompositionDto,
  CorrectAgentPostCopyDto,
} from "./agent-posts.dto.js";
@Controller({ path: "agent-posts", version: "1" })
export class AgentPostsController {
  constructor(
    private readonly posts: AgentPostsService,
    private readonly publishing: AgentPostPublishingService,
  ) {}
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
  @Get(":id/image-brief") brief(
    @Req() r: FastifyRequest,
    @Query() q: AgentPostQueryDto,
    @Param("id") id: string,
  ) {
    return this.posts.exportImageBrief(
      workspaceFrom(r, q.workspaceId),
      q.brandId,
      id,
      actorFrom(r),
    );
  }
  @Post(":id/image") image(
    @Req() r: FastifyRequest,
    @Body() d: ImportAgentPostImageDto,
    @Param("id") id: string,
  ) {
    return this.posts.importImage(
      workspaceFrom(r, d.workspaceId),
      id,
      d,
      actorFrom(r),
    );
  }
  @Get(":id/composition-recovery") recoveryOptions(@Req() r: FastifyRequest, @Query() q: AgentPostQueryDto, @Param("id") id: string) {
    return this.posts.compositionRecoveryOptions(workspaceFrom(r, q.workspaceId), q.brandId, id, actorFrom(r));
  }
  @Post(":id/copy-revisions") correctCopy(@Req() r: FastifyRequest, @Body() d: CorrectAgentPostCopyDto, @Param("id") id: string, @Headers("idempotency-key") key: string | undefined) {
    return this.posts.correctCopy(workspaceFrom(r, d.workspaceId), id, d, key, actorFrom(r));
  }
  @Post(":id/composition-recovery") recoverComposition(@Req() r: FastifyRequest, @Body() d: RecoverAgentPostCompositionDto, @Param("id") id: string) {
    return this.posts.recoverComposition(workspaceFrom(r, d.workspaceId), id, d, actorFrom(r));
  }
  @Get(":id/publication") publication(
    @Req() r: FastifyRequest,
    @Query() q: AgentPostQueryDto,
    @Param("id") id: string,
  ) {
    return this.publishing.detail(
      workspaceFrom(r, q.workspaceId),
      q.brandId,
      id,
      actorFrom(r),
    );
  }
  @Post(":id/publication-preview") publicationPreview(
    @Req() r: FastifyRequest,
    @Body() d: AgentPostPublishPreviewDto,
    @Param("id") id: string,
  ) {
    return this.publishing.preview(
      workspaceFrom(r, d.workspaceId),
      id,
      d,
      actorFrom(r),
    );
  }
  @Post(":id/publication") publish(
    @Req() r: FastifyRequest,
    @Body() d: AgentPostPublishDto,
    @Param("id") id: string,
  ) {
    return this.publishing.publish(
      workspaceFrom(r, d.workspaceId),
      id,
      d,
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
