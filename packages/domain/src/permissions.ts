import type { Role } from "./types.js";

export type Permission =
  | "content:read"
  | "content:create"
  | "content:edit"
  | "content:approve"
  | "content:schedule"
  | "content:queue"
  | "content:publish"
  | "media:delete"
  | "engagement:read"
  | "engagement:draft"
  | "engagement:send"
  | "engagement:moderate"
  | "analytics:manage"
  | "automation:manage"
  | "workspace:manage";

const rolePermissions: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set([
    "content:read",
    "content:create",
    "content:edit",
    "content:approve",
    "content:schedule",
    "content:queue",
    "content:publish",
    "media:delete",
    "engagement:read",
    "engagement:draft",
    "engagement:send",
    "engagement:moderate",
    "analytics:manage",
    "automation:manage",
    "workspace:manage",
  ]),
  manager: new Set([
    "content:read",
    "content:create",
    "content:edit",
    "content:approve",
    "content:schedule",
    "content:queue",
    "content:publish",
    "media:delete",
    "engagement:read",
    "engagement:draft",
    "engagement:send",
    "engagement:moderate",
    "analytics:manage",
    "automation:manage",
  ]),
  creator: new Set(["content:read", "content:create", "content:edit", "engagement:read", "engagement:draft"]),
  viewer: new Set(["content:read", "engagement:read"]),
};

export function can(role: Role, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}
