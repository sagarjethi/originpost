import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("provider publish execution claim migration", () => {
  it("adds a database lease and the durable creating state", async () => {
    const sql = await readFile(new URL("../migrations/045_provider_publish_execution_claims.sql", import.meta.url), "utf8");
    expect(sql).toContain("claim_owner text");
    expect(sql).toContain("claim_expires_at timestamptz");
    expect(sql).toContain("'creating'");
    expect(sql).toContain("provider_publish_operations_claim_idx");
  });
});
