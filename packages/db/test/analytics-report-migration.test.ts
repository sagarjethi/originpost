import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("analytics client report migration", () => {
  it("keeps report snapshots append-only and client links revocable", async () => {
    const source = await readFile(new URL("../migrations/038_analytics_client_reports.sql", import.meta.url), "utf8");
    expect(source).toContain("create table if not exists analytics_report_definitions");
    expect(source).toContain("create table if not exists analytics_report_snapshots");
    expect(source).toContain("create table if not exists analytics_report_shares");
    expect(source).toContain("analytics_report_snapshots_append_only");
    expect(source).toContain("token_sha256 text not null unique");
    expect(source).toContain("foreign key (workspace_id, report_id, snapshot_id)");
    expect(source).not.toMatch(/access[_-]?token|refresh[_-]?token|client[_-]?secret/i);
  });
});
