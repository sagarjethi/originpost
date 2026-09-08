import { describe, expect, it } from "vitest";
import { createBrand, createWorkspaceOrganization, DomainError, renameWorkspace, updateBrand } from "../src/index.js";

const owner = { id: "owner-1", name: "Owner", role: "owner" as const };
const creator = { id: "creator-1", name: "Creator", role: "creator" as const };

describe("organizations", () => {
  it("creates a workspace with one active default brand", () => {
    const result = createWorkspaceOrganization({ name: "Regional Newsroom", defaultBrandName: "River City News", primaryLanguage: "Gujarati", timezone: "Asia/Kolkata", actor: owner, now: "2026-08-29T08:00:00.000Z" });
    expect(result.workspace).toMatchObject({ name: "Regional Newsroom", slug: "regional-newsroom" });
    expect(result.defaultBrand).toMatchObject({ workspaceId: result.workspace.id, name: "River City News", primaryLanguage: "Gujarati", timezone: "Asia/Kolkata", status: "active" });
    expect(result.event).toMatchObject({ workspaceId: result.workspace.id, action: "workspace.created" });
  });

  it("normalizes editable slugs and blocks invalid time zones", () => {
    expect(createWorkspaceOrganization({ name: "Team 2026", slug: "team-2026", actor: owner }).workspace.slug).toBe("team-2026");
    expect(() => createWorkspaceOrganization({ name: "Team", timezone: "Mars/Olympus", actor: owner })).toThrowError(DomainError);
  });

  it("keeps workspace and brand changes owner-only", () => {
    const created = createWorkspaceOrganization({ name: "Newsroom", actor: owner, now: "2026-08-29T08:00:00.000Z" });
    expect(() => renameWorkspace(created.workspace, { name: "Changed" }, creator)).toThrowError(DomainError);
    expect(() => createBrand({ workspaceId: created.workspace.id, name: "Sports", actor: creator })).toThrowError(DomainError);
    const added = createBrand({ workspaceId: created.workspace.id, name: "Sports", timezone: "Asia/Kolkata", actor: owner, now: "2026-08-29T09:00:00.000Z" });
    const archived = updateBrand(added.brand, { status: "archived" }, owner, "2026-08-29T10:00:00.000Z");
    expect(archived.brand).toMatchObject({ status: "archived", timezone: "Asia/Kolkata" });
  });
});
