import { describe, expect, it, vi } from "vitest";
import { createAgentBoard, InMemoryAgentBoardRepository, queueAgentBoardPluginDecision, queueAgentBoardReconcile, reviseAgentBoard } from "@originpost/domain";
import type { BoardRuntimePort } from "@originpost/agents";
import { processBoardPluginDeactivate, processBoardPluginDecision, processBoardPluginReconcile } from "../src/board-plugin-worker.js";

const owner = { id: "owner", name: "Owner", role: "owner" as const };

describe("Board plugin reconciler", () => {
  it("replays a Hermes receipt after a post-mutation database conflict and then queues resealing", async () => {
    const repository = new InMemoryAgentBoardRepository();
    const created = createAgentBoard({ workspaceId: "w", brandId: "b", name: "Mumbai", purpose: "Mumbai coverage", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    await repository.create(created.board, created.event);
    const decisionKey = "b".repeat(64);
    const queued = queueAgentBoardPluginDecision({ current: created.board, actor: owner, subsystem: "skills", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64), idempotencyKey: "test-skill-reseal", decisionKey, idempotencyScopeKey: "c".repeat(64), now: "2026-09-07T10:01:00.000Z" });
    await repository.update(queued.board, created.board.version, queued.event, queued.outbox);
    const runtime = { inspect: vi.fn(), reconcile: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn(), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn().mockResolvedValueOnce({ ok: true, replayed: false }).mockResolvedValueOnce({ ok: true, replayed: true }), run: vi.fn() } as unknown as BoardRuntimePort;
    const job = { workspaceId: "w", brandId: "b", boardId: created.board.id, ...queued.board.pendingPluginDecision! };
    const originalUpdate = repository.update.bind(repository);
    vi.spyOn(repository, "update").mockResolvedValueOnce(null).mockImplementation(originalUpdate);
    await expect(processBoardPluginDecision(job, { boards: repository, runtime, secret: "x".repeat(32) })).rejects.toThrow(/retrying the durable receipt/iu);
    expect(await repository.get("w", created.board.id)).toMatchObject({ pendingPluginDecision: { decisionKey }, configurationEpoch: 1, capabilityEpoch: 1 });
    await expect(processBoardPluginDecision(job, { boards: repository, runtime, secret: "x".repeat(32) })).resolves.toMatchObject({ skipped: false, replayed: true, reconcileQueued: true });
    expect(runtime.decidePendingWrite).toHaveBeenCalledTimes(2);
    expect(await repository.get("w", created.board.id)).toMatchObject({ configurationEpoch: 2, capabilityEpoch: 2, appliedPluginDecisionKeys: [decisionKey] });
    expect((await repository.get("w", created.board.id))?.pendingPluginDecision).toBeUndefined();
    await expect(processBoardPluginDecision(job, { boards: repository, runtime, secret: "x".repeat(32) })).resolves.toEqual({ skipped: true, reason: "already-applied" });
    expect(runtime.decidePendingWrite).toHaveBeenCalledTimes(2);
  });

  it("fences stale epochs and applies only the Board's policy", async () => {
    const repository = new InMemoryAgentBoardRepository();
    const created = createAgentBoard({ workspaceId: "w", brandId: "b", name: "Mumbai", purpose: "Mumbai coverage", pluginConfigured: true, actor: owner });
    await repository.create(created.board, created.event);
    const queued = queueAgentBoardReconcile({ current: created.board, actor: owner, expectedVersion: 1, desiredSkills: ["news-research"] });
    await repository.update(queued.board, 1, queued.event, queued.outbox);
    const runtime: BoardRuntimePort = {
      inspect: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn(), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn(), run: vi.fn(),
      reconcile: vi.fn().mockResolvedValue({ healthy: true, configured: true, policyCompliant: true, modelReady: true, version: "0.21.1", memory: { isolation: "dedicated-profile", enabled: true, writeApproval: true }, isolation: { mode: "profile-scoped", verified: true, profileScoped: true, memoryScoped: true, skillsScoped: true, stateScoped: true, externalSkillsBlocked: true, unsafeToolsBlocked: true, filesystemSandbox: false }, skills: [{ name: "news-research", description: "", category: "news", enabled: true, provenance: "bundled", approved: true, userManageable: true }], safeToolsets: ["memory"], restartRequired: false }),
    };
    const stale = await processBoardPluginReconcile({ workspaceId: "w", brandId: "b", boardId: created.board.id, configurationEpoch: 1 }, { boards: repository, runtime, secret: "x".repeat(32) });
    expect(stale).toEqual({ skipped: true, reason: "stale-configuration-epoch" });
    expect(runtime.reconcile).not.toHaveBeenCalled();
    const result = await processBoardPluginReconcile({ workspaceId: "w", brandId: "b", boardId: created.board.id, configurationEpoch: 2 }, { boards: repository, runtime, secret: "x".repeat(32) });
    expect(result).toMatchObject({ skipped: false, healthy: true });
    expect(await repository.get("w", created.board.id)).toMatchObject({ status: "ready", observedConfigurationEpoch: 2, observedSkills: ["news-research"] });
  });

  it("never reconciles an archived Board", async () => {
    const repository = new InMemoryAgentBoardRepository();
    const created = createAgentBoard({ workspaceId: "w", brandId: "b", name: "Mumbai", purpose: "Mumbai coverage", pluginConfigured: true, actor: owner });
    const archived = { ...created.board, status: "archived" as const, version: 2 };
    await repository.create(archived, created.event);
    const runtime = { inspect: vi.fn(), reconcile: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn(), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn(), run: vi.fn() } as unknown as BoardRuntimePort;
    await expect(processBoardPluginReconcile({ workspaceId: "w", brandId: "b", boardId: archived.id, configurationEpoch: 1 }, { boards: repository, runtime, secret: "x".repeat(32) })).resolves.toEqual({ skipped: true, reason: "board-archived" });
    expect(runtime.reconcile).not.toHaveBeenCalled();
  });

  it("deactivates only the exact archived Board capability epoch", async () => {
    const repository = new InMemoryAgentBoardRepository();
    const created = createAgentBoard({ workspaceId: "w", brandId: "b", name: "Mumbai", purpose: "Mumbai coverage", pluginConfigured: true, actor: owner });
    await repository.create(created.board, created.event);
    const archived = reviseAgentBoard({ current: created.board, actor: owner, expectedVersion: 1, status: "archived" });
    await repository.update(archived.board, 1, archived.event, archived.outbox);
    const runtime = { inspect: vi.fn(), reconcile: vi.fn(), deactivate: vi.fn(), listPendingWrites: vi.fn(), pendingWriteDetail: vi.fn(), decidePendingWrite: vi.fn(), run: vi.fn() } as unknown as BoardRuntimePort;
    await expect(processBoardPluginDeactivate({ workspaceId: "w", brandId: "b", boardId: created.board.id, configurationEpoch: 1, capabilityEpoch: 1 }, { boards: repository, runtime, secret: "x".repeat(32) })).resolves.toEqual({ skipped: true, reason: "stale-configuration-epoch" });
    await expect(processBoardPluginDeactivate({ workspaceId: "w", brandId: "b", boardId: created.board.id, configurationEpoch: 2, capabilityEpoch: 2 }, { boards: repository, runtime, secret: "x".repeat(32) })).resolves.toEqual({ skipped: false });
    expect(runtime.deactivate).toHaveBeenCalledWith(expect.objectContaining({ profile: archived.board.hermesProfile, capabilityEpoch: 2, ownershipMarker: expect.stringMatching(/^opb_owner_/) }));
    expect(await repository.get("w", created.board.id)).toMatchObject({ status: "archived", runtimeDeactivatedAt: expect.any(String) });
    await expect(processBoardPluginDeactivate({ workspaceId: "w", brandId: "b", boardId: created.board.id, configurationEpoch: 2, capabilityEpoch: 2 }, { boards: repository, runtime, secret: "x".repeat(32) })).resolves.toEqual({ skipped: true, reason: "already-deactivated" });
    expect(runtime.deactivate).toHaveBeenCalledTimes(1);
  });
});
