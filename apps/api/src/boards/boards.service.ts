import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { deriveBoardRuntimeSecrets, HermesBoardPluginError, type BoardRuntimeBinding, type BoardRuntimeObservation } from "@originpost/agents";
import { agentRunHash, can, createAgentBoard, createOutboxMessage, DomainError, observeAgentBoardPlugin, queueAgentBoardPluginDecision, queueAgentBoardReconcile, reviseAgentBoard, type Actor, type AgentBoard, type AgentBoardRunLedgerEntry, type AuditEvent } from "@originpost/domain";
import { randomUUID } from "node:crypto";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { BoardQueryDto, CreateBoardDto, DecideBoardPendingWriteDto, UpdateBoardDto, UpdateBoardSkillDto } from "./dto/boards.dto.js";

const publicBoard = (board: AgentBoard) => ({
  id: board.id, workspaceId: board.workspaceId, brandId: board.brandId, version: board.version,
  name: board.name, slug: board.slug, purpose: board.purpose, status: board.status,
  memoryIsolation: "dedicated-profile", memoryWriteApproval: board.memoryWriteApproval, skillWriteApproval: board.skillWriteApproval,
  ...(board.lastCheckedAt ? { lastCheckedAt: board.lastCheckedAt } : {}),
  ...(board.lastError ? { attentionCode: board.lastError } : {}),
  createdAt: board.createdAt, updatedAt: board.updatedAt,
});

@Injectable()
export class BoardsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, private readonly config: ConfigService) {}
  private readable(actor: Actor) { if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view Boards."); }
  private owner(actor: Actor) { if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "workspace:manage")) throw new ForbiddenException("Only a workspace owner can manage Boards."); }
  private audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent { return { id: `evt_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human", action, detail, createdAt: new Date().toISOString() }; }
  private async board(workspaceId: string, brandId: string, id: string) { const board = await this.infrastructure.agentBoardRepository.get(workspaceId, id); if (!board || board.brandId !== brandId) throw new DomainError("Board not found.", "agent_board_not_found", 404); return board; }
  private async requireActiveBrand(workspaceId: string, brandId: string) { const brand = await this.infrastructure.organizationRepository.getBrand(workspaceId, brandId); if (!brand || brand.status !== "active") throw new DomainError("Active brand not found.", "brand_not_found", 404); }
  private binding(board: AgentBoard): BoardRuntimeBinding {
    const secret = this.config.get<string>("HERMES_BOARD_SECRET") ?? "";
    const derived = deriveBoardRuntimeSecrets(secret, { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, capabilityEpoch: board.capabilityEpoch });
    return { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, profile: board.hermesProfile, capabilityEpoch: board.capabilityEpoch, ...derived };
  }
  private safeCode(error: unknown) { return error instanceof HermesBoardPluginError ? error.code : "runtime_unavailable"; }

  async list(workspaceId: string, query: BoardQueryDto, actor: Actor) { this.readable(actor); return { boards: (await this.infrastructure.agentBoardRepository.list(workspaceId, query.brandId, query.includeArchived)).map(publicBoard) }; }
  async get(workspaceId: string, brandId: string, id: string, actor: Actor) { this.readable(actor); return { board: publicBoard(await this.board(workspaceId, brandId, id)) }; }

  async create(workspaceId: string, dto: CreateBoardDto, actor: Actor) {
    this.owner(actor);
    const brand = await this.infrastructure.organizationRepository.getBrand(workspaceId, dto.brandId);
    if (!brand || brand.status !== "active") throw new DomainError("Active brand not found.", "brand_not_found", 404);
    const configured = Boolean(this.infrastructure.boardRuntime);
    const result = createAgentBoard({ workspaceId, brandId: dto.brandId, name: dto.name, purpose: dto.purpose, pluginConfigured: configured, actor });
    const message = configured ? createOutboxMessage({ workspaceId, topic: "board.plugin.reconcile", dedupeKey: `board-plugin:${result.board.id}:epoch:1`, payload: { workspaceId, brandId: dto.brandId, boardId: result.board.id, configurationEpoch: 1 }, now: result.board.createdAt }) : undefined;
    await this.infrastructure.agentBoardRepository.create(result.board, result.event, message);
    return { board: publicBoard(result.board) };
  }

  async update(workspaceId: string, brandId: string, id: string, expectedVersion: number | undefined, dto: UpdateBoardDto, actor: Actor) {
    this.owner(actor);
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board version.", "version_required", 428);
    const current = await this.board(workspaceId, brandId, id);
    if (current.status === "archived") throw new DomainError("Archived Boards are retained and cannot be edited.", "agent_board_archived", 409);
    const result = reviseAgentBoard({ current, actor, expectedVersion, ...(dto.name === undefined ? {} : { name: dto.name }), ...(dto.purpose === undefined ? {} : { purpose: dto.purpose }), ...(dto.status === undefined ? {} : { status: dto.status }) });
    const saved = await this.infrastructure.agentBoardRepository.update(result.board, expectedVersion, result.event, result.outbox);
    if (!saved) throw new DomainError("This Board changed. Refresh and try again.", "version_conflict", 409);
    return { board: publicBoard(saved) };
  }

  private async observation(board: AgentBoard): Promise<BoardRuntimeObservation | null> {
    if (!this.infrastructure.boardRuntime || board.status === "archived") return null;
    try { return await this.infrastructure.boardRuntime.inspect(this.binding(board), { configurationEpoch: board.configurationEpoch, purpose: board.purpose, enabledSkills: board.desiredSkills }); } catch { return null; }
  }

  async plugin(workspaceId: string, brandId: string, id: string, actor: Actor) {
    this.readable(actor);
    const board = await this.board(workspaceId, brandId, id);
    const observation = await this.observation(board);
    const mayManagePending = (actor.actorType === undefined || actor.actorType === "human") && can(actor.role, "workspace:manage") && board.status !== "archived";
    const policy = { configurationEpoch: board.configurationEpoch, purpose: board.purpose, enabledSkills: board.desiredSkills };
    const pendingWrites = mayManagePending && this.infrastructure.boardRuntime && observation?.configured ? await this.infrastructure.boardRuntime.listPendingWrites(this.binding(board), policy).catch(()=>null) : null;
    const observedCatalog = observation?.skills.filter((skill)=>skill.approved && skill.userManageable) ?? [];
    const catalog = [...new Set([...observedCatalog.map((skill)=>skill.name), ...board.desiredSkills, ...board.observedSkills])].sort((a,b)=>a.localeCompare(b)).map((name)=>observedCatalog.find((skill)=>skill.name===name) ?? { name, description: "", category: "Other", provenance: "unknown" as const });
    return {
      pluginId: "org.originpost.hermes-boards", configured: Boolean(observation?.configured), healthy: Boolean(observation?.healthy && board.status === "ready"), status: board.status,
      modelReady: observation?.modelReady ?? false,
      memory: { isolation: "dedicated-profile", enabled: observation?.memory.enabled ?? false, writeApproval: observation?.memory.writeApproval ?? false, contentExposed: false },
      isolation: {
        mode: "profile-scoped",
        verified: observation?.isolation.verified ?? false,
        profileScoped: observation?.isolation.profileScoped ?? false,
        memoryScoped: observation?.isolation.memoryScoped ?? false,
        skillsScoped: observation?.isolation.skillsScoped ?? false,
        stateScoped: observation?.isolation.stateScoped ?? false,
        externalSkillsBlocked: observation?.isolation.externalSkillsBlocked ?? false,
        unsafeToolsBlocked: observation?.isolation.unsafeToolsBlocked ?? false,
        filesystemSandbox: false,
      },
      skillWriteApproval: observation?.memory.writeApproval ?? false,
      skills: catalog.map((skill)=>({ name: skill.name, description: skill.description, category: skill.category, provenance: skill.provenance, enabled: board.desiredSkills.includes(skill.name), applied: board.observedSkills.includes(skill.name) && board.observedConfigurationEpoch === board.configurationEpoch })),
      pending: board.observedConfigurationEpoch !== board.configurationEpoch,
      decisionPending: Boolean(board.pendingPluginDecision),
      pendingManagementAvailable: pendingWrites !== null,
      pendingWrites: pendingWrites ?? [],
      ...(observation?.model ? { model: observation.model } : {}),
      safeToolsets: observation?.policyCompliant ? observation.safeToolsets : [],
      ...(board.lastCheckedAt ? { lastCheckedAt: board.lastCheckedAt } : {}),
    };
  }

  async pendingWrite(workspaceId: string, brandId: string, id: string, subsystemValue: string, pendingId: string, actor: Actor) {
    this.owner(actor);
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    const board = await this.board(workspaceId, brandId, id);
    if (board.status === "archived") throw new DomainError("Archived Boards cannot manage pending writes.", "agent_board_archived", 409);
    const subsystem = subsystemValue === "memory" || subsystemValue === "skills" ? subsystemValue : null;
    if (!subsystem || !/^[a-f0-9]{8}$/u.test(pendingId)) throw new DomainError("Pending Board write not found.", "agent_board_pending_not_found", 404);
    try { return { pendingWrite: await this.infrastructure.boardRuntime.pendingWriteDetail(this.binding(board), { configurationEpoch: board.configurationEpoch, purpose: board.purpose, enabledSkills: board.desiredSkills }, subsystem, pendingId) }; }
    catch { throw new ServiceUnavailableException("The pending Board write could not be loaded safely."); }
  }

  async decidePendingWrite(workspaceId: string, brandId: string, id: string, subsystemValue: string, pendingId: string, dto: DecideBoardPendingWriteDto, idempotencyKey: string | undefined, actor: Actor) {
    this.owner(actor);
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    await this.requireActiveBrand(workspaceId, brandId);
    const board = await this.board(workspaceId, brandId, id);
    if (board.status === "archived") throw new DomainError("Archived Boards cannot manage pending writes.", "agent_board_archived", 409);
    const subsystem = subsystemValue === "memory" || subsystemValue === "skills" ? subsystemValue : null;
    if (!subsystem || !/^[a-f0-9]{8}$/u.test(pendingId)) throw new DomainError("Pending Board write not found.", "agent_board_pending_not_found", 404);
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/u.test(idempotencyKey)) throw new DomainError("Use a valid Idempotency-Key for this decision.", "idempotency_key_required", 428);
    const decisionKey = agentRunHash({ boardId: board.id, subsystem, pendingId, decision: dto.decision, expectedSha256: dto.expectedSha256, idempotencyKey });
    const idempotencyScopeKey = agentRunHash({ boardId: board.id, idempotencyKey });
    const queued = queueAgentBoardPluginDecision({ current: board, actor, subsystem, pendingId, decision: dto.decision, expectedSha256: dto.expectedSha256, idempotencyKey, decisionKey, idempotencyScopeKey });
    if (!queued.alreadyQueued && !queued.alreadyApplied) {
      const saved = await this.infrastructure.agentBoardRepository.update(queued.board, board.version, queued.event, queued.outbox);
      if (!saved) throw new DomainError("This Board changed. Review the pending write again.", "version_conflict", 409);
    }
    return { ok: true, queued: !queued.alreadyApplied, pending: !queued.alreadyApplied, decisionKey, replayed: queued.alreadyQueued || queued.alreadyApplied };
  }

  async skill(workspaceId: string, brandId: string, id: string, expectedVersion: number | undefined, dto: UpdateBoardSkillDto, actor: Actor) {
    this.owner(actor);
    const current = await this.board(workspaceId, brandId, id);
    const desired = new Set(current.desiredSkills); dto.enabled ? desired.add(dto.name) : desired.delete(dto.name);
    return this.skills(workspaceId, brandId, id, expectedVersion, [...desired], actor);
  }

  async skills(workspaceId: string, brandId: string, id: string, expectedVersion: number | undefined, enabledSkills: string[], actor: Actor) {
    this.owner(actor);
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board version.", "version_required", 428);
    await this.requireActiveBrand(workspaceId, brandId);
    const current = await this.board(workspaceId, brandId, id);
    const additions = enabledSkills.filter((name) => !current.desiredSkills.includes(name));
    if (additions.length > 0) {
      const observation = await this.infrastructure.boardRuntime.inspect(this.binding(current), { configurationEpoch: current.configurationEpoch, purpose: current.purpose, enabledSkills: current.desiredSkills }).catch(()=>null);
      const approvedInstalled = new Set(observation?.skills.filter((skill)=>skill.approved && skill.userManageable).map((skill)=>skill.name) ?? []);
      if (additions.some((name)=>!approvedInstalled.has(name))) throw new DomainError("A requested skill is not installed and operator-approved.", "agent_board_skill_not_approved", 409);
    }
    const result = queueAgentBoardReconcile({ current, actor, expectedVersion, desiredSkills: enabledSkills });
    const saved = await this.infrastructure.agentBoardRepository.update(result.board, expectedVersion, result.event, result.outbox);
    if (!saved) throw new DomainError("This Board changed. Refresh and try again.", "version_conflict", 409);
    return { board: publicBoard(saved), pending: true, desiredSkills: saved.desiredSkills };
  }

  async reconcile(workspaceId: string, brandId: string, id: string, expectedVersion: number | undefined, actor: Actor) {
    this.owner(actor);
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board version.", "version_required", 428);
    await this.requireActiveBrand(workspaceId, brandId);
    const current = await this.board(workspaceId, brandId, id);
    const result = queueAgentBoardReconcile({ current, actor, expectedVersion, desiredSkills: current.desiredSkills });
    const saved = await this.infrastructure.agentBoardRepository.update(result.board, expectedVersion, result.event, result.outbox);
    if (!saved) throw new DomainError("This Board changed. Refresh and try again.", "version_conflict", 409);
    return { board: publicBoard(saved), pending: true };
  }

  async test(workspaceId: string, brandId: string, id: string, actor: Actor) {
    this.owner(actor);
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    await this.requireActiveBrand(workspaceId, brandId);
    const current = await this.board(workspaceId, brandId, id);
    if (current.status === "archived") throw new DomainError("Archived Boards cannot run.", "agent_board_archived", 409);
    if (current.pendingPluginDecision) throw new DomainError("A Board plugin decision is still being applied.", "agent_board_plugin_decision_pending", 409);
    try {
      const observed = await this.infrastructure.boardRuntime.inspect(this.binding(current), { configurationEpoch: current.configurationEpoch, purpose: current.purpose, enabledSkills: current.desiredSkills });
      const applied = observed.skills.filter((skill)=>skill.approved && skill.userManageable && skill.enabled).map((skill)=>skill.name);
      const next = observeAgentBoardPlugin({ current, configurationEpoch: current.configurationEpoch, healthy: observed.healthy && observed.configured && observed.policyCompliant, observedSkills: applied, ...(!observed.healthy ? { errorCode: !observed.policyCompliant ? "hermes_policy_drift" : !observed.modelReady ? "hermes_model_required" : observed.restartRequired ? "hermes_restart_required" : "profile_unavailable" } : {}) });
      const saved = await this.infrastructure.agentBoardRepository.update(next, current.version, this.audit(workspaceId, actor, "agent-board.plugin-tested", { boardId: current.id, healthy: next.status === "ready", configurationEpoch: current.configurationEpoch, observedSkillCount: applied.length }));
      if (!saved) throw new DomainError("This Board changed during the connection test. Refresh and try again.", "version_conflict", 409);
      return { ok: saved.status === "ready", board: publicBoard(saved), restartRequired: observed.restartRequired };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = this.safeCode(error);
      const next = observeAgentBoardPlugin({ current, configurationEpoch: current.configurationEpoch, healthy: false, errorCode: code });
      const saved = await this.infrastructure.agentBoardRepository.update(next, current.version, this.audit(workspaceId, actor, "agent-board.plugin-tested", { boardId: current.id, healthy: false, errorCode: code, configurationEpoch: current.configurationEpoch }));
      return { ok: false, board: publicBoard(saved ?? current), error: { code, message: "This Board's internal Hermes runtime is not ready." } };
    }
  }

  async run(workspaceId: string, brandId: string, id: string, prompt: string, actor: Actor) {
    if (!can(actor.role, "content:create")) throw new ForbiddenException("You cannot run Board actions.");
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    await this.requireActiveBrand(workspaceId, brandId);
    const board = await this.board(workspaceId, brandId, id);
    if (board.status !== "ready" || board.pendingPluginDecision || board.observedConfigurationEpoch !== board.configurationEpoch) throw new DomainError("This Board is not ready. Finish or retry its Hermes setup first.", "agent_board_not_ready", 409);
    const started = Date.now(); const at = new Date().toISOString(); const requestSha256 = agentRunHash({ prompt, purpose: board.purpose, configurationEpoch: board.configurationEpoch });
    try {
      const result = await this.infrastructure.boardRuntime.run(this.binding(board), { prompt, purpose: board.purpose, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch, enabledSkills: board.desiredSkills });
      const run: AgentBoardRunLedgerEntry = { id: `board_run_${randomUUID()}`, workspaceId, brandId, boardId: id, configurationEpoch: board.configurationEpoch, model: result.model, status: "succeeded", requestSha256, responseSha256: agentRunHash(result.text), ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}), ...(result.usage?.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}), latencyMs: Math.max(0, Date.now()-started), createdBy: actor.id, createdAt: at };
      const recorded = await this.infrastructure.agentBoardRepository.recordRun(run, this.audit(workspaceId, actor, "agent-board.run-succeeded", { boardId: id, runId: run.id, configurationEpoch: run.configurationEpoch, model: run.model, latencyMs: run.latencyMs, inputTokens: run.inputTokens, outputTokens: run.outputTokens }), { configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch });
      if (!recorded) throw new DomainError("This Board changed while Hermes was running, so the stale result was discarded.", "agent_board_run_stale", 409);
      return { runId: run.id, model: result.model, text: result.text, usage: result.usage };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = this.safeCode(error);
      const run: AgentBoardRunLedgerEntry = { id: `board_run_${randomUUID()}`, workspaceId, brandId, boardId: id, configurationEpoch: board.configurationEpoch, model: "hermes-agent", status: "failed", requestSha256, latencyMs: Math.max(0, Date.now()-started), errorCode: code, createdBy: actor.id, createdAt: at };
      const recorded = await this.infrastructure.agentBoardRepository.recordRun(run, this.audit(workspaceId, actor, "agent-board.run-failed", { boardId: id, runId: run.id, configurationEpoch: run.configurationEpoch, errorCode: code, latencyMs: run.latencyMs }), { configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch });
      if (!recorded) throw new DomainError("This Board changed while Hermes was running, so the stale failure was discarded.", "agent_board_run_stale", 409);
      throw new ServiceUnavailableException("The Board action could not be completed. OriginPost did not use another profile or provider.");
    }
  }

  async runs(workspaceId: string, brandId: string, id: string, limit: number, actor: Actor) { this.readable(actor); await this.board(workspaceId, brandId, id); return { runs: await this.infrastructure.agentBoardRepository.listRuns(workspaceId, id, limit) }; }
}
