import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Media Organization migration", () => {
  it("stores scoped folder trees and normalized asset organization", () => {
    const sql = readFileSync(new URL("../migrations/049_media_organization.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table if not exists media_folders");
    expect(sql).toContain("media_folders_parent_fk");
    expect(sql).toContain("references media_folders(id, workspace_id, brand_id)");
    expect(sql).toContain("media_folders_sibling_name_unique");
    expect(sql).toContain("create table if not exists media_asset_organization");
    expect(sql).toContain("references media_assets(id, workspace_id, brand_id)");
    expect(sql).toContain("cardinality(tags) <= 20");
    expect(sql).toContain("using gin (tags)");
  });
});
