import { createAgentBoard, createOutboxMessage, observeAgentBoardDeactivated, observeAgentBoardPluginDecision, queueAgentBoardPluginDecision, queueAgentBoardReconcile, reviseAgentBoard, type Actor } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentBoardRepository } from "../src/postgres-agent-board-repository.js";
import { PostgresOutboxRepository } from "../src/postgres-outbox-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-board-integration";
const brandId = "brand-board-integration";
const owner: Actor = { id: "board-owner", name: "Board Owner", role: "owner" };
const at = "2026-09-07T10:00:00.000Z";

suite("Postgres agent Boards", () => {
  const sql = postgres(databaseUrl!);
  const boards = new PostgresAgentBoardRepository(sql);
  const outbox = new PostgresOutboxRepository(sql);
  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Board Integration','board-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Board Brand','board-brand','English','UTC','active',${owner.id},${at},${at}) on conflict(id) do nothing`;
  });
  afterAll(async () => {
    await sql`delete from outbox_events where workspace_id=${workspaceId}`;
    await sql`delete from board_agent_run_ledger where workspace_id=${workspaceId}`;
    await sql`delete from board_hermes_skill_grants where workspace_id=${workspaceId}`;
    await sql`delete from board_hermes_plugins where workspace_id=${workspaceId}`;
    await sql`delete from agent_boards where workspace_id=${workspaceId}`;
    await sql`delete from audit_events where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });
  it("atomically saves desired policy and its durable outbox command", async () => {
    const made = createAgentBoard({ workspaceId, brandId, name: "Mumbai", purpose: "Mumbai desk", pluginConfigured: true, actor: owner, now: at });
    const initial = createOutboxMessage({ workspaceId, topic: "board.plugin.reconcile", dedupeKey: `board-plugin:${made.board.id}:epoch:1`, payload: { workspaceId, brandId, boardId: made.board.id, configurationEpoch: 1 }, now: at });
    await boards.create(made.board, made.event, initial);
    const queued = queueAgentBoardReconcile({ current: made.board, actor: owner, expectedVersion: 1, desiredSkills: ["news-research"], now: "2026-09-07T10:01:00.000Z" });
    await expect(boards.update(queued.board, 1, queued.event, queued.outbox)).resolves.toMatchObject({ configurationEpoch: 2, desiredSkills: ["news-research"] });
    expect(await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='board.plugin.reconcile'`).toEqual([{ count: 2 }]);
    expect(await sql<{ desired_enabled: boolean; observed_enabled: boolean }[]>`select desired_enabled,observed_enabled from board_hermes_skill_grants where workspace_id=${workspaceId}`).toEqual([{ desired_enabled: true, observed_enabled: false }]);

    const pending = queueAgentBoardPluginDecision({ current: queued.board, actor: owner, subsystem: "memory", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64), idempotencyKey: "postgres-decision", decisionKey: "b".repeat(64), idempotencyScopeKey: "c".repeat(64), now: "2026-09-07T10:01:30.000Z" });
    await boards.update(pending.board, queued.board.version, pending.event, pending.outbox);
    await sql`update outbox_events set status='processed',processed_at=now() where workspace_id=${workspaceId} and topic='board.plugin.decision'`;
    await expect(outbox.recoverAgentBoardPlugins()).resolves.toBe(1);
    expect(await sql<{ status: string }[]>`select status from outbox_events where workspace_id=${workspaceId} and topic='board.plugin.decision'`).toEqual([{ status: "pending" }]);
    const completed = observeAgentBoardPluginDecision({ current: pending.board, decisionKey: "b".repeat(64), subsystem: "memory", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64), now: "2026-09-07T10:01:45.000Z" });
    await boards.update(completed.board, pending.board.version, completed.event, completed.outbox);
  });

  it("recovers archived runtime deactivation until the remote observation is recorded", async () => {
    const current = (await boards.list(workspaceId, brandId))[0]!;
    const archived = reviseAgentBoard({ current, actor: owner, expectedVersion: current.version, status: "archived", checkedAt: "2026-09-07T10:02:00.000Z" });
    await boards.update(archived.board, current.version, archived.event, archived.outbox);
    await sql`update outbox_events set status='processed',processed_at=now() where workspace_id=${workspaceId} and topic='board.plugin.deactivate'`;
    await expect(outbox.recoverAgentBoardPlugins()).resolves.toBe(1);
    expect(await sql<{ status: string }[]>`select status from outbox_events where workspace_id=${workspaceId} and topic='board.plugin.deactivate'`).toEqual([{ status: "pending" }]);

    const deactivated = observeAgentBoardDeactivated({ current: archived.board, configurationEpoch: archived.board.configurationEpoch, capabilityEpoch: archived.board.capabilityEpoch, now: "2026-09-07T10:03:00.000Z" });
    await boards.update(deactivated, archived.board.version, { id: "event-board-deactivated", workspaceId, actorId: "board-plugin-worker", actorType: "system", action: "agent-board.plugin-deactivated", detail: { boardId: deactivated.id }, createdAt: deactivated.updatedAt });
    await sql`update outbox_events set status='processed',processed_at=now() where workspace_id=${workspaceId} and topic='board.plugin.deactivate'`;
    await expect(outbox.recoverAgentBoardPlugins()).resolves.toBe(0);
  });
});
