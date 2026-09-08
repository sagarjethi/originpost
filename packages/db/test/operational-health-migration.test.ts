import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("operational health alert migration", () => {
  it("adds operator-only notification visibility and durable incident state", async () => {
    const sql = await readFile(new URL("../migrations/058_operational_health_alerts.sql", import.meta.url), "utf8");
    expect(sql).toContain("audience text not null default 'workspace'");
    expect(sql).toContain("'workspace', 'operators'");
    expect(sql).toContain("create table if not exists workspace_operational_incidents");
    expect(sql).toContain("primary key (workspace_id, check_id)");
    expect(sql).toContain("where resolved_at is null");
  });
});
