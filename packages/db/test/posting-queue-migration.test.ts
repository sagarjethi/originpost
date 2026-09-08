import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("posting queue migration", () => {
  it("pins account lineage, idempotency, and one active account slot", async () => {
    const sql = await readFile(new URL("../migrations/050_account_posting_queues.sql", import.meta.url), "utf8");
    expect(sql).toContain("posting_queue_profile_account_fk");
    expect(sql).toContain("unique (workspace_id,idempotency_key)");
    expect(sql).toContain("posting_queue_one_active_slot_idx");
    expect(sql).toContain("where released_at is null");
    expect(sql).toContain("posting_queue_reservation_target_fk");
  });
});
