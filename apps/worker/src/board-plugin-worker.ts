import { deriveBoardRuntimeSecrets, HermesBoardPluginError, type BoardRuntimePort } from "@originpost/agents";
import { observeAgentBoardDeactivated, observeAgentBoardPlugin, type AgentBoardRepository, type AuditEvent, type OrganizationRepository } from "@originpost/domain";
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

export async function processBoardPluginDeactivate(job: BoardPluginDeactivateJob, dependencies: { boards: AgentBoardRepository; runtime: BoardRuntimePort; secret: string | Buffer }) {
  const current = await dependencies.boards.get(job.workspaceId, job.boardId);
  if (!current || current.brandId !== job.brandId) return { skipped: true, reason: "board-not-found" } as const;
  if (current.status !== "archived") return { skipped: true, reason: "board-active" } as const;
  if (current.configurationEpoch !== job.configurationEpoch || current.capabilityEpoch !== job.capabilityEpoch) return { skipped: true, reason: "stale-configuration-epoch" } as const;
  if (current.runtimeDeactivatedAt) return { skipped: true, reason: "already-deactivated" } as const;
  const derived = deriveBoardRuntimeSecrets(dependencies.secret, { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, capabilityEpoch: current.capabilityEpoch });
  await dependencies.runtime.deactivate({ workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, profile: current.hermesProfile, capabilityEpoch: current.capabilityEpoch, ...derived });
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
  if (dependencies.organizations && (await dependencies.organizations.getBrand(job.workspaceId, job.brandId))?.status !== "active") return { skipped: true, reason: "brand-inactive" } as const;
  if (current.configurationEpoch !== job.configurationEpoch) return { skipped: true, reason: "stale-configuration-epoch" } as const;
  const derived = deriveBoardRuntimeSecrets(dependencies.secret, { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, capabilityEpoch: current.capabilityEpoch });
  const binding = { workspaceId: current.workspaceId, brandId: current.brandId, boardId: current.id, profile: current.hermesProfile, capabilityEpoch: current.capabilityEpoch, ...derived };
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
