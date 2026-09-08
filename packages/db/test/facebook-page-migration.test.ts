import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Facebook Page database migration", () => {
  it("widens only account, OAuth state, and provider operation platform checks", async () => {
    const sql = await readFile(new URL("../migrations/029_facebook_page_publishing.sql", import.meta.url), "utf8");

    expect(sql).toContain("alter table connected_accounts");
    expect(sql).toContain("alter table oauth_connection_states");
    expect(sql).toContain("alter table provider_publish_operations");
    expect(sql.match(/check \(platform in \('instagram', 'facebook', 'youtube'\)\)/g)).toHaveLength(3);
    expect(sql).not.toMatch(/post_analytics_snapshots/i);
    expect(sql).toContain("'provider-discovery'");
  });
});
