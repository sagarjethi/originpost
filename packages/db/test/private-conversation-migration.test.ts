import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("private conversation migration", () => {
  it("stores provider references and bodies as envelopes plus keyed lookup values", async () => {
    const sql = await readFile(new URL("../migrations/037_private_conversations.sql", import.meta.url), "utf8");
    expect(sql).toContain("provider_conversation_key_hash");
    expect(sql).toContain("provider_conversation_key_envelope jsonb not null");
    expect(sql).toContain("body_integrity_key");
    expect(sql).not.toContain("body_sha256");
    expect(sql).toContain("private_reply_body_retention_check");
  });

  it("fences provider writes, preserves immutable evidence, and widens notifications", async () => {
    const sql = await readFile(new URL("../migrations/037_private_conversations.sql", import.meta.url), "utf8");
    expect(sql).toContain("lease_fence bigint not null");
    expect(sql).toContain("private_reply_one_provider_write_idx");
    expect(sql).toContain("private_reply_intent_events is append-only");
    expect(sql).toContain("private_messages_immutable");
    expect(sql).toContain("'private_message_new_activity'");
    expect(sql).toContain("'private_message_reply_failed'");
    expect(sql).toContain("'private_message_permission_missing'");
  });
});
