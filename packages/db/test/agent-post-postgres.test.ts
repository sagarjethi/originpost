import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentPostRepository } from "../src/postgres-agent-post-repository.js";
import type { AgentPostRun, AgentPostTemplate } from "@originpost/domain";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("news post migration and persistence", () => {
  const sql = postgres(url!, { max: 1 });
  const schema = `post_test_${randomUUID().replaceAll("-", "")}`;
  const repo = new PostgresAgentPostRepository(sql);
  const template: AgentPostTemplate = {
    id: "template",
    workspaceId: "w",
    brandId: "b",
    createdBy: "u",
    createdAt: new Date().toISOString(),
    name: "News",
    language: "English",
    format: "square",
    layout: "headline",
    palette: ["#000000", "#111111", "#FFFFFF", "#FFFFFF", "#FFFF00"],
    logoMediaId: "logo",
    logo: { mediaId: "logo", sha256: "a".repeat(64) },
    logoBackground: "#FFFFFF",
    logoCrop: "full",
    logoPosition: "top-left",
    logoWidth: 15,
    logoMargin: 3,
    referenceMediaIds: ["ref"],
    references: [{ mediaId: "ref", sha256: "b".repeat(64) }],
    styleInstructions: "",
    footer: "",
  };
  beforeAll(async () => {
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}`);
    await sql.unsafe(
      await readFile(
        new URL("../migrations/066_agent_post_runs.sql", import.meta.url),
        "utf8",
      ),
    );
  });
  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });
  it("persists scoped immutable templates, request dedupe, and a single worker claim", async () => {
    await repo.saveTemplate(template);
    expect(await repo.template("other", "template")).toBeNull();
    expect(await repo.referencesAsset("w", "logo")).toBe(true);
    expect(await repo.referencesAsset("w", "ref")).toBe(true);
    expect(await repo.referencesAsset("other", "ref")).toBe(false);
    const run: AgentPostRun = {
      id: "run",
      workspaceId: "w",
      brandId: "b",
      createdBy: "u",
      createdAt: template.createdAt,
      updatedAt: template.createdAt,
      version: 1,
      fingerprint: "original",
      input: "News",
      template,
      status: "queued",
      contentItemId: "content",
    };
    await repo.create(run);
    expect(await repo.create({ ...run, status: "ready" })).toMatchObject({
      status: "queued",
    });
    await expect(
      repo.create({ ...run, fingerprint: "changed" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      await Promise.all([
        repo.replace({ ...run, version: 2, status: "researching" }, 1),
        repo.replace({ ...run, version: 2, status: "writing" }, 1),
      ]),
    ).toEqual([true, false]);
    expect(await repo.get("other", "run")).toBeNull();
    expect(await repo.pending()).toHaveLength(1);
  });
});
