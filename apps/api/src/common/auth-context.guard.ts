import { adminNetworkAllowed, isCredentialMutation } from './admin-network.js';
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Actor } from "@originpost/domain";
import type { FastifyRequest } from "fastify";
import { INFRASTRUCTURE } from "./tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { SESSION_COOKIE } from "../auth/auth.constants.js";
import { IS_PUBLIC_ROUTE } from "./public.decorator.js";
import { WORKSPACE_OPTIONAL } from "./workspace-optional.decorator.js";
import { ALLOW_SHARE_TARGET_POST } from "./share-target.decorator.js";

export type AuthenticatedRequest = FastifyRequest & {
  originpostActor?: Actor;
  originpostWorkspaceId?: string;
  originpostUserId?: string;
  originpostSessionId?: string;
  originpostCsrfToken?: string;
};

function value(input: unknown): string | undefined { return typeof input === "string" && input.trim() ? input.trim() : undefined }

function requestedWorkspace(request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  const params = request.params as Record<string, unknown> | undefined;
  return value(request.headers["x-originpost-workspace-id"]) ?? value(query?.workspaceId) ?? value(body?.workspaceId) ?? value(params?.workspaceId);
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function trustedShareTargetPost(request: FastifyRequest, expectedOrigin: string): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  const contentType = value(request.headers["content-type"])?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded") && !contentType.startsWith("multipart/form-data;")) return false;
  const fetchSite = value(request.headers["sec-fetch-site"])?.toLowerCase();
  const fetchMode = value(request.headers["sec-fetch-mode"])?.toLowerCase();
  if (!(["none", "same-origin"].includes(fetchSite ?? "")) || (fetchMode && fetchMode !== "navigate")) return false;
  const origin = value(request.headers.origin);
  if (!origin) return fetchSite === "none";
  try { return new URL(origin).origin === new URL(expectedOrigin).origin; } catch { return false; }
}

@Injectable()
export class AuthContextGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const mode = this.config.get<string>("AUTH_MODE") ?? "single-user";
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (isCredentialMutation(request.method,request.url) && !adminNetworkAllowed(this.config.get<string>('ADMIN_ALLOWED_IPS'),request.ip)) throw new ForbiddenException('Configuration changes are restricted to approved administrator networks.');
    const explicitWorkspace = requestedWorkspace(request);
    if (mode === "single-user") {
      request.originpostWorkspaceId = explicitWorkspace ?? "default";
      request.originpostActor = { id: this.config.get<string>("BOOTSTRAP_USER_ID") ?? "local-owner", name: this.config.get<string>("BOOTSTRAP_USER_NAME") ?? "Local Owner", role: "owner" };
      request.originpostUserId = request.originpostActor.id;
      return true;
    }
    if (mode !== "sessions") throw new UnauthorizedException("Authentication mode is not supported.");

    const rawToken = cookie(request, SESSION_COOKIE);
    if (!rawToken) throw new UnauthorizedException("Sign in to continue.");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const principal = await this.infrastructure.authRepository.findSessionByTokenHash(tokenHash, new Date().toISOString());
    if (!principal) throw new UnauthorizedException("Your session expired. Sign in again.");
    const workspaceOptional = this.reflector.getAllAndOverride<boolean>(WORKSPACE_OPTIONAL, [context.getHandler(), context.getClass()]);
    const memberships = workspaceOptional && !explicitWorkspace ? await this.infrastructure.authRepository.listMemberships(principal.user.id) : [];
    const membership = explicitWorkspace
      ? await this.infrastructure.authRepository.getMembership(explicitWorkspace, principal.user.id)
      : workspaceOptional
        ? memberships[0]
        : await this.infrastructure.authRepository.getMembership("default", principal.user.id);
    if (!membership) throw new ForbiddenException("You do not have access to this workspace.");

    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
    const allowShareTarget = this.reflector.getAllAndOverride<boolean>(ALLOW_SHARE_TARGET_POST, [context.getHandler(), context.getClass()]);
    const shareTargetAllowed = allowShareTarget && trustedShareTargetPost(request, this.config.get<string>("WEB_PUBLIC_URL") ?? this.config.get<string>("CORS_ORIGIN") ?? "http://localhost:3000");
    if (!safeMethod && !sameToken(value(request.headers["x-originpost-csrf"]), principal.session.csrfToken) && !shareTargetAllowed) {
      throw new ForbiddenException("The security token is missing or expired. Refresh and try again.");
    }

    request.originpostWorkspaceId = membership.workspaceId;
    request.originpostActor = { id: principal.user.id, name: principal.user.displayName, role: membership.role };
    request.originpostUserId = principal.user.id;
    request.originpostSessionId = principal.session.id;
    request.originpostCsrfToken = principal.session.csrfToken;
    if (Date.now() - new Date(principal.session.lastSeenAt).getTime() > 5 * 60_000) {
      await this.infrastructure.authRepository.touchSession(principal.session.id, new Date().toISOString());
    }
    return true;
  }
}
