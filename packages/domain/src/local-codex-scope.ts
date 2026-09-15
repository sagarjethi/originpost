import type { Actor } from "./types.js";

/** A personal runtime may be shared with exactly one explicitly configured session owner. */
export function canUseLocalCodex(input: {
  authMode: string;
  workspaceId: string;
  ownerWorkspaceId?: string | undefined;
  ownerUserId?: string | undefined;
  actor?: Pick<Actor, "id" | "role" | "actorType"> | undefined;
}): boolean {
  if (input.authMode === "single-user") return true;
  return (
    input.authMode === "sessions" &&
    Boolean(input.ownerWorkspaceId?.trim()) &&
    Boolean(input.ownerUserId?.trim()) &&
    input.workspaceId === input.ownerWorkspaceId?.trim() &&
    input.actor?.id === input.ownerUserId?.trim() &&
    input.actor?.role === "owner" &&
    (!input.actor.actorType || input.actor.actorType === "human")
  );
}
