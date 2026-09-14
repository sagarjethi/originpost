import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentPostRepository } from "../src/postgres-agent-post-repository.js";
import type { AgentPostRun } from "@originpost/domain";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("durable external image handoff", () => {
  const sql = postgres(url!, { max: 1 });
  const schema = `post_test_${randomUUID().replaceAll("-", "")}`;
  const repo = new PostgresAgentPostRepository(sql);
  beforeAll(async () => {
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}`);
    await sql`create table agent_run_ledger (feature text not null check (feature='draft_assist'))`;
    for (const name of [
      "066_agent_post_runs.sql",
      "067_agent_post_external_images.sql",
      "068_agent_post_copy_review.sql",
      "069_agent_post_image_review.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
  });
  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });
  it("persists waiting state, excludes it from polling and allows exactly one versioned continuation", async () => {
    const now = new Date().toISOString();
    const run: AgentPostRun = {
      id: "post",
      workspaceId: "w",
      brandId: "b",
      version: 1,
      status: "awaiting-image",
      imageMode: "codex-upload",
      createdAt: now,
      updatedAt: now,
      createdBy: "editor",
      fingerprint: "request",
      input: "Verified library story",
      sourceLead: {
        id: "signal_original",
        version: 3,
        title: "Library",
        summary: "Lead",
        capturedAt: now,
        sources: [
          {
            id: "source_original",
            kind: "url",
            title: "Original",
            url: "https://example.org/news",
            capturedAt: now,
            rights: "reference-only",
            confidence: 0,
          },
        ],
      },
      contentItemId: "content",
      template: {
        id: "template",
        workspaceId: "w",
        brandId: "b",
        createdAt: now,
        createdBy: "editor",
        name: "News",
        language: "English",
        format: "portrait",
        layout: "headline",
        palette: ["#000000", "#000000", "#FFFFFF", "#FFFFFF", "#FFFF00"],
        logoMediaId: "logo",
        logo: { mediaId: "logo", sha256: "a".repeat(64) },
        logoPosition: "top-left",
        logoWidth: 18,
        logoMargin: 4,
        logoBackground: "#FFFFFF",
        logoCrop: "full",
        references: [],
        referenceMediaIds: [],
        styleInstructions: "Editorial",
        footer: "Publisher",
      },
    };
    await repo.create(run);
    expect((await repo.get("w", "post"))?.sourceLead).toEqual(run.sourceLead);
    expect((await repo.get("w", "post"))?.status).toBe("awaiting-image");
    expect(await repo.pending()).toEqual([]);
    const next: AgentPostRun = {
      ...run,
      status: "generating",
      version: 2,
      externalImage: {
        mediaId: "image",
        sha256: "b".repeat(64),
        briefHash: "c".repeat(64),
        importedAt: now,
        importedBy: "editor",
      },
    };
    const results = await Promise.all([
      repo.replace(next, 1),
      repo.replace(next, 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.pending()).map((r) => r.id)).toEqual(["post"]);
    expect(await repo.referencesAsset("w", "image")).toBe(true);
    expect(await repo.referencesAsset("other", "image")).toBe(false);
    expect(await repo.get("other", "post")).toBeNull();
    const reviewing = {
      ...next,
      status: "reviewing-copy" as const,
      version: 3,
    };
    expect(await repo.replace(reviewing, 2)).toBe(true);
    expect((await repo.pending())[0]?.status).toBe("reviewing-copy");
    const visual = {
      ...reviewing,
      status: "reviewing-image" as const,
      version: 4,
    };
    expect(await repo.replace(visual, 3)).toBe(true);
    expect((await repo.pending())[0]?.status).toBe("reviewing-image");
    await sql`insert into agent_run_ledger (feature) values ('image_review')`;
    await sql`delete from agent_run_ledger`;
    await sql`insert into agent_run_ledger (feature) values ('copy_review')`;
    expect((await sql`select feature from agent_run_ledger`)[0]?.feature).toBe(
      "copy_review",
    );
  });
});
