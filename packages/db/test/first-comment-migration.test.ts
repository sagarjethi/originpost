import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("first-comment migration", () => {
  it("installs exact lineage, append-only proof, and DB-clock lease fencing", async () => {
    const migration = await readFile(new URL("../migrations/047_first_comment_workflow.sql", import.meta.url), "utf8");
    const deferredTargetMigration = await readFile(new URL("../migrations/048_first_comment_target_fk_deferred.sql", import.meta.url), "utf8");
    const repository = await readFile(new URL("../src/postgres-first-comment-repository.ts", import.meta.url), "utf8");
    expect(migration).toContain("execution_mode text not null");
    expect(migration.indexOf("publish_targets_id_workspace_content_unique")).toBeLessThan(migration.indexOf("first_comment_target_fk"));
    expect(migration).toContain("first_comment_publish_proof_fk");
    expect(migration).toContain("first_comment_proofs_append_only");
    expect(migration).toContain("first_comment_one_active_target_idx");
    expect(migration).toContain("deferrable initially deferred");
    expect(deferredTargetMigration).toContain("drop constraint if exists first_comment_target_fk");
    expect(deferredTargetMigration).toContain("deferrable initially deferred");
    expect(repository).toContain("claim_expires_at>clock_timestamp()");
    expect(repository).not.toContain("claim_expires_at>${input.resolvedAt}");
  });
});
