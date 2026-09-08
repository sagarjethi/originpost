import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("provider lifecycle migrations", () => {
  it("keeps authorizations separate from accounts and stores only keyed lookup values", async () => {
    const sql = await readFile(new URL("../migrations/053_provider_grants.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table if not exists provider_grants");
    expect(sql).toContain("subject_lookup_hmac");
    expect(sql).toContain("refresh_token_lookup_hmac");
    expect(sql).toContain("create table if not exists provider_grant_accounts");
    expect(sql).toContain("where unlinked_at is null");
    expect(sql).not.toContain("access_token");
    expect(sql).not.toContain("refresh_token text");
  });

  it("makes callback receipts and deletion scopes durable and recoverable", async () => {
    const sql = await readFile(new URL("../migrations/054_provider_callbacks_and_deletion.sql", import.meta.url), "utf8");
    expect(sql).toContain("provider_lifecycle_receipts");
    expect(sql).toContain("provider_data_deletion_requests");
    expect(sql).toContain("provider_data_deletion_scopes");
    expect(sql).toContain("confirmation_code_sha256");
    expect(sql).not.toContain("signed_request");
  });

  it("allows only tombstone-time private provider-key replacement", async () => {
    const sql = await readFile(new URL("../migrations/055_private_provider_erasure.sql", import.meta.url), "utf8");
    expect(sql).toContain("and new.tombstoned_at is null");
    expect(sql).toContain("provider_message_key_envelope");
    expect(sql).toContain("guard_private_message_immutability");
  });
});
