import { describe, expect, it, vi } from "vitest";
import type { BoardRuntimePort } from "@originpost/agents";
import {
  createAgentBoard,
  createAgentBoardTask,
  InMemoryAgentBoardRepository,
  InMemoryAgentBoardTaskRepository,
  observeAgentBoardPlugin,
  releaseAgentBoardTaskToAgent,
  reviseAgentBoardTask,
  type AgentBoard,
} from "@originpost/domain";
import { processBoardTaskExecution, type BoardTaskExecutionJob } from "../src/board-task-execution-worker.js";

const owner = { id: "owner", name: "Owner", role: "owner" as const };

async function setup(executeTask: ReturnType<typeof vi.fn>) {
  const boards = new InMemoryAgentBoardRepository();
  const tasks = new InMemoryAgentBoardTaskRepository();
  const madeBoard = createAgentBoard({ workspaceId: "w", brandId: "b", name: "Mumbai", purpose: "Prepare verified Mumbai event coverage.", pluginConfigured: true, actor: owner });
  await boards.create(madeBoard.board, madeBoard.event);
  const observed = observeAgentBoardPlugin({ current: madeBoard.board, configurationEpoch: 1, healthy: true });
  await boards.update(observed, madeBoard.board.version, { id: "evt-ready", workspaceId: "w", actorId: "system", actorType: "system", action: "ready", detail: {}, createdAt: observed.updatedAt });
  const board = await boards.get("w", madeBoard.board.id) as AgentBoard;
  const madeTask = createAgentBoardTask({ workspaceId: "w", brandId: "b", boardId: board.id, title: "Prepare source brief", description: "Return evidence and a draft for review; do not publish.", assignee: "board-agent", idempotencyKey: "mumbai-worker-task-0001", actor: owner });
  await tasks.create(madeTask.task, madeTask.event);
  const todo = reviseAgentBoardTask({ current: madeTask.task, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo" }).task;
  await tasks.update(todo, 1, madeTask.event);
  const ready = reviseAgentBoardTask({ current: todo, expectedVersion: 2, actor: owner, parentsComplete: true, status: "ready" }).task;
  await tasks.update(ready, 2, madeTask.event);
  const released = releaseAgentBoardTaskToAgent({ current: ready, expectedVersion: 3, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch, idempotencyKey: "mumbai-worker-release-01", parentsComplete: true, actor: owner });
  await tasks.releaseToAgent(released.task, 3, released.execution, released.event, released.outbox);
  const runtime = { inspect: vi.fn(), reconcile: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn(), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn(), run: vi.fn(), executeTask } as unknown as BoardRuntimePort;
  const job: BoardTaskExecutionJob = { workspaceId: "w", brandId: "b", boardId: board.id, taskId: ready.id, executionId: released.execution.id, taskVersion: released.task.version, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch };
  const dependencies = { boards, tasks, runtime, secret: "x".repeat(32), organizations: { getBrand: vi.fn().mockResolvedValue({ workspaceId: "w", id: "b", status: "active" }) } };
  return { board, tasks, runtime, job, dependencies };
}

describe("Board task execution worker", () => {
  it("stores a Hermes result in review without approving or publishing it", async () => {
    const harness = await setup(vi.fn().mockResolvedValue({ model: "gpt-5.5", text: "Source-backed brief ready for human review.", outcome: "review" }));
    await expect(processBoardTaskExecution(harness.job, harness.dependencies)).resolves.toEqual({ skipped: false, outcome: "succeeded" });
    expect(harness.runtime.executeTask).toHaveBeenCalledWith(expect.objectContaining({ profile: harness.board.hermesProfile, kanbanBoardRef: harness.board.hermesBoardRef }), expect.objectContaining({ taskId: harness.job.taskId, executionId: harness.job.executionId, enabledSkills: [] }));
    const reviewTask = await harness.tasks.get("w", "b", harness.board.id, harness.job.taskId);
    expect(reviewTask).toMatchObject({ status: "review", implementedBy: "board-agent" });
    expect(reviewTask).not.toHaveProperty("reviewedBy");
    await expect(harness.tasks.listExecutions("w", "b", harness.board.id, harness.job.taskId)).resolves.toEqual([expect.objectContaining({ status: "succeeded", resultText: "Source-backed brief ready for human review." })]);
  });

  it("fences an unconfirmed Hermes call as uncertain and never retries it automatically", async () => {
    const harness = await setup(vi.fn().mockRejectedValue(new Error("connection closed after submit")));
    await expect(processBoardTaskExecution(harness.job, harness.dependencies)).resolves.toEqual({ skipped: false, outcome: "uncertain" });
    expect(harness.runtime.executeTask).toHaveBeenCalledTimes(1);
    await expect(harness.tasks.get("w", "b", harness.board.id, harness.job.taskId)).resolves.toMatchObject({ status: "blocked", blockedReason: expect.stringMatching(/confirmed (result|receipt)/iu) });
    await expect(processBoardTaskExecution(harness.job, harness.dependencies)).resolves.toEqual({ skipped: true, reason: "claim-unavailable" });
    expect(harness.runtime.executeTask).toHaveBeenCalledTimes(1);
  });
});
