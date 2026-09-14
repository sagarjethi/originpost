import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { deriveBoardRuntimeSecrets, HermesBoardPluginError, type BoardRuntimeBinding, type BoardRuntimeObservation } from "@originpost/agents";
import { agentBoardTaskCommentCreateFingerprint, agentBoardTaskCreateFingerprint, agentBoardTaskExecutionFingerprint, agentBoardTaskIdempotencyHash, agentRunHash, can, createAgentBoard, createAgentBoardTask, createAgentBoardTaskComment, createAgentBoardTaskContentHandoff, createOutboxMessage, DomainError, observeAgentBoardPlugin, queueAgentBoardPluginDecision, queueAgentBoardReconcile, releaseAgentBoardTaskToAgent, reviseAgentBoard, reviseAgentBoardTask, type Actor, type AgentBoard, type AgentBoardRunLedgerEntry, type AgentBoardTask, type AgentBoardTaskContentHandoff, type AgentBoardTaskExecution, type AuditEvent } from "@originpost/domain";
import { randomUUID } from "node:crypto";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { BoardQueryDto, CreateBoardDto, CreateBoardTaskDto, DecideBoardPendingWriteDto, UpdateBoardDto, UpdateBoardSkillDto, UpdateBoardTaskDto } from "./dto/boards.dto.js";

const publicBoard = (board: AgentBoard) => ({
  id: board.id, workspaceId: board.workspaceId, brandId: board.brandId, version: board.version,
  name: board.name, slug: board.slug, purpose: board.purpose, status: board.status,
  memoryIsolation: "dedicated-profile", memoryWriteApproval: board.memoryWriteApproval, skillWriteApproval: board.skillWriteApproval,
  ...(board.lastCheckedAt ? { lastCheckedAt: board.lastCheckedAt } : {}),
  ...(board.lastError ? { attentionCode: board.lastError } : {}),
  createdAt: board.createdAt, updatedAt: board.updatedAt,
});

const publicTask = (task: AgentBoardTask, contentItemId?: string) => ({
  id: task.id, brandId: task.brandId, boardId: task.boardId, version: task.version,
  title: task.title, description: task.description, status: task.status, priority: task.priority, assignee: task.assignee,
  parentTaskIds: task.parentTaskIds,
  ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
  ...(task.resultSummary ? { resultSummary: task.resultSummary } : {}),
  ...(task.dueAt ? { dueAt: task.dueAt } : {}),
  ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  ...(contentItemId ? { contentItemId } : {}),
  createdBy: task.createdBy, createdAt: task.createdAt, updatedAt: task.updatedAt,
});

const publicTaskComment = (comment: Awaited<ReturnType<OriginPostInfrastructure["agentBoardTaskRepository"]["listComments"]>>[number]) => ({
  id: comment.id, taskId: comment.taskId, body: comment.body, authorName: comment.authorName, createdAt: comment.createdAt,
});

const publicTaskExecution = (execution: AgentBoardTaskExecution, contentItemId?: string) => ({
  id: execution.id, taskId: execution.taskId, status: execution.status,
  ...(execution.model ? { model: execution.model } : {}),
  ...(execution.resultText ? { resultText: execution.resultText } : {}),
  ...(execution.errorSummary ? { errorSummary: execution.errorSummary } : {}),
  ...(contentItemId ? { contentItemId } : {}),
  createdAt: execution.createdAt, updatedAt: execution.updatedAt,
});

const publicContentHandoff = (handoff: AgentBoardTaskContentHandoff) => ({
  id: handoff.id, taskId: handoff.taskId, executionId: handoff.executionId, contentItemId: handoff.contentItemId,
  responseSha256: handoff.responseSha256, createdBy: handoff.createdBy, createdAt: handoff.createdAt,
});

@Injectable()
export class BoardsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, private readonly config: ConfigService) {}
  private readable(actor: Actor) { if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view Boards."); }
  private taskReadable(actor: Actor) { if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:read")) throw new ForbiddenException("You cannot view Board tasks."); }
  private taskWritable(actor: Actor) { if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:create")) throw new ForbiddenException("You cannot manage Board tasks."); }
  private taskApprover(actor: Actor) { if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:approve")) throw new ForbiddenException("A manager or owner must hand Board work into Content."); }
  private owner(actor: Actor) { if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "workspace:manage")) throw new ForbiddenException("Only a workspace owner can manage Boards."); }
  private audit(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent { return { id: `evt_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human", action, detail, createdAt: new Date().toISOString() }; }
  private async board(workspaceId: string, brandId: string, id: string) { const board = await this.infrastructure.agentBoardRepository.get(workspaceId, id); if (!board || board.brandId !== brandId) throw new DomainError("Board not found.", "agent_board_not_found", 404); return board; }
  private async requireActiveBrand(workspaceId: string, brandId: string) { const brand = await this.infrastructure.organizationRepository.getBrand(workspaceId, brandId); if (!brand || brand.status !== "active") throw new DomainError("Active brand not found.", "brand_not_found", 404); }
  private binding(board: AgentBoard): BoardRuntimeBinding {
    const secret = this.config.get<string>("HERMES_BOARD_SECRET") ?? "";
    const derived = deriveBoardRuntimeSecrets(secret, { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, capabilityEpoch: board.capabilityEpoch });
    return { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, profile: board.hermesProfile, kanbanBoardRef: board.hermesBoardRef, capabilityEpoch: board.capabilityEpoch, ...derived };
  }
  private safeCode(error: unknown) { return error instanceof HermesBoardPluginError ? error.code : "runtime_unavailable"; }

  async list(workspaceId: string, query: BoardQueryDto, actor: Actor) { this.readable(actor); return { boards: (await this.infrastructure.agentBoardRepository.list(workspaceId, query.brandId, query.includeArchived)).map(publicBoard) }; }
  async get(workspaceId: string, brandId: string, id: string, actor: Actor) { this.readable(actor); return { board: publicBoard(await this.board(workspaceId, brandId, id)) }; }

  private async scopedTask(workspaceId: string, brandId: string, boardId: string, taskId: string) {
    const task = await this.infrastructure.agentBoardTaskRepository.get(workspaceId, brandId, boardId, taskId);
    if (!task) throw new DomainError("Board task not found.", "agent_board_task_not_found", 404);
    return task;
  }

  private async parentsComplete(workspaceId: string, brandId: string, boardId: string, parentTaskIds: string[]) {
    let complete = true;
    for (const parentTaskId of parentTaskIds) {
      const parent = await this.infrastructure.agentBoardTaskRepository.get(workspaceId, brandId, boardId, parentTaskId);
      if (!parent) throw new DomainError("A Board task dependency does not exist in this Board.", "agent_board_task_dependencies_invalid", 404);
      if (!parent.completedAt || !["done", "archived"].includes(parent.status)) complete = false;
    }
    return complete;
  }

  private async taskHandoff(task: AgentBoardTask) {
    return task.lastExecutionId ? this.infrastructure.agentBoardTaskRepository.getContentHandoffByExecution(task.workspaceId, task.brandId, task.boardId, task.id, task.lastExecutionId) : null;
  }

  private async handoffResponse(handoff: AgentBoardTaskContentHandoff, task: AgentBoardTask, replayed: boolean) {
    const contentItem = await this.infrastructure.repository.get(handoff.workspaceId, handoff.contentItemId);
    if (!contentItem || contentItem.brandId !== handoff.brandId) throw new DomainError("The Board handoff provenance is incomplete.", "agent_board_task_handoff_corrupt", 409);
    return { task: publicTask(task, handoff.contentItemId), contentItem, handoff: publicContentHandoff(handoff), replayed };
  }

  async tasks(workspaceId: string, brandId: string, boardId: string, includeArchived: boolean, actor: Actor) {
    this.taskReadable(actor);
    await this.board(workspaceId, brandId, boardId);
    const tasks = await this.infrastructure.agentBoardTaskRepository.list(workspaceId, brandId, boardId, includeArchived);
    return { tasks: await Promise.all(tasks.map(async (task) => publicTask(task, (await this.taskHandoff(task))?.contentItemId))) };
  }

  async task(workspaceId: string, brandId: string, boardId: string, taskId: string, actor: Actor) {
    this.taskReadable(actor);
    await this.board(workspaceId, brandId, boardId);
    const task = await this.scopedTask(workspaceId, brandId, boardId, taskId);
    return { task: publicTask(task, (await this.taskHandoff(task))?.contentItemId) };
  }

  async createTask(workspaceId: string, brandId: string, boardId: string, idempotencyKey: string | undefined, dto: CreateBoardTaskDto, actor: Actor) {
    this.taskWritable(actor);
    const board = await this.board(workspaceId, brandId, boardId);
    if (board.status === "archived") throw new DomainError("Archived Boards are read-only.", "agent_board_archived", 409);
    await this.requireActiveBrand(workspaceId, brandId);
    const createValues = {
      title: dto.title,
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.priority === undefined ? {} : { priority: dto.priority }),
      ...(dto.assignee === undefined ? {} : { assignee: dto.assignee }),
      ...(dto.parentTaskIds === undefined ? {} : { parentTaskIds: dto.parentTaskIds }),
      ...(dto.dueAt === undefined ? {} : { dueAt: dto.dueAt }),
    };
    const fingerprint = agentBoardTaskCreateFingerprint(createValues);
    const keyHash = agentBoardTaskIdempotencyHash(idempotencyKey ?? "");
    const replay = await this.infrastructure.agentBoardTaskRepository.getByIdempotencyKey(workspaceId, brandId, boardId, keyHash);
    if (replay) {
      if (replay.createFingerprint !== fingerprint) throw new DomainError("This Idempotency-Key was already used with different task details.", "idempotency_key_conflict", 409);
      return { task: publicTask(replay), replayed: true };
    }
    await this.parentsComplete(workspaceId, brandId, boardId, dto.parentTaskIds ?? []);
    const made = createAgentBoardTask({ workspaceId, brandId, boardId, idempotencyKey: idempotencyKey!, actor, ...createValues });
    try {
      await this.infrastructure.agentBoardTaskRepository.create(made.task, made.event);
      return { task: publicTask(made.task), replayed: false };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "idempotency_key_conflict") throw error;
      const concurrent = await this.infrastructure.agentBoardTaskRepository.getByIdempotencyKey(workspaceId, brandId, boardId, keyHash);
      if (!concurrent || concurrent.createFingerprint !== fingerprint) throw new DomainError("This Idempotency-Key was already used with different task details.", "idempotency_key_conflict", 409);
      return { task: publicTask(concurrent), replayed: true };
    }
  }

  async updateTask(workspaceId: string, brandId: string, boardId: string, taskId: string, expectedVersion: number | undefined, dto: UpdateBoardTaskDto, actor: Actor) {
    this.taskWritable(actor);
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board task version.", "version_required", 428);
    const board = await this.board(workspaceId, brandId, boardId);
    if (board.status === "archived") throw new DomainError("Archived Boards are read-only.", "agent_board_archived", 409);
    await this.requireActiveBrand(workspaceId, brandId);
    const current = await this.scopedTask(workspaceId, brandId, boardId, taskId);
    const parentTaskIds = dto.parentTaskIds ?? current.parentTaskIds;
    const parentsComplete = await this.parentsComplete(workspaceId, brandId, boardId, parentTaskIds);
    const revised = reviseAgentBoardTask({
      current, expectedVersion, actor, parentsComplete,
      ...(dto.title === undefined ? {} : { title: dto.title }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.status === undefined ? {} : { status: dto.status }),
      ...(dto.priority === undefined ? {} : { priority: dto.priority }),
      ...(dto.assignee === undefined ? {} : { assignee: dto.assignee }),
      ...(dto.parentTaskIds === undefined ? {} : { parentTaskIds: dto.parentTaskIds }),
      ...(dto.blockedReason === undefined ? {} : { blockedReason: dto.blockedReason }),
      ...(dto.resultSummary === undefined ? {} : { resultSummary: dto.resultSummary }),
      ...(dto.dueAt === undefined ? {} : { dueAt: dto.dueAt }),
    });
    const saved = await this.infrastructure.agentBoardTaskRepository.update(revised.task, expectedVersion, revised.event);
    if (!saved) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
    return { task: publicTask(saved) };
  }

  async releaseTask(workspaceId: string, brandId: string, boardId: string, taskId: string, expectedVersion: number | undefined, idempotencyKey: string | undefined, actor: Actor) {
    if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:approve")) throw new ForbiddenException("A manager or owner must release Board-agent work.");
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board task version.", "version_required", 428);
    if (!this.infrastructure.boardRuntime) throw new ServiceUnavailableException("The internal Hermes Boards plugin is not configured.");
    const board = await this.board(workspaceId, brandId, boardId);
    if (board.status !== "ready" || board.pendingPluginDecision || board.observedConfigurationEpoch !== board.configurationEpoch) throw new DomainError("This Board is not ready. Finish or retry its Hermes setup first.", "agent_board_not_ready", 409);
    await this.requireActiveBrand(workspaceId, brandId);
    const task = await this.scopedTask(workspaceId, brandId, boardId, taskId);
    const keyHash = agentBoardTaskIdempotencyHash(idempotencyKey ?? "");
    const replay = await this.infrastructure.agentBoardTaskRepository.getExecutionByIdempotencyKey(workspaceId, brandId, boardId, taskId, keyHash);
    if (replay) {
      const priorTask = { ...task, version: replay.taskVersion - 1 };
      const fingerprint = agentBoardTaskExecutionFingerprint({ task: priorTask, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch });
      if (expectedVersion !== replay.taskVersion - 1 || replay.configurationEpoch !== board.configurationEpoch || replay.capabilityEpoch !== board.capabilityEpoch || replay.createFingerprint !== fingerprint) throw new DomainError("This Idempotency-Key was already used for a different Board task release.", "idempotency_key_conflict", 409);
      return { task: publicTask(task), execution: publicTaskExecution(replay), replayed: true };
    }
    const parentsComplete = await this.parentsComplete(workspaceId, brandId, boardId, task.parentTaskIds);
    const released = releaseAgentBoardTaskToAgent({ current: task, expectedVersion, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch, idempotencyKey: idempotencyKey!, parentsComplete, actor });
    try {
      const saved = await this.infrastructure.agentBoardTaskRepository.releaseToAgent(released.task, expectedVersion, released.execution, released.event, released.outbox);
      if (!saved) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
      return { task: publicTask(saved.task), execution: publicTaskExecution(saved.execution), replayed: false };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "idempotency_key_conflict") throw error;
      const concurrent = await this.infrastructure.agentBoardTaskRepository.getExecutionByIdempotencyKey(workspaceId, brandId, boardId, taskId, keyHash);
      if (!concurrent || concurrent.createFingerprint !== released.execution.createFingerprint) throw new DomainError("This Idempotency-Key was already used for a different Board task release.", "idempotency_key_conflict", 409);
      const current = await this.scopedTask(workspaceId, brandId, boardId, taskId);
      return { task: publicTask(current), execution: publicTaskExecution(concurrent), replayed: true };
    }
  }

  async taskExecutions(workspaceId: string, brandId: string, boardId: string, taskId: string, limit: number, actor: Actor) {
    this.taskReadable(actor);
    await this.board(workspaceId, brandId, boardId);
    await this.scopedTask(workspaceId, brandId, boardId, taskId);
    const executions = await this.infrastructure.agentBoardTaskRepository.listExecutions(workspaceId, brandId, boardId, taskId, limit);
    return { executions: await Promise.all(executions.map(async (execution) => publicTaskExecution(execution, (await this.infrastructure.agentBoardTaskRepository.getContentHandoffByExecution(workspaceId, brandId, boardId, taskId, execution.id))?.contentItemId))) };
  }

  async handoffTask(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string, expectedVersion: number | undefined, idempotencyKey: string | undefined, actor: Actor) {
    this.taskApprover(actor);
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board task version.", "version_required", 428);
    const board = await this.board(workspaceId, brandId, boardId);
    const keyHash = agentBoardTaskIdempotencyHash(idempotencyKey ?? "");
    const byKey = await this.infrastructure.agentBoardTaskRepository.getContentHandoffByIdempotencyKey(workspaceId, brandId, boardId, taskId, keyHash);
    if (byKey) {
      if (byKey.executionId !== executionId || byKey.taskVersion !== expectedVersion) throw new DomainError("This Idempotency-Key was already used for a different Board-to-Content handoff.", "idempotency_key_conflict", 409);
      return this.handoffResponse(byKey, await this.scopedTask(workspaceId, brandId, boardId, taskId), true);
    }
    const byExecution = await this.infrastructure.agentBoardTaskRepository.getContentHandoffByExecution(workspaceId, brandId, boardId, taskId, executionId);
    if (byExecution) {
      if (byExecution.taskVersion !== expectedVersion) throw new DomainError("This Board execution was already handed into Content from a different task version.", "agent_board_task_execution_handoff_exists", 409);
      return this.handoffResponse(byExecution, await this.scopedTask(workspaceId, brandId, boardId, taskId), true);
    }
    if (board.status === "archived") throw new DomainError("Archived Boards are read-only.", "agent_board_archived", 409);
    await this.requireActiveBrand(workspaceId, brandId);
    const task = await this.scopedTask(workspaceId, brandId, boardId, taskId);
    const execution = await this.infrastructure.agentBoardTaskRepository.getExecution(workspaceId, brandId, boardId, taskId, executionId);
    if (!execution) throw new DomainError("Board task execution not found.", "agent_board_task_execution_not_found", 404);
    const made = createAgentBoardTaskContentHandoff({ task, execution, expectedTaskVersion: expectedVersion, idempotencyKey: idempotencyKey!, actor });
    try {
      const saved = await this.infrastructure.agentBoardTaskRepository.createContentHandoff(task, expectedVersion, execution, made.item, made.handoff, made.event);
      if (!saved) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
      return this.handoffResponse(made.handoff, task, false);
    } catch (error) {
      if (!(error instanceof DomainError) || !["idempotency_key_conflict", "agent_board_task_execution_handoff_exists"].includes(error.code)) throw error;
      const concurrent = await this.infrastructure.agentBoardTaskRepository.getContentHandoffByIdempotencyKey(workspaceId, brandId, boardId, taskId, keyHash)
        ?? await this.infrastructure.agentBoardTaskRepository.getContentHandoffByExecution(workspaceId, brandId, boardId, taskId, executionId);
      if (!concurrent || concurrent.executionId !== executionId || concurrent.taskVersion !== expectedVersion || concurrent.createFingerprint !== made.handoff.createFingerprint) throw new DomainError("This Idempotency-Key was already used for a different Board-to-Content handoff.", "idempotency_key_conflict", 409);
      return this.handoffResponse(concurrent, await this.scopedTask(workspaceId, brandId, boardId, taskId), true);
    }
  }

  async taskComments(workspaceId: string, brandId: string, boardId: string, taskId: string, limit: number, actor: Actor) {
    this.taskReadable(actor);
    await this.board(workspaceId, brandId, boardId);
    await this.scopedTask(workspaceId, brandId, boardId, taskId);
    return { comments: (await this.infrastructure.agentBoardTaskRepository.listComments(workspaceId, brandId, boardId, taskId, limit)).map(publicTaskComment) };
  }

  async commentTask(workspaceId: string, brandId: string, boardId: string, taskId: string, expectedVersion: number | undefined, idempotencyKey: string | undefined, body: string, actor: Actor) {
    this.taskWritable(actor);
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Board task version.", "version_required", 428);
    const board = await this.board(workspaceId, brandId, boardId);
    if (board.status === "archived") throw new DomainError("Archived Boards are read-only.", "agent_board_archived", 409);
    await this.requireActiveBrand(workspaceId, brandId);
    const task = await this.scopedTask(workspaceId, brandId, boardId, taskId);
    const keyHash = agentBoardTaskIdempotencyHash(idempotencyKey ?? "");
    const fingerprint = agentBoardTaskCommentCreateFingerprint({ taskId, body, actorId: actor.id, expectedTaskVersion: expectedVersion });
    const replay = await this.infrastructure.agentBoardTaskRepository.getCommentByIdempotencyKey(workspaceId, brandId, boardId, taskId, keyHash);
    if (replay) {
      if (replay.createFingerprint !== fingerprint) throw new DomainError("This Idempotency-Key was already used with different comment details.", "idempotency_key_conflict", 409);
      return { comment: publicTaskComment(replay), replayed: true };
    }
    const created = createAgentBoardTaskComment({ task, body, idempotencyKey: idempotencyKey!, expectedTaskVersion: expectedVersion, actor });
    try {
      const saved = await this.infrastructure.agentBoardTaskRepository.appendComment(created.comment, expectedVersion, created.event);
      if (!saved) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
      return { comment: publicTaskComment(created.comment), replayed: false };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "idempotency_key_conflict") throw error;
      const concurrent = await this.infrastructure.agentBoardTaskRepository.getCommentByIdempotencyKey(workspaceId, brandId, boardId, taskId, keyHash);
      if (!concurrent || concurrent.createFingerprint !== fingerprint) throw new DomainError("This Idempotency-Key was already used with different comment details.", "idempotency_key_conflict", 409);
      return { comment: publicTaskComment(concurrent), replayed: true };
    }
  }

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
