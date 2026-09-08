import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Facebook Page engagement migration", () => {
  it("widens Meta engagement checks and guards child/provider lineage", async () => {
    const sql = await readFile(new URL("../migrations/032_facebook_page_engagement.sql", import.meta.url), "utf8");

    expect(sql).toContain("check (platform in ('instagram', 'facebook'))");
    expect(sql).toContain("check (provider in ('instagram', 'facebook'))");
    expect(sql).toContain("engagement_comments_platform_thread_fk");
    expect(sql).toContain("engagement_actions_platform_comment_fk");
    expect(sql).toContain("provider_webhook_receipts_platform_account_fk");
    expect(sql).not.toContain("youtube");
  });
});
