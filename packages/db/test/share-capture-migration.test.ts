import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("mobile share capture migration", () => {
  it("stores only hash tokens and binds converted items to workspace and brand", async () => {
    const sql = await readFile(new URL("../migrations/040_mobile_share_capture.sql", import.meta.url), "utf8");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).toContain("references content_items(id, workspace_id, brand_id)");
    expect(sql).toContain("status in ('pending','converted','failed','expired')");
    expect(sql).toContain("status = 'pending'");
  });

  it("adds inspected media lineage, DB-clock leases, exact asset linkage, and bounded cleanup", async () => {
    const sql = await readFile(new URL("../migrations/046_mobile_media_share_capture.sql", import.meta.url), "utf8");
    const repository = await readFile(new URL("../src/postgres-share-capture-repository.ts", import.meta.url), "utf8");
    expect(sql).toContain("add column if not exists media jsonb");
    expect(sql).toContain("materialization_claim_expires_at timestamptz");
    expect(sql).toContain("foreign key (converted_media_asset_id) references media_assets(id)");
    expect(sql).toContain("where status in ('converted','expired','rejected','failed') and media is not null");
    expect(repository).toContain("materialization_claim_expires_at=clock_timestamp()+make_interval");
    expect(repository).toContain("materialization_claim_expires_at>clock_timestamp()");
    expect(repository).toContain("and expires_at>clock_timestamp()");
  });
});
