import { describe, expect, it } from "vitest";
import { agentBoardTaskContentHandoffFingerprint, agentBoardTaskCreateFingerprint, agentBoardTaskIdempotencyHash, createAgentBoardTask, createAgentBoardTaskComment, createAgentBoardTaskContentHandoff, finishAgentBoardTaskExecution, InMemoryAgentBoardTaskRepository, releaseAgentBoardTaskToAgent, reviseAgentBoardTask } from "../src/agent-board-task.js";
import { InMemoryContentItemRepository } from "../src/repository.js";

const owner = { id: "owner", name: "Board Owner", role: "owner" as const };
const creator = { id: "creator", name: "Board Creator", role: "creator" as const };
const manager = { id: "manager", name: "Board Manager", role: "manager" as const };
const base = { workspaceId: "workspace", brandId: "brand", boardId: "agent_board_123", title: "Verify Mumbai event", description: "Check the official event page and prepare a source-backed brief.", idempotencyKey: "mumbai-event-task-001", actor: owner, now: "2026-09-13T08:00:00.000Z" };

describe("agent Board tasks", () => {
  it("creates a human-gated triage task with only hashed idempotency material", () => {
    const made = createAgentBoardTask(base);
    expect(made.task).toMatchObject({ status: "triage", priority: "normal", assignee: "team", version: 1, parentTaskIds: [] });
    expect(made.task.id).toMatch(/^agent_board_task_[a-f0-9-]{36}$/u);
    expect(made.task.idempotencyKeySha256).toBe(agentBoardTaskIdempotencyHash(base.idempotencyKey));
    expect(JSON.stringify(made.task)).not.toContain(base.idempotencyKey);
    expect(made.task.createFingerprint).toBe(agentBoardTaskCreateFingerprint(base));
    expect(made.event).toMatchObject({ action: "agent-board.task-created", detail: { boardId: base.boardId, status: "triage" } });
  });

  it("waits in todo while a dependency is open and cannot be promoted early", async () => {
    const repository = new InMemoryAgentBoardTaskRepository();
    const parent = createAgentBoardTask(base);
    await repository.create(parent.task, parent.event);
    const child = createAgentBoardTask({ ...base, title: "Write post", parentTaskIds: [parent.task.id], idempotencyKey: "mumbai-event-task-002" });
    await repository.create(child.task, child.event);
    const todo = reviseAgentBoardTask({ current: child.task, expectedVersion: 1, actor: owner, parentsComplete: false, status: "todo" }).task;
    expect(todo.status).toBe("todo");
    expect(() => reviseAgentBoardTask({ current: todo, expectedVersion: 2, actor: owner, parentsComplete: false, status: "ready" })).toThrow(/dependencies/iu);
    expect(reviseAgentBoardTask({ current: todo, expectedVersion: 2, actor: owner, parentsComplete: true, status: "ready" }).task.status).toBe("ready");
  });

  it("enforces review-before-done, terminal completion, and a durable completion marker", () => {
    const triage = createAgentBoardTask(base).task;
    const todo = reviseAgentBoardTask({ current: triage, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo" }).task;
    const ready = reviseAgentBoardTask({ current: todo, expectedVersion: 2, actor: owner, parentsComplete: true, status: "ready" }).task;
    const running = reviseAgentBoardTask({ current: ready, expectedVersion: 3, actor: creator, parentsComplete: true, status: "running" }).task;
    expect(() => reviseAgentBoardTask({ current: running, expectedVersion: 4, actor: creator, parentsComplete: true, status: "done", resultSummary: "Verified" })).toThrow(/cannot move/iu);
    const review = reviseAgentBoardTask({ current: running, expectedVersion: 4, actor: creator, parentsComplete: true, status: "review", resultSummary: "Verified source brief" }).task;
    expect(() => reviseAgentBoardTask({ current: review, expectedVersion: 5, actor: creator, parentsComplete: true, status: "done" })).toThrow(/manager or owner/iu);
    expect(() => reviseAgentBoardTask({ current: review, expectedVersion: 5, actor: { ...owner, id: creator.id }, parentsComplete: true, status: "done" })).toThrow(/cannot be its sole approver/iu);
    const completed = reviseAgentBoardTask({ current: review, expectedVersion: 5, actor: manager, parentsComplete: true, status: "done", now: "2026-09-13T09:00:00.000Z" });
    const done = completed.task;
    expect(done.completedAt).toBe("2026-09-13T09:00:00.000Z");
    expect(done).toMatchObject({ implementedBy: creator.id, reviewedBy: manager.id });
    expect(completed.event.detail).toMatchObject({ approval: "approved", implementerId: creator.id, reviewerId: manager.id });
    expect(() => reviseAgentBoardTask({ current: done, expectedVersion: 6, actor: creator, parentsComplete: true, title: "Rewrite after approval" })).toThrow(/immutable/iu);
    expect(() => reviseAgentBoardTask({ current: done, expectedVersion: 6, actor: owner, parentsComplete: true, status: "review" })).toThrow(/immutable/iu);
    expect(() => reviseAgentBoardTask({ current: done, expectedVersion: 6, actor: owner, parentsComplete: true, status: "archived", title: "Rewrite during archive" })).toThrow(/without changing/iu);
    const archived = reviseAgentBoardTask({ current: done, expectedVersion: 6, actor: owner, parentsComplete: true, status: "archived" }).task;
    expect(archived.completedAt).toBe(done.completedAt);
    expect(() => reviseAgentBoardTask({ current: { ...review, resultSummary: undefined }, expectedVersion: 5, actor: manager, parentsComplete: true, status: "done" })).toThrow(/completion result/iu);
  });

  it("requires a reason when blocking and returns through todo", () => {
    const triage = createAgentBoardTask(base).task;
    const todoBeforeBlock = reviseAgentBoardTask({ current: triage, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo" }).task;
    expect(() => reviseAgentBoardTask({ current: todoBeforeBlock, expectedVersion: 2, actor: owner, parentsComplete: true, status: "blocked" })).toThrow(/why/iu);
    const blocked = reviseAgentBoardTask({ current: todoBeforeBlock, expectedVersion: 2, actor: owner, parentsComplete: true, status: "blocked", blockedReason: "Waiting for organizer confirmation" }).task;
    expect(blocked.blockedReason).toContain("organizer");
    const todo = reviseAgentBoardTask({ current: blocked, expectedVersion: 3, actor: owner, parentsComplete: true, status: "todo" }).task;
    expect(todo).not.toHaveProperty("blockedReason");
    expect(reviseAgentBoardTask({ current: todo, expectedVersion: 4, actor: owner, parentsComplete: true, status: "ready" }).task.status).toBe("ready");
  });

  it("records the implementer only when work starts, not on same-state edits", () => {
    const triage = createAgentBoardTask(base).task;
    const todo = reviseAgentBoardTask({ current: triage, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo" }).task;
    const ready = reviseAgentBoardTask({ current: todo, expectedVersion: 2, actor: owner, parentsComplete: true, status: "ready" }).task;
    const running = reviseAgentBoardTask({ current: ready, expectedVersion: 3, actor: creator, parentsComplete: true, status: "running" }).task;
    const edited = reviseAgentBoardTask({ current: running, expectedVersion: 4, actor: owner, parentsComplete: true, title: "Clarified while running" }).task;
    expect(edited.implementedBy).toBe(creator.id);
  });

  it("stores append-only comments in the complete Board scope", async () => {
    const repository = new InMemoryAgentBoardTaskRepository();
    const made = createAgentBoardTask(base);
    await repository.create(made.task, made.event);
    const created = createAgentBoardTaskComment({ task: made.task, body: "Organizer page confirms the date.", idempotencyKey: "board-comment-test-0001", expectedTaskVersion: made.task.version, actor: owner, now: "2026-09-13T08:10:00.000Z" });
    await repository.appendComment(created.comment, made.task.version, created.event);
    expect(await repository.listComments("workspace", "brand", base.boardId, made.task.id)).toEqual([expect.objectContaining({ body: "Organizer page confirms the date.", authorName: "Board Owner" })]);
    expect(await repository.listComments("workspace", "another-brand", base.boardId, made.task.id)).toEqual([]);
    expect(await repository.listComments("workspace", "brand", "another-board", made.task.id)).toEqual([]);
    expect(await repository.getCommentByIdempotencyKey("workspace", "brand", base.boardId, made.task.id, created.comment.idempotencyKeySha256)).toMatchObject({ id: created.comment.id });
    await expect(repository.appendComment({ ...created.comment, id: "agent_board_task_comment_other" }, made.task.version, created.event)).rejects.toMatchObject({ code: "idempotency_key_conflict" });
  });

  it("releases Board-agent work once, stores the exact receipt, and still requires human approval", async () => {
    const outbox: Array<{ topic: string }> = [];
    const repository = new InMemoryAgentBoardTaskRepository((messages)=>outbox.push(...messages), () => new Date("2026-09-13T08:10:30.000Z"));
    const made = createAgentBoardTask({ ...base, assignee: "board-agent" });
    await repository.create(made.task,made.event);
    const todo = reviseAgentBoardTask({ current:made.task,expectedVersion:1,actor:owner,parentsComplete:true,status:"todo" }).task;
    await repository.update(todo,1,made.event);
    const ready = reviseAgentBoardTask({ current:todo,expectedVersion:2,actor:owner,parentsComplete:true,status:"ready" }).task;
    await repository.update(ready,2,made.event);
    expect(() => reviseAgentBoardTask({ current:ready,expectedVersion:3,actor:owner,parentsComplete:true,status:"running" })).toThrow(/release/iu);
    expect(() => reviseAgentBoardTask({ current:ready,expectedVersion:3,actor:owner,parentsComplete:true,assignee:"team" })).toThrow(/assignment/iu);
    const released = releaseAgentBoardTaskToAgent({ current:ready,expectedVersion:3,configurationEpoch:2,capabilityEpoch:4,idempotencyKey:"release-board-task-0001",parentsComplete:true,actor:manager,now:"2026-09-13T08:10:00.000Z" });
    await expect(repository.releaseToAgent(released.task,3,released.execution,released.event,released.outbox)).resolves.toMatchObject({ task:{ status:"running",implementedBy:"board-agent" },execution:{ status:"queued" } });
    expect(outbox).toEqual([expect.objectContaining({topic:"board.task.execute"})]);
    await expect(repository.releaseToAgent(released.task,3,{...released.execution,id:"board_task_execution_other"},released.event,released.outbox)).resolves.toBeNull();
    const claimed = await repository.claimExecution("workspace","brand",base.boardId,released.task.id,released.execution.id,"worker-claim-00000001",120);
    expect(claimed?.execution.status).toBe("running");
    const finished = finishAgentBoardTaskExecution({ task:claimed!.task,execution:claimed!.execution,outcome:"succeeded",model:"gpt-5.5",resultText:"Verified source brief ready for review.",inputTokens:10,outputTokens:20,latencyMs:100,now:"2026-09-13T08:11:00.000Z" });
    await expect(repository.finishExecution(finished.task,claimed!.task.version,finished.execution,claimed!.execution.claimId!,finished.event)).resolves.toBe(true);
    expect(await repository.listExecutions("workspace","brand",base.boardId,released.task.id)).toEqual([expect.objectContaining({status:"succeeded",responseSha256:expect.stringMatching(/^[a-f0-9]{64}$/u),resultText:"Verified source brief ready for review."})]);
    const review = await repository.get("workspace","brand",base.boardId,released.task.id);
    expect(review).toMatchObject({status:"review",implementedBy:"board-agent",resultSummary:"Verified source brief ready for review."});
    const done = reviseAgentBoardTask({current:review!,expectedVersion:review!.version,actor:manager,parentsComplete:true,status:"done"}).task;
    expect(done).toMatchObject({status:"done",reviewedBy:"manager"});
  });

  it("hands the current succeeded receipt into an empty inbox Content Item with durable provenance", async () => {
    const content = new InMemoryContentItemRepository();
    const repository = new InMemoryAgentBoardTaskRepository(()=>undefined,()=>new Date("2026-09-13T08:10:30.000Z"),content);
    const made = createAgentBoardTask({ ...base, assignee: "board-agent" });
    await repository.create(made.task,made.event);
    const todo=reviseAgentBoardTask({current:made.task,expectedVersion:1,actor:owner,parentsComplete:true,status:"todo"}).task;await repository.update(todo,1,made.event);
    const ready=reviseAgentBoardTask({current:todo,expectedVersion:2,actor:owner,parentsComplete:true,status:"ready"}).task;await repository.update(ready,2,made.event);
    const released=releaseAgentBoardTaskToAgent({current:ready,expectedVersion:3,configurationEpoch:1,capabilityEpoch:1,idempotencyKey:"handoff-release-0001",parentsComplete:true,actor:owner,now:"2026-09-13T08:10:00.000Z"});
    await repository.releaseToAgent(released.task,3,released.execution,released.event,released.outbox);
    const claimed=await repository.claimExecution("workspace","brand",base.boardId,released.task.id,released.execution.id,"handoff-worker-claim-0001",120);
    const finished=finishAgentBoardTaskExecution({task:claimed!.task,execution:claimed!.execution,outcome:"succeeded",model:"gpt-5.5",resultText:"A source-grounded Mumbai event brief that still requires editorial work.",now:"2026-09-13T08:11:00.000Z"});
    await repository.finishExecution(finished.task,claimed!.task.version,finished.execution,claimed!.execution.claimId!,finished.event);
    expect(()=>createAgentBoardTaskContentHandoff({task:finished.task,execution:finished.execution,expectedTaskVersion:finished.task.version,idempotencyKey:"content-handoff-0001",actor:creator})).toThrow(/manager or owner/iu);
    const created=createAgentBoardTaskContentHandoff({task:finished.task,execution:finished.execution,expectedTaskVersion:finished.task.version,idempotencyKey:"content-handoff-0001",actor:manager,now:"2026-09-13T08:12:00.000Z"});
    expect(created.handoff.createFingerprint).toBe(agentBoardTaskContentHandoffFingerprint({task:finished.task,execution:finished.execution}));
    await expect(repository.createContentHandoff(finished.task,finished.task.version,finished.execution,created.item,created.handoff,created.event)).resolves.toBe(true);
    expect(await content.get("workspace",created.item.id)).toMatchObject({status:"inbox",title:base.title,summary:"A source-grounded Mumbai event brief that still requires editorial work.",drafts:[],approvals:[],targets:[],publishAttempts:[],proofs:[]});
    expect(await repository.getContentHandoffByExecution("workspace","brand",base.boardId,finished.task.id,finished.execution.id)).toMatchObject({contentItemId:created.item.id,responseSha256:finished.execution.responseSha256});
    expect(await repository.getContentHandoffByIdempotencyKey("workspace","brand",base.boardId,finished.task.id,created.handoff.idempotencyKeySha256)).toMatchObject({id:created.handoff.id});
    await expect(repository.createContentHandoff(finished.task,finished.task.version,finished.execution,created.item,created.handoff,created.event)).rejects.toMatchObject({code:"agent_board_task_execution_handoff_exists"});
  });

  it("turns an expired Board-agent lease into an uncertain human-visible block without requeueing", async () => {
    let now = new Date("2026-09-13T08:00:00.000Z");
    const repository = new InMemoryAgentBoardTaskRepository(()=>undefined,()=>now);
    const made = createAgentBoardTask({ ...base, assignee:"board-agent" });
    await repository.create(made.task,made.event);
    const todo=reviseAgentBoardTask({current:made.task,expectedVersion:1,actor:owner,parentsComplete:true,status:"todo"}).task;await repository.update(todo,1,made.event);
    const ready=reviseAgentBoardTask({current:todo,expectedVersion:2,actor:owner,parentsComplete:true,status:"ready"}).task;await repository.update(ready,2,made.event);
    const released=releaseAgentBoardTaskToAgent({current:ready,expectedVersion:3,configurationEpoch:1,capabilityEpoch:1,idempotencyKey:"release-board-task-0002",parentsComplete:true,actor:owner,now:now.toISOString()});
    await repository.releaseToAgent(released.task,3,released.execution,released.event,released.outbox);
    await repository.claimExecution("workspace","brand",base.boardId,released.task.id,released.execution.id,"worker-claim-00000002",30);
    now=new Date("2026-09-13T08:00:31.000Z");
    await expect(repository.recoverExpiredExecutions()).resolves.toBe(1);
    expect(await repository.get("workspace","brand",base.boardId,released.task.id)).toMatchObject({status:"blocked",blockedReason:expect.stringMatching(/expired/iu)});
    expect(await repository.listExecutions("workspace","brand",base.boardId,released.task.id)).toEqual([expect.objectContaining({status:"uncertain",errorCode:"execution_lease_expired"})]);
  });

  it("fences a Board-agent attempt that was never claimed instead of silently requeueing it", async () => {
    let now = new Date("2026-09-13T08:00:00.000Z");
    const repository = new InMemoryAgentBoardTaskRepository(()=>undefined,()=>now);
    const made = createAgentBoardTask({ ...base, assignee:"board-agent" });
    await repository.create(made.task,made.event);
    const todo=reviseAgentBoardTask({current:made.task,expectedVersion:1,actor:owner,parentsComplete:true,status:"todo"}).task;await repository.update(todo,1,made.event);
    const ready=reviseAgentBoardTask({current:todo,expectedVersion:2,actor:owner,parentsComplete:true,status:"ready"}).task;await repository.update(ready,2,made.event);
    const released=releaseAgentBoardTaskToAgent({current:ready,expectedVersion:3,configurationEpoch:1,capabilityEpoch:1,idempotencyKey:"release-board-task-0003",parentsComplete:true,actor:owner,now:now.toISOString()});
    await repository.releaseToAgent(released.task,3,released.execution,released.event,released.outbox);
    now=new Date("2026-09-13T08:15:01.000Z");
    await expect(repository.claimExecution("workspace","brand",base.boardId,released.task.id,released.execution.id,"worker-claim-too-late",30)).resolves.toBeNull();
    await expect(repository.recoverExpiredExecutions()).resolves.toBe(1);
    expect(await repository.get("workspace","brand",base.boardId,released.task.id)).toMatchObject({status:"blocked",blockedReason:expect.stringMatching(/not claimed/iu)});
    expect(await repository.listExecutions("workspace","brand",base.boardId,released.task.id)).toEqual([expect.objectContaining({status:"uncertain",errorCode:"execution_queue_timeout"})]);
  });

  it("looks up idempotency replays by hash and full scope", async () => {
    const repository = new InMemoryAgentBoardTaskRepository();
    const made = createAgentBoardTask(base);
    await repository.create(made.task, made.event);
    const replay = await repository.getByIdempotencyKey("workspace", "brand", base.boardId, agentBoardTaskIdempotencyHash(base.idempotencyKey));
    expect(replay?.createFingerprint).toBe(agentBoardTaskCreateFingerprint(base));
    expect(await repository.getByIdempotencyKey("workspace", "other-brand", base.boardId, agentBoardTaskIdempotencyHash(base.idempotencyKey))).toBeNull();
    expect(agentBoardTaskCreateFingerprint({ ...base, title: "Different work" })).not.toBe(replay?.createFingerprint);
  });

  it("rejects duplicate, cross-Board, self, and cyclic dependencies", async () => {
    const repository = new InMemoryAgentBoardTaskRepository();
    const first = createAgentBoardTask(base);
    const second = createAgentBoardTask({ ...base, title: "Second", idempotencyKey: "mumbai-event-task-002" });
    await repository.create(first.task, first.event);
    await repository.create(second.task, second.event);
    expect(() => createAgentBoardTask({ ...base, parentTaskIds: [first.task.id, first.task.id] })).toThrow(/repeated/iu);
    const foreign = createAgentBoardTask({ ...base, boardId: "agent_board_other", title: "Foreign", idempotencyKey: "mumbai-event-task-003" });
    await repository.create(foreign.task, foreign.event);
    const crossBoard = createAgentBoardTask({ ...base, title: "Cross", parentTaskIds: [foreign.task.id], idempotencyKey: "mumbai-event-task-004" });
    await expect(repository.create(crossBoard.task, crossBoard.event)).rejects.toThrow(/does not exist/iu);
    const firstAfter = reviseAgentBoardTask({ current: first.task, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo" });
    await repository.update(firstAfter.task, 1, firstAfter.event);
    const self = reviseAgentBoardTask({ current: firstAfter.task, expectedVersion: 2, actor: owner, parentsComplete: true, parentTaskIds: [first.task.id] });
    await expect(repository.update(self.task, 2, self.event)).rejects.toThrow(/does not exist/iu);
    const firstDependsOnSecond = reviseAgentBoardTask({ current: firstAfter.task, expectedVersion: 2, actor: owner, parentsComplete: true, parentTaskIds: [second.task.id] });
    await repository.update(firstDependsOnSecond.task, 2, firstDependsOnSecond.event);
    const secondTodo = reviseAgentBoardTask({ current: second.task, expectedVersion: 1, actor: owner, parentsComplete: true, status: "todo" });
    await repository.update(secondTodo.task, 1, secondTodo.event);
    const cycle = reviseAgentBoardTask({ current: secondTodo.task, expectedVersion: 2, actor: owner, parentsComplete: true, parentTaskIds: [first.task.id] });
    await expect(repository.update(cycle.task, 2, cycle.event)).rejects.toThrow(/cycle/iu);
  });
});
