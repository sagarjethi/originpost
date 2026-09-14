import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("image generation migration", () => {
  it("stores bounded paid-request lineage and enforces terminal result shapes", async () => {
    const sql = await readFile(new URL("../migrations/063_image_generations.sql", import.meta.url), "utf8");
    expect(sql).toContain("constraint image_generations_idempotency_unique unique (workspace_id, idempotency_key_sha256)");
    expect(sql).toContain("disclosure_required boolean not null check (disclosure_required)");
    expect(sql).toContain("status in ('failed','uncertain')");
    expect(sql).toContain("where status = 'generating'");
    expect(sql).not.toMatch(/api[_ ]?key|authorization|bearer/i);
  });
});
