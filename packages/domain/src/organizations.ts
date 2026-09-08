import { DomainError } from "./errors.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent, Brand, Workspace } from "./types.js";

function identifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function organizationSlug(value: string): string {
  const slug = value.trim().toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new DomainError("Use at least one English letter or number in the slug.", "slug_required");
  return slug;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>, now: string): AuditEvent {
  return { id: identifier("evt"), workspaceId, actorId: actor.id, actorType: "human", action, detail, createdAt: now };
}

export function createWorkspaceOrganization(input: {
  name: string;
  slug?: string | undefined;
  defaultBrandName?: string | undefined;
  primaryLanguage?: string | undefined;
  timezone?: string | undefined;
  actor: Actor;
  now?: string | undefined;
}) {
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("Workspace name must contain at least two characters.", "workspace_name_required");
  const timezone = input.timezone?.trim() || "UTC";
  if (!validTimeZone(timezone)) throw new DomainError("Use a valid IANA time zone, such as Asia/Kolkata.", "timezone_invalid");
  const now = input.now ?? new Date().toISOString();
  const workspace: Workspace = { id: identifier("workspace"), name, slug: organizationSlug(input.slug || name), createdAt: now, updatedAt: now };
  const brandName = input.defaultBrandName?.trim() || name;
  const defaultBrand: Brand = {
    id: identifier("brand"), workspaceId: workspace.id, name: brandName, slug: organizationSlug(brandName),
    primaryLanguage: input.primaryLanguage?.trim() || "English", timezone, status: "active",
    createdBy: input.actor.id, createdAt: now, updatedAt: now,
  };
  return {
    workspace,
    defaultBrand,
    event: audit(workspace.id, input.actor, "workspace.created", { name, slug: workspace.slug, defaultBrandId: defaultBrand.id }, now),
  };
}

export function renameWorkspace(workspace: Workspace, input: { name: string; slug?: string | undefined }, actor: Actor, now = new Date().toISOString()) {
  if (!can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can change workspace details.", "permission_denied", 403);
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("Workspace name must contain at least two characters.", "workspace_name_required");
  const updated: Workspace = { ...workspace, name, slug: organizationSlug(input.slug || workspace.slug), updatedAt: now };
  return { workspace: updated, event: audit(workspace.id, actor, "workspace.updated", { name: updated.name, slug: updated.slug }, now) };
}

export function createBrand(input: {
  workspaceId: string;
  name: string;
  slug?: string | undefined;
  description?: string | undefined;
  primaryLanguage?: string | undefined;
  timezone?: string | undefined;
  actor: Actor;
  now?: string | undefined;
}) {
  if (!can(input.actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can add a brand.", "permission_denied", 403);
  const name = input.name.trim();
  if (name.length < 2) throw new DomainError("Brand name must contain at least two characters.", "brand_name_required");
  const timezone = input.timezone?.trim() || "UTC";
  if (!validTimeZone(timezone)) throw new DomainError("Use a valid IANA time zone, such as Asia/Kolkata.", "timezone_invalid");
  const now = input.now ?? new Date().toISOString();
  const brand: Brand = {
    id: identifier("brand"), workspaceId: input.workspaceId, name, slug: organizationSlug(input.slug || name),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    primaryLanguage: input.primaryLanguage?.trim() || "English", timezone, status: "active",
    createdBy: input.actor.id, createdAt: now, updatedAt: now,
  };
  return { brand, event: audit(input.workspaceId, input.actor, "brand.created", { brandId: brand.id, name, slug: brand.slug }, now) };
}

export function updateBrand(brand: Brand, input: {
  name?: string | undefined;
  slug?: string | undefined;
  description?: string | undefined;
  primaryLanguage?: string | undefined;
  timezone?: string | undefined;
  status?: Brand["status"] | undefined;
}, actor: Actor, now = new Date().toISOString()) {
  if (!can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can change a brand.", "permission_denied", 403);
  const name = input.name?.trim() || brand.name;
  const timezone = input.timezone?.trim() || brand.timezone;
  if (name.length < 2) throw new DomainError("Brand name must contain at least two characters.", "brand_name_required");
  if (!validTimeZone(timezone)) throw new DomainError("Use a valid IANA time zone, such as Asia/Kolkata.", "timezone_invalid");
  const updated: Brand = {
    ...brand, name, slug: organizationSlug(input.slug || brand.slug), timezone,
    primaryLanguage: input.primaryLanguage?.trim() || brand.primaryLanguage,
    ...(input.description !== undefined ? { description: input.description.trim() || undefined } : {}),
    status: input.status ?? brand.status, updatedAt: now,
  };
  return { brand: updated, event: audit(brand.workspaceId, actor, "brand.updated", { brandId: brand.id, name: updated.name, status: updated.status }, now) };
}
