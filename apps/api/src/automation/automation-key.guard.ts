import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AutomationApiKey, Role } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { AuthenticatedRequest } from "../common/auth-context.guard.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";

export type AutomationAuthenticatedRequest = AuthenticatedRequest & { originpostAutomationKey?: AutomationApiKey };

export function roleForAutomationKey(key: AutomationApiKey): Role {
  if (key.scopes.includes("content:schedule") || key.scopes.includes("events:manage")) return "manager";
  if (key.scopes.includes("content:write") || key.scopes.includes("imports:write")) return "creator";
  return "viewer";
}

@Injectable()
export class AutomationKeyGuard implements CanActivate {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AutomationAuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token || token.length < 32 || token.length > 300) throw new UnauthorizedException("Use a valid OriginPost API key.");
    const now = new Date().toISOString();
    const key = await this.infrastructure.automationRepository.authenticateApiKey(createHash("sha256").update(token).digest("hex"), now);
    if (!key) throw new UnauthorizedException("This API key is invalid, expired, or revoked.");
    request.originpostAutomationKey = key;
    request.originpostWorkspaceId = key.workspaceId;
    request.originpostActor = { id: `api_key:${key.id}`, name: key.name, role: roleForAutomationKey(key), actorType: "api_key" };
    await this.infrastructure.automationRepository.touchApiKey(key.id, now);
    return true;
  }
}

export function automationKeyFrom(request: AutomationAuthenticatedRequest): AutomationApiKey {
  if (!request.originpostAutomationKey) throw new UnauthorizedException("A valid OriginPost API key is required.");
  return request.originpostAutomationKey;
}
