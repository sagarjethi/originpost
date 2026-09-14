import { createAgentBoardTask, releaseAgentBoardTaskToAgent, reviseAgentBoardTask, type Actor } from "@originpost/domain";
import { describe, expect, it } from "vitest";
import { createContentRepository } from "../src/factory.js";

const owner: Actor = { id: "factory-board-owner", name: "Factory Board Owner", role: "owner" };

describe("in-memory Board task repository factory wiring", () => {
  it("delivers an atomic release command to the shared outbox", async () => {
    const infrastructure = await createContentRepository({});
    const now = new Date().toISOString();
    const made = createAgentBoardTask({ workspaceId: "factory-board-workspace", brandId: "factory-board-brand", boardId: "factory-board", title: "Prepare a draft", assignee: "board-agent", idempotencyKey: "factory-board-task-0001", actor: owner, now });
    await infrastructure.agentBoardTaskRepository.create(made.task, made.event);
    const todo = reviseAgentBoardTask({ current: made.task, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo", now });
    await infrastructure.agentBoardTaskRepository.update(todo.task, 1, todo.event);
    const ready = reviseAgentBoardTask({ current: todo.task, expectedVersion: 2, actor: owner, parentsComplete: true, status: "ready", now });
    await infrastructure.agentBoardTaskRepository.update(ready.task, 2, ready.event);
    const released = releaseAgentBoardTaskToAgent({ current: ready.task, expectedVersion: 3, configurationEpoch: 1, capabilityEpoch: 1, idempotencyKey: "factory-board-release-0001", parentsComplete: true, actor: owner, now });
    await infrastructure.agentBoardTaskRepository.releaseToAgent(released.task, 3, released.execution, released.event, released.outbox);

    expect(await infrastructure.outboxRepository.list(made.task.workspaceId)).toEqual([
      expect.objectContaining({ topic: "board.task.execute", dedupeKey: `board-task-execution:${released.execution.id}`, status: "pending" }),
    ]);
  });
});
