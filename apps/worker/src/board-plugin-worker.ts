import { deriveBoardRuntimeSecrets, HermesBoardPluginError, type BoardRuntimePort } from "@originpost/agents";
import { observeAgentBoardDeactivated, observeAgentBoardPlugin, observeAgentBoardPluginDecision, type AgentBoardRepository, type AuditEvent, type OrganizationRepository } from "@originpost/domain";
import { randomUUID } from "node:crypto";

export interface BoardPluginReconcileJob {
  workspaceId: string;
  brandId: string;
  boardId: string;
  configurationEpoch: number;
}

export interface BoardPluginDeactivateJob extends BoardPluginReconcileJob {
  capabilityEpoch: number;
}

export interface BoardPluginDecisionJob {
  workspaceId: string;
  brandId: string;
  boardId: string;
  subsystem: "memory" | "skills";
  pendingId: string;
  decision: "approve" | "reject";
  expectedSha256: string;
  idempotencyKey: string;
  decisionKey: string;
  idempotencyScopeKey: string;
  requestedConfigurationEpoch: number;
  requestedCapabilityEpoch: number;
  requestedBy: string;
  requestedAt: string;
}

export async function processBoardPluginDecision(job: BoardPluginDecisionJob, dependencies: { boards: AgentBoardRepository; runtime: BoardRuntimePort; secret: string | Buffer; organizations?: Pick<OrganizationRepository,"getBrand"> }) {
  const current = await dependencies.boards.get(job.workspaceId, job.boardId);
  if (!current || current.brandId !== job.brandId) return { skipped: true, reason: "board-not-found" } as const;
  if (current.appliedPluginDecisionKeys?.includes(job.decisionKey)) return { skipped: true, reason: "already-applied" } as const;
  const pending = current.pendingPluginDecision;
  if (!pending || pending.decisionKey !== job.decisionKey || pending.idempotencyScopeKey !== job.idempotencyScopeKey || pending.subsystem !== job.subsystem || pending.pendingId !== job.pendingId || pending.decision !== job.decision || pending.expectedSha256 !== job.expectedSha256 || pending.idempotencyKey !== job.idempotencyKey || pending.requestedConfigurationEpoch !== job.requestedConfigurationEpoch || pending.requestedCapabilityEpoch !== job.requestedCapabilityEpoch || pending.requestedBy !== job.requestedBy || pending.requestedAt !== job.requestedAt) return { skipped: true, reason: "decision-saga-mismatch" } as const;
  if (current.status === "archived") return { skipped: true, reason: "board-archived" } as const;
  if (dependencies.organizations && (await dependencies.organizations.getBrand(job.workspaceId, job.brandId))?.status !== "active") return { skipped: true, reason: "brand-inactive" } as const;
  if (current.configurationEpoch !== job.requestedConfigurationEpoch || current.capabilityEpoch !== job.requestedCapabilityEpoch) return { skipped: true, reason: "stale-capability-epoch" } as const;
  const derived = deriveBoardRuntimeSecrets(dependencies.secret, { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, capabilityEpoch: current.capabilityEpoch });
  const binding = { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, profile: current.hermesProfile, kanbanBoardRef: current.hermesBoardRef, capabilityEpoch: current.capabilityEpoch, ...derived };
  const result = await dependencies.runtime.decidePendingWrite(
    binding,
    { configurationEpoch: current.configurationEpoch, purpose: current.purpose, enabledSkills: current.desiredSkills },
    { subsystem: job.subsystem, pendingId: job.pendingId, decision: job.decision, expectedSha256: job.expectedSha256, idempotencyKey: job.idempotencyKey },
  );
  const latest = await dependencies.boards.get(job.workspaceId, job.boardId);
  if (!latest || latest.brandId !== job.brandId) throw new Error("The Board disappeared after Hermes applied its pending-write decision.");
  if (latest.status === "archived") return { skipped: true, reason: "board-archived-after-apply", replayed: result.replayed } as const;
  const observed = observeAgentBoardPluginDecision({
    current: latest,
    decisionKey: job.decisionKey,
    subsystem: job.subsystem,
    decision: job.decision,
    pendingId: job.pendingId,
    expectedSha256: job.expectedSha256,
  });
  if (observed.alreadyApplied) return { skipped: true, reason: "already-applied", replayed: result.replayed } as const;
  const saved = await dependencies.boards.update(observed.board, latest.version, observed.event, observed.outbox);
  if (!saved) throw new Error("The Board changed after Hermes applied its pending-write decision; retrying the durable receipt.");
  return { skipped: false, replayed: result.replayed, reconcileQueued: Boolean(observed.outbox) } as const;
}

export async function processBoardPluginDeactivate(job: BoardPluginDeactivateJob, dependencies: { boards: AgentBoardRepository; runtime: BoardRuntimePort; secret: string | Buffer }) {
  const current = await dependencies.boards.get(job.workspaceId, job.boardId);
  if (!current || current.brandId !== job.brandId) return { skipped: true, reason: "board-not-found" } as const;
  if (current.status !== "archived") return { skipped: true, reason: "board-active" } as const;
  if (current.configurationEpoch !== job.configurationEpoch || current.capabilityEpoch !== job.capabilityEpoch) return { skipped: true, reason: "stale-configuration-epoch" } as const;
  if (current.runtimeDeactivatedAt) return { skipped: true, reason: "already-deactivated" } as const;
  const derived = deriveBoardRuntimeSecrets(dependencies.secret, { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, capabilityEpoch: current.capabilityEpoch });
  await dependencies.runtime.deactivate({ workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, profile: current.hermesProfile, kanbanBoardRef: current.hermesBoardRef, capabilityEpoch: current.capabilityEpoch, ...derived });
  const latest = await dependencies.boards.get(job.workspaceId, job.boardId);
  if (!latest || latest.version !== current.version || latest.status !== "archived" || latest.configurationEpoch !== job.configurationEpoch || latest.capabilityEpoch !== job.capabilityEpoch) return { skipped: true, reason: "lease-fence-lost" } as const;
  const at = new Date().toISOString();
  const deactivated = observeAgentBoardDeactivated({ current: latest, configurationEpoch: job.configurationEpoch, capabilityEpoch: job.capabilityEpoch, now: at });
  const saved = await dependencies.boards.update(deactivated, latest.version, {
    id: `evt_${randomUUID()}`,
    workspaceId: latest.workspaceId,
    actorId: "board-plugin-worker",
    actorType: "system",
    action: "agent-board.plugin-deactivated",
    detail: { boardId: latest.id, configurationEpoch: job.configurationEpoch, capabilityEpoch: job.capabilityEpoch },
    createdAt: at,
  });
  if (!saved) return { skipped: true, reason: "lease-fence-lost" } as const;
  return { skipped: false } as const;
}

export async function processBoardPluginReconcile(job: BoardPluginReconcileJob, dependencies: { boards: AgentBoardRepository; runtime: BoardRuntimePort; secret: string | Buffer; organizations?: Pick<OrganizationRepository,"getBrand"> }) {
  const current = await dependencies.boards.get(job.workspaceId, job.boardId);
  if (!current || current.brandId !== job.brandId) return { skipped: true, reason: "board-not-found" } as const;
  if (current.status === "archived") return { skipped: true, reason: "board-archived" } as const;
  if (current.pendingPluginDecision) return { skipped: true, reason: "plugin-decision-pending" } as const;
  if (dependencies.organizations && (await dependencies.organizations.getBrand(job.workspaceId, job.brandId))?.status !== "active") return { skipped: true, reason: "brand-inactive" } as const;
  if (current.configurationEpoch !== job.configurationEpoch) return { skipped: true, reason: "stale-configuration-epoch" } as const;
  const derived = deriveBoardRuntimeSecrets(dependencies.secret, { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, capabilityEpoch: current.capabilityEpoch });
  const binding = { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, profile: current.hermesProfile, kanbanBoardRef: current.hermesBoardRef, capabilityEpoch: current.capabilityEpoch, ...derived };
  const at = new Date().toISOString();
  const event = (action: string, detail: Record<string, unknown>): AuditEvent => ({ id: `evt_${randomUUID()}`, workspaceId: current.workspaceId, actorId: "board-plugin-worker", actorType: "system", action, detail: { boardId: current.id, configurationEpoch: job.configurationEpoch, ...detail }, createdAt: at });
  try {
    const observation = await dependencies.runtime.reconcile(binding, { configurationEpoch: job.configurationEpoch, purpose: current.purpose, enabledSkills: current.desiredSkills });
    const latest = await dependencies.boards.get(job.workspaceId, job.boardId);
    if (!latest || latest.version !== current.version || latest.configurationEpoch !== job.configurationEpoch || latest.status === "archived") return { skipped: true, reason: "lease-fence-lost" } as const;
    const observedSkills = observation.skills.filter((skill)=>skill.approved && skill.userManageable && skill.enabled).map((skill)=>skill.name);
    const next = observeAgentBoardPlugin({ current: latest, configurationEpoch: job.configurationEpoch, healthy: observation.healthy && observation.configured && observation.policyCompliant, observedSkills, ...(!observation.healthy ? { errorCode: !observation.policyCompliant ? "hermes_policy_drift" : !observation.modelReady ? "hermes_model_required" : observation.restartRequired ? "hermes_restart_required" : "profile_unavailable" } : {}), now: at });
    const saved = await dependencies.boards.update(next, latest.version, event("agent-board.plugin-reconciled", { healthy: next.status === "ready", observedSkillCount: observedSkills.length, restartRequired: observation.restartRequired }));
    if (!saved) return { skipped: true, reason: "lease-fence-lost" } as const;
    return { skipped: false, healthy: saved.status === "ready", restartRequired: observation.restartRequired } as const;
  } catch (error) {
    const code = error instanceof HermesBoardPluginError ? error.code : "runtime_unavailable";
    const latest = await dependencies.boards.get(job.workspaceId, job.boardId);
    if (latest && latest.version === current.version && latest.configurationEpoch === job.configurationEpoch && latest.status !== "archived") {
      const failed = observeAgentBoardPlugin({ current: latest, configurationEpoch: job.configurationEpoch, healthy: false, errorCode: code, now: at });
      await dependencies.boards.update(failed, latest.version, event("agent-board.plugin-reconcile-failed", { errorCode: code }));
    }
    throw new Error(`Hermes Board reconciliation failed: ${code}`);
  }
}
