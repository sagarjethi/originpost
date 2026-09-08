import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent Board migration", () => {
  it("keeps Board, plugin, grants, runs, and recovery state durable", async () => {
    const sql = await readFile(new URL("../migrations/051_agent_boards.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table if not exists agent_boards");
    expect(sql).toContain("agent_boards_active_slug_unique");
    expect(sql).toContain("create table if not exists board_hermes_plugins");
    expect(sql).toContain("desired_configuration_epoch");
    expect(sql).toContain("observed_configuration_epoch");
    expect(sql).toContain("create table if not exists board_hermes_skill_grants");
    expect(sql).toContain("trust = 'operator-approved'");
    expect(sql).toContain("create table if not exists board_agent_run_ledger");
    expect(sql).toContain("request_sha256");
  });

  it("globally reserves every opaque Hermes profile for exactly one Board", async () => {
    const sql = await readFile(new URL("../migrations/056_agent_board_profile_global_uniqueness.sql", import.meta.url), "utf8");
    expect(sql).toContain("board_hermes_plugins_profile_ref_unique");
    expect(sql).toContain("on board_hermes_plugins(profile_ref)");
  });
});
