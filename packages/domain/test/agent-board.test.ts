import { describe, expect, it } from "vitest";
import { createAgentBoard, InMemoryAgentBoardRepository, observeAgentBoardDeactivated, observeAgentBoardPlugin, observeAgentBoardPluginDecision, queueAgentBoardPluginDecision, queueAgentBoardReconcile, reviseAgentBoard } from "../src/agent-board.js";

const owner = { id: "owner", name: "Owner", role: "owner" as const };

describe("agent boards", () => {
  it("creates a brand-owned board with a dedicated Hermes profile and staged writes", async () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai News", purpose: "Research and prepare verified Mumbai stories.", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    expect(created.board).toMatchObject({ brandId: "brand", slug: "mumbai-news", status: "provisioning", pluginId: "org.originpost.hermes-boards", memoryIsolation: "hermes-profile", memoryWriteApproval: true, skillWriteApproval: true, configurationEpoch: 1, observedConfigurationEpoch: 0 });
    expect(created.board.hermesProfile).toMatch(/^opb_[a-f0-9]{24}$/u);
    expect(created.board.hermesBoardRef).toMatch(/^opk_[a-f0-9]{24}$/u);
    expect(created.event.detail).not.toHaveProperty("apiKey");
    const repository = new InMemoryAgentBoardRepository();
    await repository.create(created.board, created.event);
    expect(await repository.list("workspace", "brand")).toHaveLength(1);
    expect(await repository.list("workspace", "another-brand")).toHaveLength(0);
  });

  it("rotates the capability epoch when a governed skill selection changes", () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai desk.", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    const queued = queueAgentBoardReconcile({ current: created.board, actor: owner, expectedVersion: 1, desiredSkills: ["news-research"], now: "2026-09-07T10:01:00.000Z" });
    expect(queued.board).toMatchObject({ status: "provisioning", configurationEpoch: 2, capabilityEpoch: 2, desiredSkills: ["news-research"] });
    expect(queued.outbox).toMatchObject({ topic: "board.plugin.reconcile", payload: { boardId: created.board.id, configurationEpoch: 2 } });
    const observed = observeAgentBoardPlugin({ current: queued.board, configurationEpoch: 2, healthy: true, observedSkills: ["news-research"], now: "2026-09-07T10:02:00.000Z" });
    expect(observed).toMatchObject({ status: "ready", observedConfigurationEpoch: 2, observedSkills: ["news-research"] });
  });

  it("can force capability rotation when approved skill content changes", () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai desk.", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    const queued = queueAgentBoardReconcile({ current: created.board, actor: owner, expectedVersion: 1, desiredSkills: [], rotateCapabilities: true, now: "2026-09-07T10:01:00.000Z" });
    expect(queued.board).toMatchObject({ status: "provisioning", configurationEpoch: 2, capabilityEpoch: 2, desiredSkills: [] });
    expect(queued.outbox).toMatchObject({ topic: "board.plugin.reconcile", payload: { configurationEpoch: 2 } });
  });

  it("persists a pending plugin decision before applying it and completes it exactly once", () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai desk.", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    const decisionKey = "b".repeat(64);
    const idempotencyScopeKey = "c".repeat(64);
    const queued = queueAgentBoardPluginDecision({ current: created.board, actor: owner, subsystem: "skills", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64), idempotencyKey: "test-skill-reseal", decisionKey, idempotencyScopeKey, now: "2026-09-07T10:01:00.000Z" });
    expect(queued.board).toMatchObject({ version: 2, status: "provisioning", configurationEpoch: 1, capabilityEpoch: 1, pendingPluginDecision: { decisionKey } });
    expect(queued.outbox).toMatchObject({ topic: "board.plugin.decision", payload: { decisionKey } });
    expect(() => queueAgentBoardPluginDecision({ current: queued.board, actor: owner, subsystem: "skills", pendingId: "a1b2c3d4", decision: "reject", expectedSha256: "a".repeat(64), idempotencyKey: "test-skill-reseal", decisionKey: "d".repeat(64), idempotencyScopeKey })).toThrow(/still being applied/iu);
    expect(() => reviseAgentBoard({ current: queued.board, actor: owner, expectedVersion: 2, name: "Changed" })).toThrow(/still being applied/iu);
    const applied = observeAgentBoardPluginDecision({ current: queued.board, decisionKey, subsystem: "skills", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64), now: "2026-09-07T10:02:00.000Z" });
    expect(applied).toMatchObject({ alreadyApplied: false, board: { version: 3, configurationEpoch: 2, capabilityEpoch: 2, status: "provisioning", appliedPluginDecisionKeys: [decisionKey] }, outbox: { topic: "board.plugin.reconcile" } });
    expect(applied.board).not.toHaveProperty("pendingPluginDecision");
    expect(observeAgentBoardPluginDecision({ current: applied.board, decisionKey, subsystem: "skills", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64) }).alreadyApplied).toBe(true);
    expect(queueAgentBoardPluginDecision({ current: applied.board, actor: owner, subsystem: "skills", pendingId: "a1b2c3d4", decision: "approve", expectedSha256: "a".repeat(64), idempotencyKey: "test-skill-reseal", decisionKey, idempotencyScopeKey })).toMatchObject({ alreadyApplied: true, alreadyQueued: false, board: { version: 3 } });
    expect(() => queueAgentBoardPluginDecision({ current: applied.board, actor: owner, subsystem: "skills", pendingId: "a1b2c3d4", decision: "reject", expectedSha256: "a".repeat(64), idempotencyKey: "test-skill-reseal", decisionKey: "d".repeat(64), idempotencyScopeKey })).toThrow(/different Board plugin decision/iu);
    expect(() => queueAgentBoardPluginDecision({ current: applied.board, actor: owner, subsystem: "memory", pendingId: "d4c3b2a1", decision: "approve", expectedSha256: "e".repeat(64), idempotencyKey: "test-skill-reseal", decisionKey: "f".repeat(64), idempotencyScopeKey })).toThrow(/different Board plugin decision/iu);
  });

  it("reconciles a changed purpose and fences runs created under the old mission", () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai desk.", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    const revised = reviseAgentBoard({ current: { ...created.board, status: "ready", observedConfigurationEpoch: 1 }, actor: owner, expectedVersion: 1, purpose: "Cover verified Mumbai events.", checkedAt: "2026-09-07T10:01:00.000Z" });
    expect(revised.board).toMatchObject({ purpose: "Cover verified Mumbai events.", status: "provisioning", configurationEpoch: 2, capabilityEpoch: 2 });
    expect(revised.outbox).toMatchObject({ topic: "board.plugin.reconcile", payload: { boardId: created.board.id, configurationEpoch: 2 } });
    expect(revised.event.action).toBe("agent-board.plugin-reconcile-requested");
  });

  it("rotates capabilities and durably deactivates Hermes when a Board is archived", () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai desk.", pluginConfigured: true, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    const archived = reviseAgentBoard({ current: { ...created.board, status: "ready", observedConfigurationEpoch: 1 }, actor: owner, expectedVersion: 1, status: "archived", checkedAt: "2026-09-07T10:01:00.000Z" });
    expect(archived.board).toMatchObject({ status: "archived", configurationEpoch: 2, capabilityEpoch: 2 });
    expect(archived.outbox).toMatchObject({ topic: "board.plugin.deactivate", payload: { boardId: created.board.id, configurationEpoch: 2, capabilityEpoch: 2 } });
    expect(archived.event.action).toBe("agent-board.archived");
    const observed = observeAgentBoardDeactivated({ current: archived.board, configurationEpoch: 2, capabilityEpoch: 2, now: "2026-09-07T10:02:00.000Z" });
    expect(observed).toMatchObject({ version: 3, runtimeDeactivatedAt: "2026-09-07T10:02:00.000Z" });
    expect(observeAgentBoardDeactivated({ current: observed, configurationEpoch: 2, capabilityEpoch: 2, now: "2026-09-07T10:03:00.000Z" })).toEqual(observed);
  });

  it("rejects control characters in a Board purpose", () => {
    expect(() => createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai\u0007desk", pluginConfigured: true, actor: owner })).toThrow(/safe characters/iu);
  });

  it("keeps the Board-to-profile identity immutable", async () => {
    const repository = new InMemoryAgentBoardRepository();
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Mumbai", purpose: "Mumbai desk.", pluginConfigured: true, actor: owner });
    await repository.create(created.board, created.event);
    await expect(repository.update({ ...created.board, version: 2, hermesProfile: "opb_aaaaaaaaaaaaaaaaaaaaaaaa" }, 1, created.event)).rejects.toThrow(/identity cannot be changed/iu);
    await expect(repository.update({ ...created.board, version: 2, hermesBoardRef: "opk_aaaaaaaaaaaaaaaaaaaaaaaa" }, 1, created.event)).rejects.toThrow(/identity cannot be changed/iu);
  });

  it("fails closed when the plugin is unavailable and needs optimistic locking", () => {
    const created = createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Research", purpose: "Source-first research.", pluginConfigured: false, actor: owner, now: "2026-09-07T10:00:00.000Z" });
    expect(created.board.status).toBe("setup_required");
    expect(created.board.lastError).toContain("Configure");
    expect(() => reviseAgentBoard({ current: created.board, actor: owner, expectedVersion: 2, status: "ready" })).toThrow(/changed/i);
  });

  it("allows only a workspace owner to manage a board", () => {
    expect(() => createAgentBoard({ workspaceId: "workspace", brandId: "brand", name: "Research", purpose: "Source-first research.", pluginConfigured: true, actor: { ...owner, role: "manager" } })).toThrow(/owner/i);
  });
});
