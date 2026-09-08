import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Param, Patch, Post, Query, Req, Res, VERSION_NEUTRAL } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorFrom, workspaceFrom } from "../common/request-context.js";
import type { AuthenticatedRequest } from "../common/auth-context.guard.js";
import { Public } from "../common/public.decorator.js";
import { WorkspaceOptional } from "../common/workspace-optional.decorator.js";
import { AuthService } from "./auth.service.js";
import { ChangePasswordDto, CreateMemberDto, CreateWorkspaceInvitationDto, LoginDto, MemberParamDto, OidcCallbackDto, RegisterWorkspaceInvitationDto, ResendWorkspaceInvitationDto, UpdateMemberRoleDto, WorkspaceIdParamDto, WorkspaceInvitationParamDto, WorkspaceInvitationTokenDto } from "./auth.dto.js";
import { OIDC_NONCE_COOKIE, OIDC_STATE_COOKIE, OIDC_VERIFIER_COOKIE, SESSION_COOKIE } from "./auth.constants.js";
import { OidcAuthService } from "./oidc-auth.service.js";

function cookieValue(name: string, token: string, maxAge: number, secure: boolean, path = "/"): string {
  return `${name}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function requestCookie(request: FastifyRequest, name: string): string {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function sensitiveHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff");
}

@Controller({ path: "auth", version: "1" })
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly auth: AuthService, private readonly oidc: OidcAuthService, private readonly config: ConfigService) {}

  @Public() @Get("config") configView() {
    return { mode: this.auth.mode(), passwordLogin: this.auth.mode() === "sessions", oidc: { enabled: this.oidc.enabled(), displayName: this.oidc.displayName() } };
  }

  @Public() @Post("login") @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.login(dto.email, dto.password, request.ip);
    const secure = this.config.get<boolean>("AUTH_COOKIE_SECURE") ?? this.config.get<string>("NODE_ENV") === "production";
    const maxAge = Math.max(1, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
    reply.header("set-cookie", cookieValue(SESSION_COOKIE, result.sessionToken, maxAge, secure));
    const { sessionToken: _secret, ...body } = result;
    return body;
  }

  @Public() @Get("oidc/start")
  async oidcStart(@Res() reply: FastifyReply) {
    const result = await this.oidc.start();
    const secure = this.config.get<boolean>("AUTH_COOKIE_SECURE") ?? this.config.get<string>("NODE_ENV") === "production";
    const path = "/v1/auth/oidc/callback";
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", [
      cookieValue(OIDC_STATE_COOKIE, result.state, 600, secure, path),
      cookieValue(OIDC_NONCE_COOKIE, result.nonce, 600, secure, path),
      cookieValue(OIDC_VERIFIER_COOKIE, result.codeVerifier, 600, secure, path),
    ]);
    return reply.redirect(result.authorizationUrl, 302);
  }

  @Public() @Get("oidc/callback")
  async oidcCallback(@Query() query: OidcCallbackDto, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const stateCookie = requestCookie(request, OIDC_STATE_COOKIE);
    const nonceCookie = requestCookie(request, OIDC_NONCE_COOKIE);
    const verifierCookie = requestCookie(request, OIDC_VERIFIER_COOKIE);
    const secure = this.config.get<boolean>("AUTH_COOKIE_SECURE") ?? this.config.get<string>("NODE_ENV") === "production";
    const clear = [OIDC_STATE_COOKIE, OIDC_NONCE_COOKIE, OIDC_VERIFIER_COOKIE].map((name) => cookieValue(name, "", 0, secure, "/v1/auth/oidc/callback"));
    try {
      if (!query.state) throw new Error("OIDC callback did not include state.");
      if (query.error) {
        await this.oidc.cancel(query.state, stateCookie, nonceCookie);
        throw new Error("The identity provider denied the sign-in request.");
      }
      if (!query.code) throw new Error("OIDC callback did not include an authorization code.");
      const result = await this.oidc.callback({ code: query.code, state: query.state, stateCookie, nonceCookie, codeVerifierCookie: verifierCookie, ...(query.iss ? { responseIssuer: query.iss } : {}) });
      const maxAge = Math.max(1, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
      reply.header("cache-control", "no-store");
      reply.header("set-cookie", [cookieValue(SESSION_COOKIE, result.sessionToken, maxAge, secure), ...clear]);
      const target = new URL(this.oidc.webReturnUrl());
      target.searchParams.set("auth", "oidc");
      return reply.redirect(target.toString(), 302);
    } catch (error) {
      this.logger.warn(`OIDC callback rejected: ${error instanceof Error ? error.constructor.name : "UnknownError"}`);
      reply.header("cache-control", "no-store");
      reply.header("set-cookie", clear);
      const target = new URL(this.oidc.webReturnUrl());
      target.searchParams.set("auth", "error");
      return reply.redirect(target.toString(), 302);
    }
  }

  @WorkspaceOptional() @Get("me")
  me(@Req() request: AuthenticatedRequest) { return this.auth.me(request.originpostUserId!, request.originpostCsrfToken, request.originpostActor, request.originpostWorkspaceId) }

  @WorkspaceOptional() @Post("logout") @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(request.originpostSessionId);
    reply.header("set-cookie", cookieValue(SESSION_COOKIE, "", 0, this.config.get<boolean>("AUTH_COOKIE_SECURE") ?? false));
  }

  @WorkspaceOptional() @Post("password") @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(@Req() request: AuthenticatedRequest, @Body() dto: ChangePasswordDto) { return this.auth.changePassword(request.originpostUserId!, request.originpostSessionId!, dto) }
}

@Controller({ path: "workspaces", version: "1" })
export class MembershipController {
  constructor(private readonly auth: AuthService) {}

  @Get(":workspaceId/members")
  list(@Req() request: FastifyRequest, @Param() params: WorkspaceIdParamDto) { return this.auth.listMembers(workspaceFrom(request, params.workspaceId), actorFrom(request)) }

  @Post(":workspaceId/members")
  create(@Req() request: FastifyRequest, @Param() params: WorkspaceIdParamDto, @Body() dto: CreateMemberDto) { return this.auth.createMember(workspaceFrom(request, params.workspaceId), dto, actorFrom(request)) }

  @Patch(":workspaceId/members/:userId/role")
  role(@Req() request: FastifyRequest, @Param() params: MemberParamDto, @Body() dto: UpdateMemberRoleDto) { return this.auth.updateRole(workspaceFrom(request, params.workspaceId), params.userId, dto.role, actorFrom(request)) }
}

@Controller({ path: "workspaces", version: "1" })
export class WorkspaceInvitationController {
  constructor(private readonly auth: AuthService) {}

  @Get(":workspaceId/invitations")
  async list(@Req() request: FastifyRequest, @Param() params: WorkspaceIdParamDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    return this.auth.listInvitations(workspaceFrom(request, params.workspaceId), actorFrom(request));
  }

  @Post(":workspaceId/invitations")
  async create(@Req() request: FastifyRequest, @Param() params: WorkspaceIdParamDto, @Body() dto: CreateWorkspaceInvitationDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    return this.auth.createInvitation(workspaceFrom(request, params.workspaceId), dto, actorFrom(request), request.ip);
  }

  @Post(":workspaceId/invitations/:invitationId/revoke")
  async revoke(@Req() request: FastifyRequest, @Param() params: WorkspaceInvitationParamDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    return this.auth.revokeInvitation(workspaceFrom(request, params.workspaceId), params.invitationId, actorFrom(request), request.ip);
  }

  @Post(":workspaceId/invitations/:invitationId/resend")
  async resend(@Req() request: FastifyRequest, @Param() params: WorkspaceInvitationParamDto, @Body() dto: ResendWorkspaceInvitationDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    return this.auth.resendInvitation(workspaceFrom(request, params.workspaceId), params.invitationId, dto, actorFrom(request), request.ip);
  }
}

@Controller({ path: "auth/invitations", version: "1" })
export class AuthenticatedWorkspaceInvitationController {
  constructor(private readonly auth: AuthService) {}

  @WorkspaceOptional()
  @Post("accept")
  async accept(@Req() request: AuthenticatedRequest, @Body() dto: WorkspaceInvitationTokenDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    return this.auth.acceptInvitation(request.originpostUserId!, dto, request.ip);
  }
}

@Public()
@Controller({ path: "public/v1/invitations", version: VERSION_NEUTRAL })
export class PublicWorkspaceInvitationController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Post("preview") @HttpCode(HttpStatus.OK)
  async preview(@Req() request: FastifyRequest, @Body() dto: WorkspaceInvitationTokenDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    return this.auth.previewInvitation(dto, request.ip);
  }

  @Post("register") @HttpCode(HttpStatus.CREATED)
  async register(@Req() request: FastifyRequest, @Body() dto: RegisterWorkspaceInvitationDto, @Res({ passthrough: true }) reply: FastifyReply) {
    sensitiveHeaders(reply);
    const result = await this.auth.registerInvitation(dto, request.ip);
    const secure = this.config.get<boolean>("AUTH_COOKIE_SECURE") ?? this.config.get<string>("NODE_ENV") === "production";
    const maxAge = Math.max(1, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
    reply.header("set-cookie", cookieValue(SESSION_COOKIE, result.sessionToken, maxAge, secure));
    const { sessionToken: _secret, ...body } = result;
    return body;
  }
}
