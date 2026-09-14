import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { BoardsService } from "../src/boards/boards.service.js";
import { finishAgentBoardTaskExecution, InMemoryAgentBoardRepository, InMemoryAgentBoardTaskRepository, InMemoryContentItemRepository, observeAgentBoardPlugin, queueAgentBoardReconcile, type AgentBoard, type AuditEvent } from "@originpost/domain";
import type { BoardRuntimePort } from "@originpost/agents";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

const owner = { id: "owner", name: "Owner", role: "owner" as const };
const manager = { id: "manager", name: "Manager", role: "manager" as const };
const creator = { id: "creator", name: "Creator", role: "creator" as const };
const observation = { healthy: true, configured: true, policyCompliant: true, modelReady: true, version: "0.21.2", model: "hermes-agent", memory: { isolation: "dedicated-profile" as const, enabled: true, writeApproval: true }, isolation: { mode: "profile-scoped" as const, verified: true, profileScoped: true, memoryScoped: true, skillsScoped: true, stateScoped: true, externalSkillsBlocked: true, unsafeToolsBlocked: true, filesystemSandbox: false as const }, skills: [{ name: "news-research", description: "Verified source research", category: "news", enabled: false, provenance: "bundled" as const, approved: true, userManageable: true }, { name: "unsafe-skill", description: "", category: "other", enabled: false, provenance: "hub" as const, approved: false, userManageable: true }], safeToolsets: ["memory"], restartRequired: false };

function setup(runtime: BoardRuntimePort | null = { inspect: vi.fn().mockResolvedValue(observation), reconcile: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn().mockResolvedValue([]), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn(), run: vi.fn().mockResolvedValue({ model: "hermes-agent", text: "Mumbai summary" }), executeTask: vi.fn().mockResolvedValue({ model: "hermes-agent", text: "Mumbai task result", outcome: "review" as const }) }) {
  const outbox: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const boards = new InMemoryAgentBoardRepository((messages) => outbox.push(...messages));
  const repository = new InMemoryContentItemRepository();
  const tasks = new InMemoryAgentBoardTaskRepository((messages) => outbox.push(...messages), undefined, repository);
  const infrastructure = {
    repository,
    agentBoardRepository: boards,
    agentBoardTaskRepository: tasks,
    boardRuntime: runtime,
    organizationRepository: { getBrand: vi.fn().mockResolvedValue({ id: "brand", workspaceId: "workspace", status: "active" }) },
  } as unknown as OriginPostInfrastructure;
  const service = new BoardsService(infrastructure, new ConfigService({ HERMES_BOARD_SECRET: "x".repeat(32) }));
  return { service, boards, tasks, repository, runtime, outbox };
}

describe("BoardsService", () => {
  it("creates a top-level Board but returns no Hermes profile or secrets", async () => {
    const { service } = setup();
    const result = await service.create("workspace", { brandId: "brand", name: "Mumbai events", purpose: "Plan verified Mumbai event coverage." }, owner);
    expect(result.board).toMatchObject({ name: "Mumbai events", status: "provisioning", memoryIsolation: "dedicated-profile" });
    expect(JSON.stringify(result)).not.toMatch(/hermesProfile|apiKey|memoryScope|profile_ref|kanban/iu);
  });

  it("keeps skills inside the plugin and queues owner-approved desired state", async () => {
    const { service, boards, runtime } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const plugin = await service.plugin("workspace", "brand", created.board.id, owner);
    expect(plugin.skills).toEqual([expect.objectContaining({ name: "news-research", enabled: false })]);
    expect(plugin.isolation).toEqual({ mode: "profile-scoped", verified: true, profileScoped: true, memoryScoped: true, skillsScoped: true, stateScoped: true, externalSkillsBlocked: true, unsafeToolsBlocked: true, filesystemSandbox: false });
    expect(JSON.stringify(plugin)).not.toContain("unsafe-skill");
    const updated = await service.skill("workspace", "brand", created.board.id, 1, { brandId: "brand", name: "news-research", enabled: true }, owner);
    expect(updated).toMatchObject({ pending: true, desiredSkills: ["news-research"] });
    expect((runtime?.reconcile as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(await boards.get("workspace", created.board.id)).toMatchObject({ status: "provisioning", configurationEpoch: 2, capabilityEpoch: 2 });
  });

  it("keeps pending-write review inside the Board and requires an exact idempotent owner decision", async () => {
    const { service, runtime } = setup();
    const pending = { id: "a1b2c3d4", subsystem: "memory" as const, action: "add", summary: "Remember Mumbai", origin: "foreground" as const, createdAt: 1_788_000_000, sha256: "a".repeat(64) };
    (runtime?.listPendingWrites as ReturnType<typeof vi.fn>).mockResolvedValueOnce([pending]);
    (runtime?.pendingWriteDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...pending, detail: '{"content":"Mumbai"}', detailTruncated: false });
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    await expect(service.plugin("workspace", "brand", created.board.id, owner)).resolves.toMatchObject({ pendingManagementAvailable: true, pendingWrites: [pending] });
    await expect(service.pendingWrite("workspace", "brand", created.board.id, "memory", pending.id, owner)).resolves.toMatchObject({ pendingWrite: { detailTruncated: false } });
    await expect(service.decidePendingWrite("workspace", "brand", created.board.id, "memory", pending.id, { brandId: "brand", decision: "approve", expectedSha256: pending.sha256 }, "test-test-test-test", owner)).resolves.toMatchObject({ ok: true, queued: true, pending: true, decisionKey: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(runtime?.decidePendingWrite).not.toHaveBeenCalled();
  });

  it("durably queues a skill-file decision before Hermes mutates anything", async () => {
    const { service, boards, runtime, outbox } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const result = await service.decidePendingWrite("workspace", "brand", created.board.id, "skills", "a1b2c3d4", { brandId: "brand", decision: "approve", expectedSha256: "a".repeat(64) }, "test-skill-reseal", owner);
    expect(result).toMatchObject({ ok: true, queued: true, pending: true, decisionKey: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(runtime?.decidePendingWrite).not.toHaveBeenCalled();
    expect(await boards.get("workspace", created.board.id)).toMatchObject({ version: 2, configurationEpoch: 1, capabilityEpoch: 1, status: "provisioning", pendingPluginDecision: { subsystem: "skills", pendingId: "a1b2c3d4", decision: "approve" } });
    expect(outbox.at(-1)).toMatchObject({ topic: "board.plugin.decision", payload: { boardId: created.board.id, subsystem: "skills", pendingId: "a1b2c3d4" } });
  });

  it("allows an owner to remove a skill while Hermes is unavailable", async () => {
    const { service, boards, runtime } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const enabled = await service.skill("workspace", "brand", created.board.id, 1, { brandId: "brand", name: "news-research", enabled: true }, owner);
    (runtime?.inspect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    const disabled = await service.skill("workspace", "brand", created.board.id, enabled.board.version, { brandId: "brand", name: "news-research", enabled: false }, owner);
    expect(disabled.desiredSkills).toEqual([]);
    expect(await boards.get("workspace", created.board.id)).toMatchObject({ desiredSkills: [], capabilityEpoch: 3 });
  });

  it("runs only a ready Board and records hashes rather than prompt bodies", async () => {
    const { service, boards, runtime } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const current = await boards.get("workspace", created.board.id) as AgentBoard;
    const ready = observeAgentBoardPlugin({ current, configurationEpoch: 1, healthy: true });
    const event: AuditEvent = { id: "evt-ready", workspaceId: "workspace", actorId: "system", actorType: "system", action: "ready", detail: {}, createdAt: ready.updatedAt };
    await boards.update(ready, current.version, event);
    const result = await service.run("workspace", "brand", created.board.id, "private prompt body", owner);
    expect(result.text).toBe("Mumbai summary");
    expect(runtime?.run).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.stringMatching(/^opb_/), memoryScope: expect.stringMatching(/^opb_mem_/) }), expect.objectContaining({ prompt: "private prompt body", purpose: "Mumbai desk.", enabledSkills: [] }));
    const [run] = await boards.listRuns("workspace", created.board.id);
    expect(run?.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(run)).not.toContain("private prompt body");
  });

  it("discards a Hermes result if Board capabilities change while the run is in flight", async () => {
    const { service, boards, runtime } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const current = await boards.get("workspace", created.board.id) as AgentBoard;
    const ready = observeAgentBoardPlugin({ current, configurationEpoch: 1, healthy: true });
    await boards.update(ready, current.version, { id: "evt-ready-stale", workspaceId: "workspace", actorId: "system", actorType: "system", action: "ready", detail: {}, createdAt: ready.updatedAt });
    (runtime?.run as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      const duringRun = await boards.get("workspace", created.board.id) as AgentBoard;
      const changed = queueAgentBoardReconcile({ current: duringRun, actor: owner, expectedVersion: duringRun.version, desiredSkills: ["news-research"] });
      await boards.update(changed.board, duringRun.version, changed.event, changed.outbox);
      return { model: "hermes-agent", text: "stale answer" };
    });
    await expect(service.run("workspace", "brand", created.board.id, "summarize", owner)).rejects.toMatchObject({ statusCode: 409, code: "agent_board_run_stale" });
    expect(await boards.listRuns("workspace", created.board.id)).toHaveLength(0);
  });

  it("queues purpose changes and explicit setup retries through the durable plugin outbox", async () => {
    const { service, boards } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const revised = await service.update("workspace", "brand", created.board.id, 1, { brandId: "brand", purpose: "Verified Mumbai event coverage." }, owner);
    expect(revised.board).toMatchObject({ status: "provisioning", version: 2, purpose: "Verified Mumbai event coverage." });
    expect(await boards.get("workspace", created.board.id)).toMatchObject({ configurationEpoch: 2, capabilityEpoch: 2 });
    const retried = await service.reconcile("workspace", "brand", created.board.id, 2, owner);
    expect(retried).toMatchObject({ pending: true, board: { status: "provisioning", version: 3 } });
    expect(await boards.get("workspace", created.board.id)).toMatchObject({ configurationEpoch: 3, capabilityEpoch: 2 });
  });

  it("fails closed instead of falling back when the internal plugin is disabled", async () => {
    const { service } = setup(null);
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    expect(created.board.status).toBe("setup_required");
    await expect(service.run("workspace", "brand", created.board.id, "test", owner)).rejects.toMatchObject({ status: 503 });
  });

  it("keeps Board task management available when Hermes is unavailable", async () => {
    const { service } = setup(null);
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const task = await service.createTask("workspace", "brand", created.board.id, "mumbai-board-task-0001", { brandId: "brand", title: "Verify the Luma Mumbai event" }, owner);
    expect(task).toMatchObject({ replayed: false, task: { status: "triage", boardId: created.board.id } });
    await expect(service.tasks("workspace", "brand", created.board.id, false, owner)).resolves.toMatchObject({ tasks: [expect.objectContaining({ title: "Verify the Luma Mumbai event" })] });
    expect(JSON.stringify(task)).not.toMatch(/idempotency|fingerprint|hermes/iu);
  });

  it("replays exact task creates and rejects changed-body idempotency reuse", async () => {
    const { service } = setup(null);
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const dto = { brandId: "brand", title: "Verify organizer details", description: "Use the official source." };
    const first = await service.createTask("workspace", "brand", created.board.id, "mumbai-board-task-0002", dto, owner);
    const replay = await service.createTask("workspace", "brand", created.board.id, "mumbai-board-task-0002", dto, owner);
    expect(replay).toMatchObject({ replayed: true, task: { id: first.task.id } });
    await expect(service.createTask("workspace", "brand", created.board.id, "mumbai-board-task-0002", { ...dto, title: "Different task" }, owner)).rejects.toMatchObject({ statusCode: 409, code: "idempotency_key_conflict" });
  });

  it("releases a ready Board-agent task once and exposes only the review-safe execution receipt", async () => {
    const { service, boards, outbox } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai execution", purpose: "Prepare verified Mumbai coverage." }, owner);
    const current = await boards.get("workspace", created.board.id) as AgentBoard;
    const readyBoard = observeAgentBoardPlugin({ current, configurationEpoch: current.configurationEpoch, healthy: true });
    await boards.update(readyBoard, current.version, { id: "evt-ready-task", workspaceId: "workspace", actorId: "system", actorType: "system", action: "ready", detail: {}, createdAt: readyBoard.updatedAt });
    const made = await service.createTask("workspace", "brand", created.board.id, "mumbai-agent-task-0001", { brandId: "brand", title: "Prepare event brief", assignee: "board-agent" }, owner);
    const todo = await service.updateTask("workspace", "brand", created.board.id, made.task.id, made.task.version, { brandId: "brand", status: "todo" }, owner);
    const ready = await service.updateTask("workspace", "brand", created.board.id, made.task.id, todo.task.version, { brandId: "brand", status: "ready" }, owner);
    await expect(service.releaseTask("workspace", "brand", created.board.id, made.task.id, ready.task.version, "mumbai-task-release-0001", creator)).rejects.toMatchObject({ status: 403 });
    const released = await service.releaseTask("workspace", "brand", created.board.id, made.task.id, ready.task.version, "mumbai-task-release-0001", manager);
    expect(released).toMatchObject({ replayed: false, task: { status: "running" }, execution: { status: "queued", taskId: made.task.id } });
    expect(JSON.stringify(released)).not.toMatch(/idempotency|fingerprint|requestSha|claimId|kanban|hermesProfile/iu);
    expect(outbox).toContainEqual(expect.objectContaining({ topic: "board.task.execute", payload: expect.objectContaining({ taskId: made.task.id, executionId: released.execution.id }) }));
    await expect(service.releaseTask("workspace", "brand", created.board.id, made.task.id, ready.task.version, "mumbai-task-release-0001", manager)).resolves.toMatchObject({ replayed: true, execution: { id: released.execution.id } });
    await expect(service.taskExecutions("workspace", "brand", created.board.id, made.task.id, 50, owner)).resolves.toMatchObject({ executions: [expect.objectContaining({ id: released.execution.id, status: "queued" })] });
  });

  it("hands a succeeded review receipt into Content once without approving, drafting, scheduling, or publishing", async () => {
    const { service, boards, tasks, repository } = setup();
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai content handoff", purpose: "Prepare a verified Mumbai brief." }, owner);
    const current = await boards.get("workspace", created.board.id) as AgentBoard;
    const readyBoard = observeAgentBoardPlugin({ current, configurationEpoch: current.configurationEpoch, healthy: true });
    await boards.update(readyBoard, current.version, { id: "evt-ready-handoff", workspaceId: "workspace", actorId: "system", actorType: "system", action: "ready", detail: {}, createdAt: readyBoard.updatedAt });
    const made = await service.createTask("workspace", "brand", created.board.id, "mumbai-handoff-task-0001", { brandId: "brand", title: "Prepare Mumbai event brief", assignee: "board-agent" }, owner);
    const todo = await service.updateTask("workspace", "brand", created.board.id, made.task.id, made.task.version, { brandId: "brand", status: "todo" }, owner);
    const ready = await service.updateTask("workspace", "brand", created.board.id, made.task.id, todo.task.version, { brandId: "brand", status: "ready" }, owner);
    const released = await service.releaseTask("workspace", "brand", created.board.id, made.task.id, ready.task.version, "mumbai-handoff-release-0001", manager);
    const claimed = await tasks.claimExecution("workspace", "brand", created.board.id, made.task.id, released.execution.id, "api-handoff-worker-0001", 120);
    const finished = finishAgentBoardTaskExecution({ task: claimed!.task, execution: claimed!.execution, outcome: "succeeded", model: "hermes-agent", resultText: "Official organizer details were summarized for a human editor.", now: new Date(Date.now() + 1_000).toISOString() });
    await tasks.finishExecution(finished.task, claimed!.task.version, finished.execution, claimed!.execution.claimId!, finished.event);

    await expect(service.handoffTask("workspace", "brand", created.board.id, made.task.id, released.execution.id, finished.task.version, "mumbai-content-handoff-0001", creator)).rejects.toMatchObject({ status: 403 });
    const handoff = await service.handoffTask("workspace", "brand", created.board.id, made.task.id, released.execution.id, finished.task.version, "mumbai-content-handoff-0001", manager);
    expect(handoff).toMatchObject({ replayed: false, task: { status: "review", contentItemId: expect.any(String) }, contentItem: { status: "inbox", drafts: [], approvals: [], targets: [], publishAttempts: [], proofs: [] }, handoff: { taskId: made.task.id, executionId: released.execution.id, contentItemId: expect.any(String), responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(JSON.stringify(handoff.handoff)).not.toMatch(/idempotency|fingerprint/iu);
    await expect(service.handoffTask("workspace", "brand", created.board.id, made.task.id, released.execution.id, finished.task.version, "mumbai-content-handoff-0001", manager)).resolves.toMatchObject({ replayed: true, contentItem: { id: handoff.contentItem.id } });
    await expect(service.task("workspace", "brand", created.board.id, made.task.id, owner)).resolves.toMatchObject({ task: { status: "review", contentItemId: handoff.contentItem.id } });
    await expect(service.taskExecutions("workspace", "brand", created.board.id, made.task.id, 50, owner)).resolves.toMatchObject({ executions: [expect.objectContaining({ status: "succeeded", contentItemId: handoff.contentItem.id })] });
    expect(await repository.listAudit("workspace", handoff.contentItem.id)).toEqual([expect.objectContaining({ action: "content.created-from-board-task", detail: expect.objectContaining({ boardId: created.board.id, taskId: made.task.id, executionId: released.execution.id }) })]);
  });

  it("gates task progress on same-Board dependencies and preserves append-only comments", async () => {
    const { service } = setup(null);
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    const parent = await service.createTask("workspace", "brand", created.board.id, "mumbai-board-task-0003", { brandId: "brand", title: "Verify event" }, owner);
    const child = await service.createTask("workspace", "brand", created.board.id, "mumbai-board-task-0004", { brandId: "brand", title: "Draft story", parentTaskIds: [parent.task.id] }, owner);
    const childTodo = await service.updateTask("workspace", "brand", created.board.id, child.task.id, 1, { brandId: "brand", status: "todo" }, owner);
    await expect(service.updateTask("workspace", "brand", created.board.id, child.task.id, childTodo.task.version, { brandId: "brand", status: "ready" }, owner)).rejects.toMatchObject({ code: "agent_board_task_dependencies_open" });

    const parentTodo = await service.updateTask("workspace", "brand", created.board.id, parent.task.id, 1, { brandId: "brand", status: "todo" }, owner);
    const parentReady = await service.updateTask("workspace", "brand", created.board.id, parent.task.id, parentTodo.task.version, { brandId: "brand", status: "ready" }, owner);
    const parentRunning = await service.updateTask("workspace", "brand", created.board.id, parent.task.id, parentReady.task.version, { brandId: "brand", status: "running" }, creator);
    const parentReview = await service.updateTask("workspace", "brand", created.board.id, parent.task.id, parentRunning.task.version, { brandId: "brand", status: "review", resultSummary: "Official event page captured." }, creator);
    await expect(service.updateTask("workspace", "brand", created.board.id, parent.task.id, parentReview.task.version, { brandId: "brand", status: "done" }, creator)).rejects.toMatchObject({ code: "permission_denied" });
    await service.updateTask("workspace", "brand", created.board.id, parent.task.id, parentReview.task.version, { brandId: "brand", status: "done" }, manager);
    const childReady = await service.updateTask("workspace", "brand", created.board.id, child.task.id, childTodo.task.version, { brandId: "brand", status: "ready" }, owner);
    expect(childReady.task.status).toBe("ready");
    const comment = await service.commentTask("workspace", "brand", created.board.id, child.task.id, childReady.task.version, "mumbai-board-comment-0001", "Keep source proof with the draft.", owner);
    expect(comment.comment.body).toContain("source proof");
    expect(JSON.stringify(comment)).not.toMatch(/idempotency|fingerprint|authorId/iu);
    await expect(service.commentTask("workspace", "brand", created.board.id, child.task.id, childReady.task.version, "mumbai-board-comment-0001", "Keep source proof with the draft.", owner)).resolves.toMatchObject({ replayed: true, comment: { id: comment.comment.id } });
    await expect(service.commentTask("workspace", "brand", created.board.id, child.task.id, childReady.task.version, "mumbai-board-comment-0001", "Changed comment.", owner)).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    await expect(service.taskComments("workspace", "brand", created.board.id, child.task.id, 50, owner)).resolves.toMatchObject({ comments: [expect.objectContaining({ body: "Keep source proof with the draft." })] });
  });

  it("marks live Hermes policy drift as attention and does not expose unsafe toolsets", async () => {
    const drifted = { ...observation, healthy: false, policyCompliant: false, safeToolsets: ["browser", "memory", "skills"] };
    const runtime = { inspect: vi.fn().mockResolvedValue(drifted), reconcile: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn().mockResolvedValue([]), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn(), run: vi.fn(), executeTask: vi.fn() } as BoardRuntimePort;
    const { service } = setup(runtime);
    const created = await service.create("workspace", { brandId: "brand", name: "Mumbai", purpose: "Mumbai desk." }, owner);
    await expect(service.plugin("workspace", "brand", created.board.id, owner)).resolves.toMatchObject({ healthy: false, safeToolsets: [] });
    await expect(service.test("workspace", "brand", created.board.id, owner)).resolves.toMatchObject({ ok: false, board: { status: "attention", attentionCode: "hermes_policy_drift" } });
  });
});
