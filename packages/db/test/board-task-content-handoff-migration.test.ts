import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Board task Content handoff migration", () => {
  it("links one exact succeeded execution to one normal Content Item", async () => {
    const sql = await readFile(new URL("../migrations/065_board_task_content_handoffs.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table board_task_content_handoffs");
    expect(sql).toContain("board_task_content_handoffs_execution_fk");
    expect(sql).toContain("board_task_content_handoffs_content_fk");
    expect(sql).toContain("board_task_content_handoffs_execution_unique");
    expect(sql).toContain("board_task_content_handoffs_idempotency_unique");
    expect(sql).toContain("response_sha256");
    expect(sql).toContain("board_task_content_handoffs_payload_shape");
    expect(sql).toContain("payload->>'createdBy'=created_by");
    expect(sql).toContain("(payload->>'createdAt')::timestamptz=created_at");
  });
});
