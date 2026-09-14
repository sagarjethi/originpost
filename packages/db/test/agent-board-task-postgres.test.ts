import {
  createAgentBoard,
  createAgentBoardTask,
  createAgentBoardTaskComment,
  createAgentBoardTaskContentHandoff,
  finishAgentBoardTaskExecution,
  releaseAgentBoardTaskToAgent,
  reviseAgentBoardTask,
  type Actor,
} from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentBoardRepository } from "../src/postgres-agent-board-repository.js";
import { PostgresAgentBoardTaskRepository } from "../src/postgres-agent-board-task-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-board-task-integration";
const brandId = "brand-board-task-integration";
const owner: Actor = { id: "board-task-owner", name: "Board Task Owner", role: "owner" };
const at = "2026-09-13T08:00:00.000Z";

suite("Postgres Board tasks", () => {
  const sql = postgres(databaseUrl!);
  const boards = new PostgresAgentBoardRepository(sql);
  const tasks = new PostgresAgentBoardTaskRepository(sql);
  let boardId = "";

  async function cleanWorkspace() {
    await sql`delete from agent_board_task_comments where workspace_id=${workspaceId}`;
    await sql`delete from agent_board_task_links where workspace_id=${workspaceId}`;
    await sql`delete from board_task_content_handoffs where workspace_id=${workspaceId}`;
    await sql`delete from board_task_executions where workspace_id=${workspaceId}`;
    await sql`delete from agent_board_tasks where workspace_id=${workspaceId}`;
    await sql`delete from outbox_events where workspace_id=${workspaceId}`;
    await sql`delete from board_hermes_skill_grants where workspace_id=${workspaceId}`;
    await sql`delete from board_hermes_plugins where workspace_id=${workspaceId}`;
    await sql`delete from agent_boards where workspace_id=${workspaceId}`;
    await sql`delete from audit_events where workspace_id=${workspaceId}`;
    await sql`delete from content_items where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
  }

  beforeAll(async () => {
    await cleanWorkspace();
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Board Task Integration','board-task-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Board Task Brand','board-task-brand','English','UTC','active',${owner.id},${at},${at}) on conflict(id) do nothing`;
    const made = createAgentBoard({ workspaceId, brandId, name: "Mumbai Tasks", purpose: "Verified Mumbai coverage", pluginConfigured: false, actor: owner, now: at });
    await boards.create(made.board, made.event);
    boardId = made.board.id;
  });

  afterAll(async () => {
    await cleanWorkspace();
    await sql.end();
  });

  it("persists hashed-idempotent tasks and insert-only comments in full Board scope", async () => {
    const made = createAgentBoardTask({ workspaceId, brandId, boardId, title: "Verify Mumbai event", idempotencyKey: "postgres-board-task-0001", actor: owner, now: at });
    await tasks.create(made.task, made.event);
    expect(await tasks.get(workspaceId, brandId, boardId, made.task.id)).toMatchObject({ status: "triage", version: 1 });
    expect(await tasks.getByIdempotencyKey(workspaceId, brandId, boardId, made.task.idempotencyKeySha256)).toMatchObject({ id: made.task.id });
    expect(await tasks.get(workspaceId, "foreign-brand", boardId, made.task.id)).toBeNull();
    const comment = createAgentBoardTaskComment({ task: made.task, body: "Official event page saved.", idempotencyKey: "postgres-board-comment-0001", expectedTaskVersion: made.task.version, actor: owner, now: "2026-09-13T08:01:00.000Z" });
    await expect(tasks.appendComment(comment.comment, made.task.version, comment.event)).resolves.toBe(true);
    await expect(tasks.appendComment({ ...comment.comment, id: "agent_board_task_comment_other" }, 99, comment.event)).resolves.toBe(false);
    expect(await tasks.listComments(workspaceId, brandId, boardId, made.task.id)).toEqual([expect.objectContaining({ body: "Official event page saved." })]);
    expect(await tasks.getCommentByIdempotencyKey(workspaceId, brandId, boardId, made.task.id, comment.comment.idempotencyKeySha256)).toMatchObject({ id: comment.comment.id });
    await expect(tasks.appendComment({ ...comment.comment, id: "agent_board_task_comment_duplicate" }, made.task.version, comment.event)).rejects.toMatchObject({ code: "idempotency_key_conflict" });
  });

  it("serializes dependency graph changes so concurrent opposite edges cannot form a cycle", async () => {
    const first = createAgentBoardTask({ workspaceId, brandId, boardId, title: "Research", idempotencyKey: "postgres-board-task-0002", actor: owner, now: "2026-09-13T08:02:00.000Z" });
    const second = createAgentBoardTask({ workspaceId, brandId, boardId, title: "Draft", idempotencyKey: "postgres-board-task-0003", actor: owner, now: "2026-09-13T08:02:01.000Z" });
    await tasks.create(first.task, first.event);
    await tasks.create(second.task, second.event);
    const firstUpdate = reviseAgentBoardTask({ current: first.task, expectedVersion: 1, actor: owner, parentsComplete: true, parentTaskIds: [second.task.id] });
    const secondUpdate = reviseAgentBoardTask({ current: second.task, expectedVersion: 1, actor: owner, parentsComplete: true, parentTaskIds: [first.task.id] });
    const results = await Promise.allSettled([tasks.update(firstUpdate.task, 1, firstUpdate.event), tasks.update(secondUpdate.task, 1, secondUpdate.event)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "agent_board_task_dependency_cycle" } });
  });

  it("serializes Board archival ahead of task create, update, and comment mutations", async () => {
    async function freshBoard(suffix: string) {
      const made = createAgentBoard({ workspaceId, brandId, name: `Archive race ${suffix}`, purpose: "Exercise the Board read-only boundary", pluginConfigured: false, actor: owner, now: at });
      await boards.create(made.board, made.event);
      return made.board;
    }

    async function archiveBeforeMutation(board: Awaited<ReturnType<typeof freshBoard>>, mutate: () => Promise<unknown>) {
      let releaseArchive!: () => void;
      let reportLocked!: () => void;
      const release = new Promise<void>((resolve) => { releaseArchive = resolve; });
      const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
      const archive = sql.begin(async (transaction) => {
        await transaction`update agent_boards set status='archived',payload=jsonb_set(payload,'{status}','"archived"'::jsonb,true),updated_at=now() where workspace_id=${workspaceId} and brand_id=${brandId} and id=${board.id}`;
        reportLocked();
        await release;
      });
      await locked;
      const mutation = mutate();
      releaseArchive();
      await archive;
      await expect(mutation).rejects.toMatchObject({ code: "agent_board_archived", statusCode: 409 });
    }

    const createBoard = await freshBoard("create");
    const create = createAgentBoardTask({ workspaceId, brandId, boardId: createBoard.id, title: "Must not be created", idempotencyKey: "archive-create-race-0001", actor: owner, now: at });
    await archiveBeforeMutation(createBoard, () => tasks.create(create.task, create.event));

    const updateBoard = await freshBoard("update");
    const existing = createAgentBoardTask({ workspaceId, brandId, boardId: updateBoard.id, title: "Existing task", idempotencyKey: "archive-update-race-0001", actor: owner, now: at });
    await tasks.create(existing.task, existing.event);
    const revised = reviseAgentBoardTask({ current: existing.task, expectedVersion: 1, actor: owner, parentsComplete: true, title: "Must not change" });
    await archiveBeforeMutation(updateBoard, () => tasks.update(revised.task, 1, revised.event));

    const commentBoard = await freshBoard("comment");
    const discussed = createAgentBoardTask({ workspaceId, brandId, boardId: commentBoard.id, title: "Discussed task", idempotencyKey: "archive-comment-task-0001", actor: owner, now: at });
    await tasks.create(discussed.task, discussed.event);
    const comment = createAgentBoardTaskComment({ task: discussed.task, body: "Must not be added", idempotencyKey: "archive-comment-race-0001", expectedTaskVersion: 1, actor: owner, now: at });
    await archiveBeforeMutation(commentBoard, () => tasks.appendComment(comment.comment, 1, comment.event));
  });

  async function readyAgentTask(suffix: string) {
    const made = createAgentBoardTask({ workspaceId, brandId, boardId, title: `Hermes task ${suffix}`, assignee: "board-agent", idempotencyKey: `postgres-board-agent-${suffix}`, actor: owner, now: at });
    await tasks.create(made.task, made.event);
    const todo = reviseAgentBoardTask({ current: made.task, expectedVersion: made.task.version, actor: owner, parentsComplete: true, status: "todo", now: "2026-09-13T08:10:00.000Z" });
    await tasks.update(todo.task, made.task.version, todo.event);
    const ready = reviseAgentBoardTask({ current: todo.task, expectedVersion: todo.task.version, actor: owner, parentsComplete: true, status: "ready", now: "2026-09-13T08:11:00.000Z" });
    await tasks.update(ready.task, todo.task.version, ready.event);
    return ready.task;
  }

  it("atomically releases one execution with one outbox command and audit event", async () => {
    const ready = await readyAgentTask("release-0001");
    const release = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: ready.version, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "postgres-board-release-0001", parentsComplete: true, actor: owner, now: "2026-09-13T08:12:00.000Z" });
    const competing = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: ready.version, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "postgres-board-release-0002", parentsComplete: true, actor: owner, now: "2026-09-13T08:12:01.000Z" });
    const results = await Promise.all([
      tasks.releaseToAgent(release.task, ready.version, release.execution, release.event, release.outbox),
      tasks.releaseToAgent(competing.task, ready.version, competing.execution, competing.event, competing.outbox),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const storedTask = await tasks.get(workspaceId, brandId, boardId, ready.id);
    expect(storedTask).toMatchObject({ status: "running", assignee: "board-agent", activeExecutionId: expect.any(String) });
    const executions = await tasks.listExecutions(workspaceId, brandId, boardId, ready.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ status: "queued", taskVersion: storedTask!.version });
    expect(await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='board.task.execute' and payload->>'taskId'=${ready.id}`).toEqual([{ count: 1 }]);
    expect(await sql<{ count: number }[]>`select count(*)::int as count from audit_events where workspace_id=${workspaceId} and action='agent-board.task-released' and detail->>'taskId'=${ready.id}`).toEqual([{ count: 1 }]);
    expect(await tasks.getExecutionByIdempotencyKey(workspaceId, brandId, boardId, ready.id, executions[0]!.idempotencyKeySha256)).toMatchObject({ id: executions[0]!.id });
    await sql`update board_task_executions set created_at=clock_timestamp() where workspace_id=${workspaceId} and id=${executions[0]!.id}`;
  });

  it("fences execution completion by claim, version, and live database lease", async () => {
    const ready = await readyAgentTask("finish-0001");
    const release = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: ready.version, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "postgres-board-finish-0001", parentsComplete: true, actor: owner, now: "2026-09-13T08:20:00.000Z" });
    await tasks.releaseToAgent(release.task, ready.version, release.execution, release.event, release.outbox);
    await sql`update board_task_executions set created_at=clock_timestamp() where workspace_id=${workspaceId} and id=${release.execution.id}`;
    const claimId = "postgres-worker-claim-0001";
    const [first, second] = await Promise.all([
      tasks.claimExecution(workspaceId, brandId, boardId, ready.id, release.execution.id, claimId, 60),
      tasks.claimExecution(workspaceId, brandId, boardId, ready.id, release.execution.id, "postgres-worker-claim-0002", 60),
    ]);
    const claimed = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claimed?.execution).toMatchObject({ status: "running", claimId: expect.any(String), version: 2 });
    const finished = finishAgentBoardTaskExecution({ task: claimed!.task, execution: claimed!.execution, outcome: "succeeded", model: "hermes-test", resultText: "Drafted a source-grounded Mumbai event plan for human review.", inputTokens: 21, outputTokens: 34, latencyMs: 55, now: new Date(Date.parse(claimed!.execution.startedAt!) + 1_000).toISOString() });
    await expect(tasks.finishExecution(finished.task, claimed!.task.version, finished.execution, "wrong-worker-claim", finished.event)).resolves.toBe(false);
    await expect(tasks.finishExecution(finished.task, claimed!.task.version, finished.execution, claimed!.execution.claimId!, finished.event)).resolves.toBe(true);
    const storedTask = await tasks.get(workspaceId, brandId, boardId, ready.id);
    expect(storedTask).toMatchObject({ status: "review", lastExecutionId: release.execution.id });
    expect(storedTask).not.toHaveProperty("activeExecutionId");
    expect(await tasks.getExecution(workspaceId, brandId, boardId, ready.id, release.execution.id)).toMatchObject({ status: "succeeded", model: "hermes-test", responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/), inputTokens: 21, outputTokens: 34, latencyMs: 55 });
    await expect(tasks.finishExecution(finished.task, claimed!.task.version, finished.execution, claimed!.execution.claimId!, finished.event)).resolves.toBe(false);
  });

  it("recovers expired claims to uncertain and blocked without another outbox command", async () => {
    const ready = await readyAgentTask("recovery-0001");
    const release = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: ready.version, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "postgres-board-recovery-0001", parentsComplete: true, actor: owner, now: "2026-09-13T08:30:00.000Z" });
    await tasks.releaseToAgent(release.task, ready.version, release.execution, release.event, release.outbox);
    await sql`update board_task_executions set created_at=clock_timestamp() where workspace_id=${workspaceId} and id=${release.execution.id}`;
    const claimed = await tasks.claimExecution(workspaceId, brandId, boardId, ready.id, release.execution.id, "postgres-worker-recover-0001", 60);
    const databaseClock = (await sql<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now;
    const startedAt = new Date(databaseClock.getTime() - 61_000).toISOString();
    const leaseExpiresAt = new Date(databaseClock.getTime() - 1_000).toISOString();
    const expiredPayload = { ...claimed!.execution, startedAt, leaseExpiresAt, updatedAt: startedAt };
    await sql`update board_task_executions set started_at=${startedAt},lease_expires_at=${leaseExpiresAt},updated_at=${startedAt},payload=${sql.json(expiredPayload as never)} where workspace_id=${workspaceId} and id=${release.execution.id}`;
    const before = await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='board.task.execute' and payload->>'taskId'=${ready.id}`;
    await expect(tasks.recoverExpiredExecutions()).resolves.toBe(1);
    const storedTask = await tasks.get(workspaceId, brandId, boardId, ready.id);
    expect(storedTask).toMatchObject({ status: "blocked", lastExecutionId: release.execution.id, blockedReason: expect.stringContaining("lease expired") });
    expect(storedTask).not.toHaveProperty("activeExecutionId");
    const storedExecution = await tasks.getExecution(workspaceId, brandId, boardId, ready.id, release.execution.id);
    expect(storedExecution).toMatchObject({ status: "uncertain", errorCode: "execution_lease_expired" });
    expect(storedExecution).not.toHaveProperty("claimId");
    expect(storedExecution).not.toHaveProperty("leaseExpiresAt");
    expect(await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='board.task.execute' and payload->>'taskId'=${ready.id}`).toEqual(before);
    await expect(tasks.recoverExpiredExecutions()).resolves.toBe(0);
  });

  it("expires unclaimed queued executions to uncertain and blocked without requeue", async () => {
    const ready = await readyAgentTask("queue-timeout-0001");
    const release = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: ready.version, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "postgres-board-queue-timeout-0001", parentsComplete: true, actor: owner, now: "2026-09-13T08:40:00.000Z" });
    await tasks.releaseToAgent(release.task, ready.version, release.execution, release.event, release.outbox);
    await sql`update board_task_executions set created_at=clock_timestamp()-interval '16 minutes' where workspace_id=${workspaceId} and id=${release.execution.id}`;
    expect(await tasks.claimExecution(workspaceId, brandId, boardId, ready.id, release.execution.id, "postgres-worker-delayed-0001", 60)).toBeNull();
    const before = await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='board.task.execute' and payload->>'taskId'=${ready.id}`;
    await expect(tasks.recoverExpiredExecutions()).resolves.toBe(1);
    const storedTask = await tasks.get(workspaceId, brandId, boardId, ready.id);
    expect(storedTask).toMatchObject({ status: "blocked", lastExecutionId: release.execution.id, blockedReason: expect.stringContaining("not claimed in time") });
    expect(storedTask).not.toHaveProperty("activeExecutionId");
    const storedExecution = await tasks.getExecution(workspaceId, brandId, boardId, ready.id, release.execution.id);
    expect(storedExecution).toMatchObject({ status: "uncertain", errorCode: "execution_queue_timeout", startedAt: release.execution.createdAt });
    expect(await tasks.claimExecution(workspaceId, brandId, boardId, ready.id, release.execution.id, "postgres-worker-too-late-0001", 60)).toBeNull();
    expect(await sql<{ count: number }[]>`select count(*)::int as count from outbox_events where workspace_id=${workspaceId} and topic='board.task.execute' and payload->>'taskId'=${ready.id}`).toEqual(before);
  });

  it("atomically creates one inbox Content Item and its immutable succeeded-execution provenance", async () => {
    const ready = await readyAgentTask("content-handoff-0001");
    const release = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: ready.version, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "postgres-content-handoff-release-0001", parentsComplete: true, actor: owner, now: new Date().toISOString() });
    await tasks.releaseToAgent(release.task, ready.version, release.execution, release.event, release.outbox);
    const claimed = await tasks.claimExecution(workspaceId, brandId, boardId, ready.id, release.execution.id, "postgres-handoff-worker-0001", 60);
    const finished = finishAgentBoardTaskExecution({ task: claimed!.task, execution: claimed!.execution, outcome: "succeeded", model: "hermes-test", resultText: "A source-grounded Mumbai brief ready for editorial development.", now: new Date(Date.parse(claimed!.execution.startedAt!) + 1_000).toISOString() });
    await tasks.finishExecution(finished.task, claimed!.task.version, finished.execution, claimed!.execution.claimId!, finished.event);
    const made = createAgentBoardTaskContentHandoff({ task: finished.task, execution: finished.execution, expectedTaskVersion: finished.task.version, idempotencyKey: "postgres-content-handoff-0001", actor: owner, now: new Date(Date.parse(finished.execution.completedAt!) + 1_000).toISOString() });
    await expect(tasks.createContentHandoff(finished.task, finished.task.version, finished.execution, made.item, { ...made.handoff, idempotencyKeySha256: "invalid" }, made.event)).rejects.toBeTruthy();
    expect(await sql<{ count: number }[]>`select count(*)::int as count from content_items where workspace_id=${workspaceId} and id=${made.item.id}`).toEqual([{ count: 0 }]);
    await expect(tasks.createContentHandoff(finished.task, finished.task.version, finished.execution, made.item, made.handoff, made.event)).resolves.toBe(true);

    expect(await tasks.get(workspaceId, brandId, boardId, ready.id)).toMatchObject({ status: "review", version: finished.task.version });
    expect(await tasks.getContentHandoffByExecution(workspaceId, brandId, boardId, ready.id, finished.execution.id)).toMatchObject({ id: made.handoff.id, contentItemId: made.item.id, responseSha256: finished.execution.responseSha256 });
    expect(await tasks.getContentHandoffByIdempotencyKey(workspaceId, brandId, boardId, ready.id, made.handoff.idempotencyKeySha256)).toMatchObject({ id: made.handoff.id });
    expect(await sql<{ payload: { status: string; drafts: unknown[]; approvals: unknown[]; targets: unknown[]; publishAttempts: unknown[]; proofs: unknown[] } }[]>`select payload from content_items where workspace_id=${workspaceId} and id=${made.item.id}`).toEqual([{ payload: expect.objectContaining({ status: "inbox", drafts: [], approvals: [], targets: [], publishAttempts: [], proofs: [] }) }]);
    expect(await sql<{ action: string; content_item_id: string }[]>`select action,content_item_id from audit_events where workspace_id=${workspaceId} and content_item_id=${made.item.id}`).toEqual([{ action: "content.created-from-board-task", content_item_id: made.item.id }]);
    await expect(tasks.createContentHandoff(finished.task, finished.task.version, finished.execution, made.item, made.handoff, made.event)).rejects.toMatchObject({ code: "agent_board_task_execution_handoff_exists" });
    expect(await sql<{ count: number }[]>`select count(*)::int as count from content_items where workspace_id=${workspaceId} and id=${made.item.id}`).toEqual([{ count: 1 }]);
  });
});
