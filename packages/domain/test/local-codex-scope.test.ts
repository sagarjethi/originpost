import { expect, it } from "vitest";
import { canUseLocalCodex } from "../src/local-codex-scope.js";
it("requires an explicit workspace and human owner in sessions mode", () => {
  const input = {
    authMode: "sessions",
    workspaceId: "w",
    ownerWorkspaceId: "w",
    ownerUserId: "u",
    actor: { id: "u", role: "owner" as const, actorType: "human" as const },
  };
  expect(canUseLocalCodex(input)).toBe(true);
  for (const changed of [
    { ownerUserId: "" },
    { ownerWorkspaceId: "" },
    { workspaceId: "other" },
    { actor: { ...input.actor, id: "other" } },
    { actor: { ...input.actor, role: "creator" as const } },
    { actor: { ...input.actor, actorType: "agent" as const } },
    { authMode: "unexpected" },
  ])
    expect(canUseLocalCodex({ ...input, ...changed })).toBe(false);
  expect(canUseLocalCodex({ authMode: "single-user", workspaceId: "w" })).toBe(
    true,
  );
});
