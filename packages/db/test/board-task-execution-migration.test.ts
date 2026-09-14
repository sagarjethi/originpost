import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Board task execution migration", () => {
  it("persists the opaque Kanban binding and a fenced execution receipt", async () => {
    const sql = await readFile(new URL("../migrations/064_board_task_execution.sql", import.meta.url), "utf8");
    expect(sql).toContain("kanban_ref text");
    expect(sql).toContain("board_hermes_plugins_kanban_ref_unique");
    expect(sql).toContain("on board_hermes_plugins(kanban_ref)");
    expect(sql).toContain("create table if not exists board_task_executions");
    expect(sql).toContain("board_task_executions_idempotency_unique");
    expect(sql).toContain("board_task_executions_state_shape");
    expect(sql).toContain("board_task_executions_payload_shape");
    expect(sql).toContain("result_text text");
    expect(sql).toContain("input_tokens integer");
    expect(sql).toContain("status in ('failed','uncertain')");
    expect(sql).toContain("board_task_executions_queued_recovery_idx");
    expect(sql).toContain("where status='queued'");
  });
});
