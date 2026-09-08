import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("engagement notification kind migration", () => {
  it("keeps every domain notification kind accepted by Postgres", async () => {
    const sql = await readFile(new URL("../migrations/033_engagement_notification_kinds.sql", import.meta.url), "utf8");
    const kinds = [
      "publish_failed", "action_required", "monitor_new_findings", "monitor_failed", "connection_attention",
      "approval_needed", "engagement_reply_failed", "engagement_permission_missing", "engagement_new_activity", "system",
    ];
    expect(sql).toContain("drop constraint if exists workspace_notifications_kind_check");
    for (const kind of kinds) expect(sql).toContain(`'${kind}'`);
  });
});
