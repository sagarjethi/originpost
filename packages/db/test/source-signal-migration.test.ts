import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Source Signal migration", () => {
  it("stores event identity and a recoverable save reservation before Content Item creation", async () => {
    const sql = await readFile(new URL("../migrations/041_source_signal_inbox.sql", import.meta.url), "utf8");
    expect(sql).toContain("event_fingerprint");
    expect(sql).toContain("state in ('new','saving','saved','dismissed')");
    expect(sql).toContain("pending_content_item_id");
    expect(sql).toContain("save_claim_id");
    expect(sql).toContain("save_lease_expires_at");
    expect(sql).toContain("source_signals_state_shape");
    expect(sql).not.toContain("source_fingerprint");
  });
});
