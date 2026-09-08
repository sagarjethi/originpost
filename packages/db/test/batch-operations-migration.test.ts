import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
describe("batch operations migration", () => {
  it("scopes plans to workspace and brand with optimistic versions", async () => { const sql = await readFile(new URL("../migrations/039_batch_operations.sql", import.meta.url), "utf8"); expect(sql).toContain("foreign key (workspace_id, brand_id)"); expect(sql).toContain("unique (workspace_id, brand_id, source_sha256)"); expect(sql).toContain("version integer not null"); expect(sql).toContain("jsonb_array_length(rows) between 1 and 100"); });
});
