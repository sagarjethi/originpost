import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Creative Studio migration", () => {
  it("normalizes immutable revision and render lineage with tenant, hash, and lifecycle checks", () => {
    const sql = readFileSync(new URL("../migrations/044_creative_studio.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table if not exists creative_projects");
    expect(sql).toContain("create table if not exists creative_revisions");
    expect(sql).toContain("create table if not exists creative_renders");
    expect(sql).toContain("unique (project_id, revision_number)");
    expect(sql).toContain("unique (revision_id, spec_sha256)");
    expect(sql).toContain("render_manifest_sha256 text not null check");
    expect(sql).toContain("foreign key (workspace_id, brand_id)");
    expect(sql).toContain("lease_expires_at timestamptz");
    expect(sql).toContain("attempt_count integer not null");
    expect(sql).toContain("spec - array[");
    const repository = readFileSync(new URL("../src/postgres-creative-studio-repository.ts", import.meta.url), "utf8");
    expect(repository).toMatch(/lease_expires_at>clock_timestamp\(\)/u);
    expect(repository).toMatch(/lease_expires_at<=clock_timestamp\(\)/u);
  });
});
