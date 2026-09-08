import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Facebook Page analytics migration", () => {
  it("widens only the append-only proof snapshot platform constraint", async () => {
    const sql = await readFile(new URL("../migrations/059_facebook_page_post_analytics.sql", import.meta.url), "utf8");
    expect(sql).toContain("alter table post_analytics_snapshots");
    expect(sql).toContain("drop constraint if exists post_analytics_snapshots_platform_check");
    expect(sql).toContain("check (platform in ('instagram', 'facebook', 'youtube'))");
    expect(sql).not.toMatch(/delete\s+from|drop\s+table|truncate/i);
  });
});
