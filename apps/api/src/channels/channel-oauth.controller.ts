import { Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import { Public } from "../common/public.decorator.js";
import { ChannelOAuthService } from "./channel-oauth.service.js";
import { FacebookSelectionDto, FacebookSelectionParamDto, InstagramFacebookSelectionDto, InstagramOAuthCallbackDto, MetaMessagingSelectionDto, StartOAuthDto } from "./dto/oauth.dto.js";
import { WorkspaceQueryDto } from "../content/dto/content.dto.js";

@Controller({ path: "channels/oauth", version: "1" })
export class ChannelOAuthController {
  constructor(private readonly oauth: ChannelOAuthService) {}

  @Get("status")
  status() { return { instagram: { configured: this.oauth.configured() }, instagramFacebook:{configured:this.oauth.instagramFacebookConfigured(),connectionMode:"facebook_login",legacyInstagramLoginSupported:false}, facebook: { configured: this.oauth.facebookConfigured() }, youtube: { configured: this.oauth.youtubeConfigured() }, metaMessaging:{configured:this.oauth.metaMessagingConfigured(),connectionModes:["facebook_page_messenger","instagram_linked_page"],instagramLoginSupported:false} }; }

  @Post("instagram/start")
  startInstagram(@Req() request: FastifyRequest, @Body() dto: StartOAuthDto) {
    return this.oauth.startInstagram(workspaceFrom(request, dto.workspaceId), dto.brandId, actorFrom(request));
  }

  @Public() @Get("instagram/callback")
  async callbackInstagram(@Query() query: InstagramOAuthCallbackDto, @Res() reply: FastifyReply) {
    const result = await this.oauth.callbackInstagram({ state: query.state, ...(query.code ? { code: query.code } : {}), ...(query.error ? { error: query.error } : {}), ...(query.error_description ? { errorDescription: query.error_description } : {}) });
    return reply.redirect(result.redirectUrl, 302);
  }

  @Post("instagram-facebook/start")
  startInstagramFacebook(@Req() request:FastifyRequest,@Body() dto:StartOAuthDto){return this.oauth.startInstagramFacebook(workspaceFrom(request,dto.workspaceId),dto.brandId,actorFrom(request));}

  @Public() @Get("instagram-facebook/callback")
  async callbackInstagramFacebook(@Query() query:InstagramOAuthCallbackDto,@Res() reply:FastifyReply){const result=await this.oauth.callbackInstagramFacebook({state:query.state,...(query.code?{code:query.code}:{}),...(query.error?{error:query.error}:{}),...(query.error_description?{errorDescription:query.error_description}:{})});return reply.redirect(result.redirectUrl,302);}

  @Get("instagram-facebook/selections/:selectionId")
  getInstagramFacebookSelection(@Req() request:FastifyRequest,@Param() params:FacebookSelectionParamDto,@Query() query:WorkspaceQueryDto){return this.oauth.getInstagramFacebookSelection(workspaceFrom(request,query.workspaceId),params.selectionId,actorFrom(request));}

  @Post("instagram-facebook/selections/:selectionId")
  completeInstagramFacebookSelection(@Req() request:FastifyRequest,@Param() params:FacebookSelectionParamDto,@Body() dto:InstagramFacebookSelectionDto){return this.oauth.completeInstagramFacebookSelection(workspaceFrom(request,dto.workspaceId),params.selectionId,dto.instagramAccountIds,actorFrom(request));}

  @Post("meta-messaging/start")
  startMetaMessaging(@Req() request:FastifyRequest,@Body() dto:StartOAuthDto){return this.oauth.startMetaMessaging(workspaceFrom(request,dto.workspaceId),dto.brandId,actorFrom(request));}

  @Public() @Get("meta-messaging/callback")
  async callbackMetaMessaging(@Query() query:InstagramOAuthCallbackDto,@Res() reply:FastifyReply){const result=await this.oauth.callbackMetaMessaging({state:query.state,...(query.code?{code:query.code}:{}),...(query.error?{error:query.error}:{}),...(query.error_description?{errorDescription:query.error_description}:{})});return reply.redirect(result.redirectUrl,302);}

  @Get("meta-messaging/selections/:selectionId")
  getMetaMessagingSelection(@Req() request:FastifyRequest,@Param() params:FacebookSelectionParamDto,@Query() query:WorkspaceQueryDto){return this.oauth.getMetaMessagingSelection(workspaceFrom(request,query.workspaceId),params.selectionId,actorFrom(request));}

  @Post("meta-messaging/selections/:selectionId")
  completeMetaMessagingSelection(@Req() request:FastifyRequest,@Param() params:FacebookSelectionParamDto,@Body() dto:MetaMessagingSelectionDto){return this.oauth.completeMetaMessagingSelection(workspaceFrom(request,dto.workspaceId),params.selectionId,dto.targetKeys,actorFrom(request));}

  @Post("facebook/start")
  startFacebook(@Req() request: FastifyRequest, @Body() dto: StartOAuthDto) {
    return this.oauth.startFacebook(workspaceFrom(request, dto.workspaceId), dto.brandId, actorFrom(request));
  }

  @Public() @Get("facebook/callback")
  async callbackFacebook(@Query() query: InstagramOAuthCallbackDto, @Res() reply: FastifyReply) {
    const result = await this.oauth.callbackFacebook({ state: query.state, ...(query.code ? { code: query.code } : {}), ...(query.error ? { error: query.error } : {}), ...(query.error_description ? { errorDescription: query.error_description } : {}) });
    return reply.redirect(result.redirectUrl, 302);
  }

  @Get("facebook/selections/:selectionId")
  getFacebookSelection(@Req() request: FastifyRequest, @Param() params: FacebookSelectionParamDto, @Query() query: WorkspaceQueryDto) {
    return this.oauth.getFacebookSelection(workspaceFrom(request, query.workspaceId), params.selectionId, actorFrom(request));
  }

  @Post("facebook/selections/:selectionId")
  completeFacebookSelection(@Req() request: FastifyRequest, @Param() params: FacebookSelectionParamDto, @Body() dto: FacebookSelectionDto) {
    return this.oauth.completeFacebookSelection(workspaceFrom(request, dto.workspaceId), params.selectionId, dto.pageIds, actorFrom(request));
  }

  @Post("youtube/start")
  startYouTube(@Req() request: FastifyRequest, @Body() dto: StartOAuthDto) {
    return this.oauth.startYouTube(workspaceFrom(request, dto.workspaceId), dto.brandId, actorFrom(request));
  }

  @Public() @Get("youtube/callback")
  async callbackYouTube(@Query() query: InstagramOAuthCallbackDto, @Res() reply: FastifyReply) {
    const result = await this.oauth.callbackYouTube({ state: query.state, ...(query.code ? { code: query.code } : {}), ...(query.error ? { error: query.error } : {}), ...(query.error_description ? { errorDescription: query.error_description } : {}) });
    return reply.redirect(result.redirectUrl, 302);
  }
}
