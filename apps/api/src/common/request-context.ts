import { BadRequestException } from "@nestjs/common";
import type { Actor } from "@originpost/domain";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedRequest } from "./auth-context.guard.js";

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function actorFrom(request: FastifyRequest): Actor {
  return (request as AuthenticatedRequest).originpostActor ?? { id: "local-owner", name: "Local Owner", role: "owner" };
}

export function workspaceFrom(request: FastifyRequest, queryWorkspace?: string): string {
  return (request as AuthenticatedRequest).originpostWorkspaceId ?? header(request, "x-originpost-workspace-id") ?? queryWorkspace?.trim() ?? "default";
}

export function expectedVersionFrom(request: FastifyRequest): number | undefined {
  const value = header(request, "if-match");
  if (!value) return undefined;
  const normalized = value.replace(/^W\//, "").replace(/^"|"$/g, "");
  const version = Number(normalized);
  if (!Number.isInteger(version) || version < 1) throw new BadRequestException("If-Match must contain a positive Content Item version.");
  return version;
}
