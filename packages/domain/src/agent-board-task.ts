import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { createOutboxMessage } from "./outbox.js";
import { can } from "./permissions.js";
import { createContentItem } from "./workflow.js";
import type { Actor, AuditEvent, ContentItem, ContentItemRepository, OutboxMessageInput } from "./types.js";

export const AGENT_BOARD_TASK_STATUSES = ["triage", "todo", "ready", "running", "blocked", "review", "done", "archived"] as const;
export type AgentBoardTaskStatus = typeof AGENT_BOARD_TASK_STATUSES[number];
export type AgentBoardTaskPriority = "low" | "normal" | "high" | "urgent";
export type AgentBoardTaskAssignee = "team" | "board-agent";

export interface AgentBoardTask {
  id: string;
  workspaceId: string;
  brandId: string;
  boardId: string;
  version: number;
  title: string;
  description: string;
  status: AgentBoardTaskStatus;
  priority: AgentBoardTaskPriority;
  assignee: AgentBoardTaskAssignee;
  parentTaskIds: string[];
  idempotencyKeySha256: string;
  createFingerprint: string;
  blockedReason?: string;
  resultSummary?: string;
  dueAt?: string;
  completedAt?: string;
  implementedBy?: string;
  reviewedBy?: string;
  activeExecutionId?: string;
  lastExecutionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBoardTaskComment {
  id: string;
  workspaceId: string;
  brandId: string;
  boardId: string;
  taskId: string;
  body: string;
  idempotencyKeySha256: string;
  createFingerprint: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export type AgentBoardTaskExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "uncertain";

export interface AgentBoardTaskExecution {
  id: string;
  workspaceId: string;
  brandId: string;
  boardId: string;
  taskId: string;
  version: number;
  status: AgentBoardTaskExecutionStatus;
  configurationEpoch: number;
  capabilityEpoch: number;
  taskVersion: number;
  idempotencyKeySha256: string;
  createFingerprint: string;
  requestSha256: string;
  claimId?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  resultText?: string;
  responseSha256?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  errorCode?: string;
  errorSummary?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBoardTaskContentHandoff {
  id: string;
  workspaceId: string;
  brandId: string;
  boardId: string;
  taskId: string;
  executionId: string;
  contentItemId: string;
  taskVersion: number;
  executionVersion: number;
  responseSha256: string;
  idempotencyKeySha256: string;
  createFingerprint: string;
  createdBy: string;
  createdAt: string;
}

export interface AgentBoardTaskRepository {
  list(workspaceId: string, brandId: string, boardId: string, includeArchived?: boolean): Promise<AgentBoardTask[]>;
  get(workspaceId: string, brandId: string, boardId: string, taskId: string): Promise<AgentBoardTask | null>;
  getByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, idempotencyKeySha256: string): Promise<AgentBoardTask | null>;
  create(task: AgentBoardTask, event: AuditEvent): Promise<void>;
  update(task: AgentBoardTask, expectedVersion: number, event: AuditEvent): Promise<AgentBoardTask | null>;
  listComments(workspaceId: string, brandId: string, boardId: string, taskId: string, limit?: number): Promise<AgentBoardTaskComment[]>;
  getCommentByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string): Promise<AgentBoardTaskComment | null>;
  appendComment(comment: AgentBoardTaskComment, expectedTaskVersion: number, event: AuditEvent): Promise<boolean>;
  getExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string): Promise<AgentBoardTaskExecution | null>;
  getExecutionByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string): Promise<AgentBoardTaskExecution | null>;
  listExecutions(workspaceId: string, brandId: string, boardId: string, taskId: string, limit?: number): Promise<AgentBoardTaskExecution[]>;
  releaseToAgent(task: AgentBoardTask, expectedVersion: number, execution: AgentBoardTaskExecution, event: AuditEvent, outbox: OutboxMessageInput): Promise<{ task: AgentBoardTask; execution: AgentBoardTaskExecution } | null>;
  claimExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string, claimId: string, leaseSeconds: number): Promise<{ task: AgentBoardTask; execution: AgentBoardTaskExecution } | null>;
  finishExecution(task: AgentBoardTask, expectedTaskVersion: number, execution: AgentBoardTaskExecution, claimId: string, event: AuditEvent): Promise<boolean>;
  recoverExpiredExecutions(limit?: number): Promise<number>;
  getContentHandoffByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string): Promise<AgentBoardTaskContentHandoff | null>;
  getContentHandoffByExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string): Promise<AgentBoardTaskContentHandoff | null>;
  createContentHandoff(task: AgentBoardTask, expectedTaskVersion: number, execution: AgentBoardTaskExecution, item: ContentItem, handoff: AgentBoardTaskContentHandoff, event: AuditEvent): Promise<boolean>;
}

const statusTransitions: Record<AgentBoardTaskStatus, ReadonlySet<AgentBoardTaskStatus>> = {
  triage: new Set(["todo", "archived"]),
  todo: new Set(["triage", "ready", "blocked", "archived"]),
  ready: new Set(["todo", "running", "blocked", "archived"]),
  running: new Set(["blocked", "review"]),
  blocked: new Set(["todo", "archived"]),
  review: new Set(["running", "blocked", "done"]),
  done: new Set(["archived"]),
  archived: new Set(),
};

function clean(value: string, maximum: number, label: string): string {
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw new DomainError(`${label} must contain 1–${maximum} safe characters.`, "agent_board_task_invalid");
  }
  return result;
}

function optionalText(value: string | undefined, maximum: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = value.normalize("NFC").trim();
  if (!result) return undefined;
  return clean(result, maximum, label);
}

function writable(actor: Actor): void {
  if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:create")) {
    throw new DomainError("You cannot manage Board tasks.", "permission_denied", 403);
  }
}

function normalizedAssignee(value: AgentBoardTaskAssignee | undefined): AgentBoardTaskAssignee {
  return value === "board-agent" ? "board-agent" : "team";
}

function taskIds(values: string[]): string[] {
  if (values.length > 20) throw new DomainError("A Board task can depend on at most 20 parent tasks.", "agent_board_task_dependencies_invalid");
  const cleaned = values.map((value) => value.trim());
  if (new Set(cleaned).size !== cleaned.length) throw new DomainError("A Board task dependency cannot be repeated.", "agent_board_task_dependencies_invalid");
  const result = [...cleaned].sort();
  if (result.some((value) => !/^agent_board_task_[a-f0-9-]{36}$/u.test(value))) throw new DomainError("A Board task dependency is invalid.", "agent_board_task_dependencies_invalid");
  return result;
}

function dueAt(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new DomainError("The Board task due date is invalid.", "agent_board_task_due_invalid");
  return date.toISOString();
}

function audit(task: AgentBoardTask, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent {
  return {
    id: `evt_${randomUUID()}`,
    workspaceId: task.workspaceId,
    actorId: actor.id,
    actorType: "human",
    action,
    detail: { boardId: task.boardId, taskId: task.id, brandId: task.brandId, ...detail },
    createdAt: task.updatedAt,
  };
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function agentBoardTaskIdempotencyHash(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,100}$/u.test(value)) throw new DomainError("Use a valid Idempotency-Key for this Board task.", "idempotency_key_required", 428);
  return createHash("sha256").update(value).digest("hex");
}

export function agentBoardTaskCreateFingerprint(input: {
  title: string;
  description?: string;
  priority?: AgentBoardTaskPriority;
  assignee?: AgentBoardTaskAssignee;
  parentTaskIds?: string[];
  dueAt?: string;
}): string {
  const assignee = normalizedAssignee(input.assignee);
  return fingerprint({
    title: clean(input.title, 180, "Task title"),
    description: optionalText(input.description, 8_000, "Task description") ?? "",
    priority: input.priority ?? "normal",
    assignee,
    parentTaskIds: taskIds(input.parentTaskIds ?? []),
    dueAt: dueAt(input.dueAt) ?? "",
  });
}

export function createAgentBoardTask(input: {
  workspaceId: string;
  brandId: string;
  boardId: string;
  title: string;
  description?: string;
  priority?: AgentBoardTaskPriority;
  assignee?: AgentBoardTaskAssignee;
  parentTaskIds?: string[];
  idempotencyKey: string;
  actor: Actor;
  dueAt?: string;
  now?: string;
}): { task: AgentBoardTask; event: AuditEvent } {
  writable(input.actor);
  const idempotencyKeySha256 = agentBoardTaskIdempotencyHash(input.idempotencyKey);
  const parentTaskIds = taskIds(input.parentTaskIds ?? []);
  const now = input.now ?? new Date().toISOString();
  const priority = input.priority ?? "normal";
  const assignee = normalizedAssignee(input.assignee);
  const normalizedDueAt = dueAt(input.dueAt);
  const task: AgentBoardTask = {
    id: `agent_board_task_${randomUUID()}`,
    workspaceId: clean(input.workspaceId, 100, "Workspace ID"),
    brandId: clean(input.brandId, 100, "Brand ID"),
    boardId: clean(input.boardId, 100, "Board ID"),
    version: 1,
    title: clean(input.title, 180, "Task title"),
    description: optionalText(input.description, 8_000, "Task description") ?? "",
    status: "triage",
    priority,
    assignee,
    parentTaskIds,
    idempotencyKeySha256,
    createFingerprint: agentBoardTaskCreateFingerprint(input),
    ...(normalizedDueAt ? { dueAt: normalizedDueAt } : {}),
    createdBy: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  return { task, event: audit(task, input.actor, "agent-board.task-created", { status: task.status, priority, assignee, parentTaskCount: parentTaskIds.length }) };
}

export function reviseAgentBoardTask(input: {
  current: AgentBoardTask;
  expectedVersion: number;
  actor: Actor;
  parentsComplete: boolean;
  title?: string;
  description?: string;
  status?: AgentBoardTaskStatus;
  priority?: AgentBoardTaskPriority;
  assignee?: AgentBoardTaskAssignee;
  parentTaskIds?: string[];
  blockedReason?: string;
  resultSummary?: string;
  dueAt?: string | null;
  now?: string;
}): { task: AgentBoardTask; event: AuditEvent } {
  writable(input.actor);
  if (input.current.status === "archived") throw new DomainError("Archived Board tasks cannot be changed.", "agent_board_task_archived", 409);
  if (input.current.version !== input.expectedVersion) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
  if (input.current.activeExecutionId) throw new DomainError("This Board task is being executed by Hermes. Wait for its receipt before changing it.", "agent_board_task_execution_active", 409);
  const nextStatus = input.status ?? input.current.status;
  if (input.assignee !== undefined && input.assignee !== input.current.assignee && !["triage", "todo"].includes(input.current.status)) throw new DomainError("Board task assignment can change only in triage or todo.", "agent_board_task_assignee_locked", 409);
  if (input.current.assignee === "board-agent" && nextStatus === "running") throw new DomainError("Release Board-agent work through the governed Hermes execution action.", "agent_board_task_release_required", 409);
  if (input.current.status === "done" && nextStatus !== "archived") throw new DomainError("Completed Board tasks are immutable and can only be archived.", "agent_board_task_completed", 409);
  if (input.current.status === "done" && nextStatus === "archived" && [input.title, input.description, input.priority, input.assignee, input.parentTaskIds, input.blockedReason, input.resultSummary, input.dueAt].some((value) => value !== undefined)) {
    throw new DomainError("Archive a completed Board task without changing its approved fields.", "agent_board_task_archive_only", 409);
  }
  if (nextStatus === "archived" && !can(input.actor.role, "content:approve")) throw new DomainError("Only a manager or owner can archive Board tasks.", "permission_denied", 403);
  if (nextStatus !== input.current.status && !statusTransitions[input.current.status].has(nextStatus)) {
    throw new DomainError(`Board task cannot move from ${input.current.status} to ${nextStatus}.`, "agent_board_task_transition_invalid", 409);
  }
  if (input.assignee !== undefined && input.assignee !== input.current.assignee && !["triage", "todo"].includes(input.current.status)) {
    throw new DomainError("A Board task can be reassigned only while it is in triage or todo.", "agent_board_task_assignee_locked", 409);
  }
  if (input.current.assignee === "board-agent" && nextStatus === "running") {
    throw new DomainError("Release Board-agent work through the governed Hermes execution action.", "agent_board_task_release_required", 409);
  }
  if (["ready", "running", "review", "done"].includes(nextStatus) && !input.parentsComplete) {
    throw new DomainError("Finish this task's dependencies before moving it forward.", "agent_board_task_dependencies_open", 409);
  }
  const nextBlockedReason = nextStatus === "blocked" ? optionalText(input.blockedReason ?? input.current.blockedReason, 2_000, "Blocked reason") : undefined;
  if (nextStatus === "blocked" && !nextBlockedReason) throw new DomainError("Explain why this Board task is blocked.", "agent_board_task_block_reason_required", 409);
  const nextResult = input.resultSummary === undefined ? input.current.resultSummary : optionalText(input.resultSummary, 4_000, "Task result");
  if (nextStatus === "done" && !nextResult) throw new DomainError("Add a completion result before marking this Board task done.", "agent_board_task_result_required", 409);
  if (nextStatus === "done" && input.current.status !== "done") {
    if (!can(input.actor.role, "content:approve")) throw new DomainError("A manager or owner must approve completed Board work.", "permission_denied", 403);
    if (!input.current.implementedBy) throw new DomainError("Record an implementer before approving this Board task.", "agent_board_task_implementer_required", 409);
    if (input.current.implementedBy === input.actor.id) throw new DomainError("The person who performed the work cannot be its sole approver.", "agent_board_task_distinct_reviewer_required", 409);
  }
  const now = input.now ?? new Date().toISOString();
  const nextParentTaskIds = input.parentTaskIds === undefined ? input.current.parentTaskIds : taskIds(input.parentTaskIds);
  const dependenciesChanged = nextParentTaskIds.join("\u0000") !== input.current.parentTaskIds.join("\u0000");
  if (dependenciesChanged && !["triage", "todo", "blocked"].includes(input.current.status)) throw new DomainError("Dependencies can change only while a Board task is in triage, todo, or blocked.", "agent_board_task_dependencies_locked", 409);
  const task: AgentBoardTask = {
    ...input.current,
    version: input.current.version + 1,
    title: input.title === undefined ? input.current.title : clean(input.title, 180, "Task title"),
    description: input.description === undefined ? input.current.description : optionalText(input.description, 8_000, "Task description") ?? "",
    status: nextStatus,
    priority: input.priority ?? input.current.priority,
    assignee: input.assignee ?? input.current.assignee,
    parentTaskIds: nextParentTaskIds,
    ...(input.dueAt === undefined ? (input.current.dueAt ? { dueAt: input.current.dueAt } : {}) : input.dueAt === null || !input.dueAt.trim() ? {} : { dueAt: dueAt(input.dueAt)! }),
    ...(nextBlockedReason ? { blockedReason: nextBlockedReason } : {}),
    ...(nextResult ? { resultSummary: nextResult } : {}),
    ...(nextStatus === "done" ? { completedAt: input.current.completedAt ?? now } : input.current.completedAt ? { completedAt: input.current.completedAt } : {}),
    ...(nextStatus === "running" && input.current.status !== "running" ? { implementedBy: input.actor.id } : input.current.implementedBy ? { implementedBy: input.current.implementedBy } : {}),
    ...(nextStatus === "done" && input.current.status !== "done" ? { reviewedBy: input.actor.id } : input.current.reviewedBy ? { reviewedBy: input.current.reviewedBy } : {}),
    updatedAt: now,
  };
  if (!nextBlockedReason) delete task.blockedReason;
  if (input.dueAt !== undefined && (input.dueAt === null || !input.dueAt.trim())) delete task.dueAt;
  return { task, event: audit(task, input.actor, nextStatus === "archived" ? "agent-board.task-archived" : "agent-board.task-updated", { fromStatus: input.current.status, toStatus: nextStatus, priority: task.priority, assignee: task.assignee, ...(nextStatus === "done" ? { approval: "approved", implementerId: task.implementedBy, reviewerId: task.reviewedBy } : {}) }) };
}

export function agentBoardTaskExecutionFingerprint(input: { task: AgentBoardTask; configurationEpoch: number; capabilityEpoch: number }): string {
  return fingerprint({
    taskId: input.task.id,
    taskVersion: input.task.version,
    title: input.task.title,
    description: input.task.description,
    parentTaskIds: input.task.parentTaskIds,
    configurationEpoch: input.configurationEpoch,
    capabilityEpoch: input.capabilityEpoch,
  });
}

export function releaseAgentBoardTaskToAgent(input: {
  current: AgentBoardTask;
  expectedVersion: number;
  configurationEpoch: number;
  capabilityEpoch: number;
  idempotencyKey: string;
  parentsComplete: boolean;
  actor: Actor;
  now?: string;
}): { task: AgentBoardTask; execution: AgentBoardTaskExecution; event: AuditEvent; outbox: OutboxMessageInput } {
  if ((input.actor.actorType && input.actor.actorType !== "human") || !can(input.actor.role, "content:approve")) throw new DomainError("A manager or owner must release Board-agent work.", "permission_denied", 403);
  if (input.current.version !== input.expectedVersion) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
  if (input.current.status !== "ready" || input.current.assignee !== "board-agent") throw new DomainError("Only a ready task assigned to the Board agent can be released.", "agent_board_task_not_releasable", 409);
  if (input.current.activeExecutionId) throw new DomainError("This Board task already has an active execution.", "agent_board_task_execution_active", 409);
  if (!input.parentsComplete) throw new DomainError("Finish this task's dependencies before releasing it.", "agent_board_task_dependencies_open", 409);
  if (!Number.isSafeInteger(input.configurationEpoch) || input.configurationEpoch < 1 || !Number.isSafeInteger(input.capabilityEpoch) || input.capabilityEpoch < 1) throw new DomainError("This Board's execution policy is invalid.", "agent_board_task_execution_policy_invalid", 409);
  const now = input.now ?? new Date().toISOString();
  const id = `board_task_execution_${randomUUID()}`;
  const task: AgentBoardTask = {
    ...input.current,
    version: input.current.version + 1,
    status: "running",
    implementedBy: "board-agent",
    activeExecutionId: id,
    updatedAt: now,
  };
  const createFingerprint = agentBoardTaskExecutionFingerprint({ task: input.current, configurationEpoch: input.configurationEpoch, capabilityEpoch: input.capabilityEpoch });
  const execution: AgentBoardTaskExecution = {
    id,
    workspaceId: task.workspaceId,
    brandId: task.brandId,
    boardId: task.boardId,
    taskId: task.id,
    version: 1,
    status: "queued",
    configurationEpoch: input.configurationEpoch,
    capabilityEpoch: input.capabilityEpoch,
    taskVersion: task.version,
    idempotencyKeySha256: agentBoardTaskIdempotencyHash(input.idempotencyKey),
    createFingerprint,
    requestSha256: createFingerprint,
    createdBy: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  return {
    task,
    execution,
    event: audit(task, input.actor, "agent-board.task-released", { executionId: id, configurationEpoch: input.configurationEpoch, capabilityEpoch: input.capabilityEpoch, assignee: "board-agent" }),
    outbox: createOutboxMessage({
      workspaceId: task.workspaceId,
      topic: "board.task.execute",
      dedupeKey: `board-task-execution:${id}`,
      payload: { workspaceId: task.workspaceId, brandId: task.brandId, boardId: task.boardId, taskId: task.id, executionId: id, taskVersion: task.version, configurationEpoch: input.configurationEpoch, capabilityEpoch: input.capabilityEpoch },
      now,
    }),
  };
}

export function claimAgentBoardTaskExecution(current: AgentBoardTaskExecution, claimId: string, leaseSeconds: number, now = new Date().toISOString()): AgentBoardTaskExecution {
  if (current.status !== "queued") throw new DomainError("This Board task execution is not queued.", "agent_board_task_execution_not_queued", 409);
  if (!/^[A-Za-z0-9_-]{16,120}$/u.test(claimId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) throw new DomainError("The Board task execution lease is invalid.", "agent_board_task_execution_lease_invalid");
  return { ...current, version: current.version + 1, status: "running", claimId, leaseExpiresAt: new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString(), startedAt: now, updatedAt: now };
}

export function finishAgentBoardTaskExecution(input: {
  task: AgentBoardTask;
  execution: AgentBoardTaskExecution;
  outcome: "succeeded" | "failed" | "uncertain";
  model?: string;
  resultText?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  errorCode?: string;
  errorSummary?: string;
  now?: string;
}): { task: AgentBoardTask; execution: AgentBoardTaskExecution; event: AuditEvent } {
  if (input.execution.status !== "running" || !input.execution.claimId) throw new DomainError("This Board task execution has no active claim.", "agent_board_task_execution_claim_invalid", 409);
  if (input.execution.completedAt || input.execution.model || input.execution.resultText || input.execution.responseSha256 || input.execution.errorCode || input.execution.errorSummary) throw new DomainError("This Board task execution already contains terminal result fields.", "agent_board_task_execution_claim_invalid", 409);
  if (input.task.status !== "running" || input.task.assignee !== "board-agent" || input.task.activeExecutionId !== input.execution.id || input.execution.taskVersion !== input.task.version) throw new DomainError("The Board task no longer matches this execution.", "agent_board_task_execution_stale", 409);
  const now = input.now ?? new Date().toISOString();
  const normalizedResult = input.resultText?.normalize("NFC").trim();
  const resultText = normalizedResult ? clean(normalizedResult, 100_000, "Execution result") : undefined;
  if (input.outcome === "succeeded" && (!resultText || resultText.length > 100_000 || !input.model)) throw new DomainError("A successful Board task execution requires a bounded result and model.", "agent_board_task_execution_result_invalid", 409);
  if ([input.inputTokens, input.outputTokens, input.latencyMs].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new DomainError("The Board task execution usage is invalid.", "agent_board_task_execution_result_invalid", 409);
  const errorCode = input.outcome === "succeeded" ? undefined : optionalText(input.errorCode, 120, "Execution error code") ?? "execution_failed";
  const errorSummary = input.outcome === "succeeded" ? undefined : optionalText(input.errorSummary, 2_000, "Execution error") ?? "Hermes did not return a confirmed result. Review before retrying.";
  const execution: AgentBoardTaskExecution = {
    ...input.execution,
    version: input.execution.version + 1,
    status: input.outcome,
    completedAt: now,
    updatedAt: now,
    ...(input.model ? { model: clean(input.model, 200, "Execution model") } : {}),
    ...(resultText ? { resultText, responseSha256: createHash("sha256").update(resultText).digest("hex") } : {}),
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorSummary ? { errorSummary } : {}),
  };
  delete execution.claimId;
  delete execution.leaseExpiresAt;
  const task: AgentBoardTask = {
    ...input.task,
    version: input.task.version + 1,
    status: input.outcome === "succeeded" ? "review" : "blocked",
    ...(input.outcome === "succeeded" ? { resultSummary: resultText!.slice(0, 4_000) } : { blockedReason: errorSummary! }),
    lastExecutionId: input.execution.id,
    updatedAt: now,
  };
  delete task.activeExecutionId;
  if (input.outcome === "succeeded") delete task.blockedReason;
  const action = input.outcome === "succeeded" ? "agent-board.task-execution-succeeded" : input.outcome === "uncertain" ? "agent-board.task-execution-uncertain" : "agent-board.task-execution-failed";
  return { task, execution, event: { id: `evt_${randomUUID()}`, workspaceId: task.workspaceId, actorId: "board-task-worker", actorType: "system", action, detail: { boardId: task.boardId, taskId: task.id, executionId: execution.id, outcome: input.outcome, responseSha256: execution.responseSha256, errorCode: execution.errorCode }, createdAt: now } };
}

export function expireAgentBoardTaskExecution(input: { task: AgentBoardTask; execution: AgentBoardTaskExecution; reason: "queue_timeout" | "lease_expired"; now?: string }): { task: AgentBoardTask; execution: AgentBoardTaskExecution; event: AuditEvent } {
  const expectedStatus = input.reason === "queue_timeout" ? "queued" : "running";
  if (input.execution.status !== expectedStatus || input.task.status !== "running" || input.task.activeExecutionId !== input.execution.id || input.task.version !== input.execution.taskVersion) throw new DomainError("The Board task execution no longer matches its recovery fence.", "agent_board_task_execution_stale", 409);
  const now = input.now ?? new Date().toISOString();
  const errorCode = input.reason === "queue_timeout" ? "execution_queue_timeout" : "execution_lease_expired";
  const errorSummary = input.reason === "queue_timeout"
    ? "The Hermes execution was not claimed in time. Inspect the Board before retrying."
    : "The Hermes execution lease expired without a confirmed result. Inspect the Board before retrying.";
  const execution: AgentBoardTaskExecution = {
    ...input.execution,
    version: input.execution.version + 1,
    status: "uncertain",
    startedAt: input.execution.startedAt ?? input.execution.createdAt,
    completedAt: now,
    errorCode,
    errorSummary,
    updatedAt: now,
  };
  delete execution.claimId;
  delete execution.leaseExpiresAt;
  const task: AgentBoardTask = { ...input.task, version: input.task.version + 1, status: "blocked", blockedReason: errorSummary, lastExecutionId: input.execution.id, updatedAt: now };
  delete task.activeExecutionId;
  return { task, execution, event: { id: `evt_${randomUUID()}`, workspaceId: task.workspaceId, actorId: "board-task-worker", actorType: "system", action: "agent-board.task-execution-uncertain", detail: { boardId: task.boardId, taskId: task.id, executionId: execution.id, outcome: "uncertain", errorCode }, createdAt: now } };
}

export function agentBoardTaskContentHandoffFingerprint(input: { task: AgentBoardTask; execution: AgentBoardTaskExecution }): string {
  return fingerprint({
    taskId: input.task.id,
    taskVersion: input.task.version,
    executionId: input.execution.id,
    executionVersion: input.execution.version,
    responseSha256: input.execution.responseSha256,
    title: input.task.title,
    summary: input.execution.resultText?.slice(0, 2_000) ?? "",
  });
}

export function createAgentBoardTaskContentHandoff(input: {
  task: AgentBoardTask;
  execution: AgentBoardTaskExecution;
  expectedTaskVersion: number;
  idempotencyKey: string;
  actor: Actor;
  now?: string;
}): { item: ContentItem; handoff: AgentBoardTaskContentHandoff; event: AuditEvent } {
  if ((input.actor.actorType && input.actor.actorType !== "human") || !can(input.actor.role, "content:approve")) throw new DomainError("A manager or owner must hand Board work into Content.", "permission_denied", 403);
  if (input.task.version !== input.expectedTaskVersion) throw new DomainError("This Board task changed. Refresh and try again.", "version_conflict", 409);
  if (input.task.status !== "review" || input.task.assignee !== "board-agent" || input.task.activeExecutionId || input.task.lastExecutionId !== input.execution.id) throw new DomainError("Only the current Board-agent result in review can become Content.", "agent_board_task_handoff_not_ready", 409);
  if (input.execution.workspaceId !== input.task.workspaceId || input.execution.brandId !== input.task.brandId || input.execution.boardId !== input.task.boardId || input.execution.taskId !== input.task.id || input.execution.status !== "succeeded" || !input.execution.resultText || !input.execution.responseSha256) throw new DomainError("Select a successful execution receipt from this Board task.", "agent_board_task_handoff_execution_invalid", 409);
  const now = input.now ?? new Date().toISOString();
  const createFingerprint = agentBoardTaskContentHandoffFingerprint(input);
  const contentId = `content_board_${createFingerprint.slice(0, 32)}`;
  const created = createContentItem({ contentId, workspaceId: input.task.workspaceId, brandId: input.task.brandId, title: input.task.title, summary: input.execution.resultText.slice(0, 2_000), actor: input.actor, researchDepth: "standard", riskLevel: "low", now });
  const handoff: AgentBoardTaskContentHandoff = {
    id: `board_task_content_handoff_${randomUUID()}`,
    workspaceId: input.task.workspaceId,
    brandId: input.task.brandId,
    boardId: input.task.boardId,
    taskId: input.task.id,
    executionId: input.execution.id,
    contentItemId: created.item.id,
    taskVersion: input.task.version,
    executionVersion: input.execution.version,
    responseSha256: input.execution.responseSha256,
    idempotencyKeySha256: agentBoardTaskIdempotencyHash(input.idempotencyKey),
    createFingerprint,
    createdBy: input.actor.id,
    createdAt: now,
  };
  const event: AuditEvent = {
    ...created.event,
    action: "content.created-from-board-task",
    detail: { boardId: input.task.boardId, taskId: input.task.id, executionId: input.execution.id, handoffId: handoff.id, responseSha256: handoff.responseSha256, contentVersion: created.item.version },
  };
  return { item: created.item, handoff, event };
}

export function agentBoardTaskCommentCreateFingerprint(input: { taskId: string; body: string; actorId: string; expectedTaskVersion: number }): string {
  return fingerprint({ taskId: clean(input.taskId, 100, "Task ID"), body: clean(input.body, 4_000, "Comment"), actorId: clean(input.actorId, 160, "Actor ID"), expectedTaskVersion: input.expectedTaskVersion });
}

export function createAgentBoardTaskComment(input: { task: AgentBoardTask; body: string; idempotencyKey: string; expectedTaskVersion: number; actor: Actor; now?: string }): { comment: AgentBoardTaskComment; event: AuditEvent } {
  writable(input.actor);
  if (input.task.status === "archived") throw new DomainError("Archived Board tasks cannot receive comments.", "agent_board_task_archived", 409);
  const body = clean(input.body, 4_000, "Comment");
  const now = input.now ?? new Date().toISOString();
  const comment: AgentBoardTaskComment = {
    id: `agent_board_task_comment_${randomUUID()}`,
    workspaceId: input.task.workspaceId,
    brandId: input.task.brandId,
    boardId: input.task.boardId,
    taskId: input.task.id,
    body,
    idempotencyKeySha256: agentBoardTaskIdempotencyHash(input.idempotencyKey),
    createFingerprint: agentBoardTaskCommentCreateFingerprint({ taskId: input.task.id, body, actorId: input.actor.id, expectedTaskVersion: input.expectedTaskVersion }),
    authorId: input.actor.id,
    authorName: clean(input.actor.name, 160, "Author name"),
    createdAt: now,
  };
  return { comment, event: { ...audit({ ...input.task, updatedAt: now }, input.actor, "agent-board.task-commented", { commentId: comment.id }), createdAt: now } };
}

export class InMemoryAgentBoardTaskRepository implements AgentBoardTaskRepository {
  private readonly tasks = new Map<string, AgentBoardTask>();
  private readonly comments: AgentBoardTaskComment[] = [];
  private readonly executions = new Map<string, AgentBoardTaskExecution>();
  private readonly contentHandoffs = new Map<string, AgentBoardTaskContentHandoff>();
  private readonly events: AuditEvent[] = [];
  private contentHandoffTail: Promise<void> = Promise.resolve();

  constructor(private readonly appendOutbox: (messages: OutboxMessageInput[]) => void = () => undefined, private readonly clock: () => Date = () => new Date(), private readonly contentItems?: ContentItemRepository) {}

  async list(workspaceId: string, brandId: string, boardId: string, includeArchived = false) {
    return [...this.tasks.values()].filter((task) => task.workspaceId === workspaceId && task.brandId === brandId && task.boardId === boardId && (includeArchived || task.status !== "archived")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map((task) => structuredClone(task));
  }

  async get(workspaceId: string, brandId: string, boardId: string, taskId: string) {
    const task = this.tasks.get(taskId);
    return task?.workspaceId === workspaceId && task.brandId === brandId && task.boardId === boardId ? structuredClone(task) : null;
  }

  async getByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, idempotencyKeySha256: string) {
    const task = [...this.tasks.values()].find((value) => value.workspaceId === workspaceId && value.brandId === brandId && value.boardId === boardId && value.idempotencyKeySha256 === idempotencyKeySha256);
    return task ? structuredClone(task) : null;
  }

  async create(task: AgentBoardTask, event: AuditEvent) {
    if (this.tasks.has(task.id)) throw new DomainError("Board task already exists.", "agent_board_task_exists", 409);
    if ([...this.tasks.values()].some((value) => value.workspaceId === task.workspaceId && value.boardId === task.boardId && value.idempotencyKeySha256 === task.idempotencyKeySha256)) throw new DomainError("This Board task Idempotency-Key already exists.", "idempotency_key_conflict", 409);
    if (task.parentTaskIds.some((id) => { const parent = this.tasks.get(id); return !parent || parent.workspaceId !== task.workspaceId || parent.brandId !== task.brandId || parent.boardId !== task.boardId; })) throw new DomainError("A Board task dependency does not exist in this Board.", "agent_board_task_dependencies_invalid", 409);
    this.tasks.set(task.id, structuredClone(task));
    this.events.push(structuredClone(event));
  }

  async update(task: AgentBoardTask, expectedVersion: number, event: AuditEvent) {
    const current = this.tasks.get(task.id);
    if (!current || current.workspaceId !== task.workspaceId || current.brandId !== task.brandId || current.boardId !== task.boardId || current.version !== expectedVersion) return null;
    if (task.workspaceId !== current.workspaceId || task.brandId !== current.brandId || task.boardId !== current.boardId || task.idempotencyKeySha256 !== current.idempotencyKeySha256 || task.createFingerprint !== current.createFingerprint) throw new DomainError("A Board task's identity cannot be changed.", "agent_board_task_identity_immutable", 409);
    const parentTasks = task.parentTaskIds.map((id) => this.tasks.get(id));
    if (task.parentTaskIds.includes(task.id) || parentTasks.some((parent) => !parent || parent.workspaceId !== task.workspaceId || parent.brandId !== task.brandId || parent.boardId !== task.boardId)) throw new DomainError("A Board task dependency does not exist in this Board.", "agent_board_task_dependencies_invalid", 409);
    const children = new Map<string, string[]>();
    for (const value of this.tasks.values()) {
      if (value.workspaceId !== task.workspaceId || value.brandId !== task.brandId || value.boardId !== task.boardId || value.id === task.id) continue;
      for (const parentId of value.parentTaskIds) children.set(parentId, [...(children.get(parentId) ?? []), value.id]);
    }
    for (const parentId of task.parentTaskIds) {
      const pending = [task.id];
      const visited = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (id === parentId) throw new DomainError("Board task dependencies cannot form a cycle.", "agent_board_task_dependency_cycle", 409);
        if (visited.has(id)) continue;
        visited.add(id);
        pending.push(...(children.get(id) ?? []));
      }
    }
    if (["ready", "running", "review", "done"].includes(task.status) && parentTasks.some((parent) => !parent?.completedAt || !["done", "archived"].includes(parent.status))) throw new DomainError("Finish this task's dependencies before moving it forward.", "agent_board_task_dependencies_open", 409);
    if (task.status === "archived" && !current.completedAt && [...this.tasks.values()].some((value) => value.workspaceId === task.workspaceId && value.brandId === task.brandId && value.boardId === task.boardId && value.status !== "archived" && value.status !== "done" && value.parentTaskIds.includes(task.id))) throw new DomainError("Finish or detach active dependent tasks before archiving this unfinished task.", "agent_board_task_dependents_active", 409);
    this.tasks.set(task.id, structuredClone(task));
    this.events.push(structuredClone(event));
    return structuredClone(task);
  }

  async listComments(workspaceId: string, brandId: string, boardId: string, taskId: string, limit = 100) {
    return this.comments.filter((comment) => comment.workspaceId === workspaceId && comment.brandId === brandId && comment.boardId === boardId && comment.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-Math.max(1, Math.min(500, limit))).map((comment) => structuredClone(comment));
  }

  async getCommentByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string) {
    const comment = this.comments.find((value) => value.workspaceId === workspaceId && value.brandId === brandId && value.boardId === boardId && value.taskId === taskId && value.idempotencyKeySha256 === idempotencyKeySha256);
    return comment ? structuredClone(comment) : null;
  }

  async appendComment(comment: AgentBoardTaskComment, expectedTaskVersion: number, event: AuditEvent) {
    const task = this.tasks.get(comment.taskId);
    if (!task || task.workspaceId !== comment.workspaceId || task.brandId !== comment.brandId || task.boardId !== comment.boardId) throw new DomainError("Board task not found.", "agent_board_task_not_found", 404);
    if (task.version !== expectedTaskVersion) return false;
    const replay = this.comments.find((value) => value.workspaceId === comment.workspaceId && value.brandId === comment.brandId && value.boardId === comment.boardId && value.taskId === comment.taskId && value.idempotencyKeySha256 === comment.idempotencyKeySha256);
    if (replay) throw new DomainError("This Board task comment Idempotency-Key already exists.", "idempotency_key_conflict", 409);
    if (this.comments.some((value) => value.id === comment.id)) throw new DomainError("Board task comment already exists.", "agent_board_task_comment_exists", 409);
    this.comments.push(structuredClone(comment));
    this.events.push(structuredClone(event));
    return true;
  }

  async getExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string) {
    const value = this.executions.get(executionId);
    return value?.workspaceId === workspaceId && value.brandId === brandId && value.boardId === boardId && value.taskId === taskId ? structuredClone(value) : null;
  }

  async getExecutionByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string) {
    const value = [...this.executions.values()].find((entry) => entry.workspaceId === workspaceId && entry.brandId === brandId && entry.boardId === boardId && entry.taskId === taskId && entry.idempotencyKeySha256 === idempotencyKeySha256);
    return value ? structuredClone(value) : null;
  }

  async listExecutions(workspaceId: string, brandId: string, boardId: string, taskId: string, limit = 50) {
    return [...this.executions.values()].filter((entry) => entry.workspaceId === workspaceId && entry.brandId === brandId && entry.boardId === boardId && entry.taskId === taskId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)).slice(0,Math.max(1,Math.min(100,limit))).map((entry)=>structuredClone(entry));
  }

  async releaseToAgent(task: AgentBoardTask, expectedVersion: number, execution: AgentBoardTaskExecution, event: AuditEvent, outbox: OutboxMessageInput) {
    const current = this.tasks.get(task.id);
    if (!current || current.workspaceId !== task.workspaceId || current.brandId !== task.brandId || current.boardId !== task.boardId || current.version !== expectedVersion) return null;
    if (current.idempotencyKeySha256 !== task.idempotencyKeySha256 || current.createFingerprint !== task.createFingerprint || current.status !== "ready" || current.assignee !== "board-agent" || current.activeExecutionId || task.status !== "running" || task.activeExecutionId !== execution.id || execution.taskVersion !== task.version || execution.workspaceId !== task.workspaceId || execution.brandId !== task.brandId || execution.boardId !== task.boardId || execution.taskId !== task.id || execution.status !== "queued" || execution.version !== 1 || execution.claimId || execution.leaseExpiresAt || execution.startedAt || execution.completedAt) throw new DomainError("This Board task cannot be released to Hermes.", "agent_board_task_not_releasable", 409);
    if ([...this.executions.values()].some((entry)=>entry.workspaceId===execution.workspaceId&&entry.brandId===execution.brandId&&entry.boardId===execution.boardId&&entry.taskId===execution.taskId&&entry.idempotencyKeySha256===execution.idempotencyKeySha256)) throw new DomainError("This Board task release Idempotency-Key already exists.", "idempotency_key_conflict", 409);
    this.tasks.set(task.id, structuredClone(task));
    this.executions.set(execution.id, structuredClone(execution));
    this.events.push(structuredClone(event));
    this.appendOutbox([structuredClone(outbox)]);
    return { task: structuredClone(task), execution: structuredClone(execution) };
  }

  async claimExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string, claimId: string, leaseSeconds: number) {
    const current = this.executions.get(executionId);
    const task = this.tasks.get(taskId);
    const now = this.clock().toISOString();
    if (!current || current.workspaceId!==workspaceId||current.brandId!==brandId||current.boardId!==boardId||current.taskId!==taskId||current.status!=="queued"||Date.parse(now)-Date.parse(current.createdAt)>=15*60_000||!task||task.workspaceId!==workspaceId||task.brandId!==brandId||task.boardId!==boardId||task.status!=="running"||task.activeExecutionId!==executionId||task.version!==current.taskVersion) return null;
    const claimed = claimAgentBoardTaskExecution(current, claimId, leaseSeconds, now);
    this.executions.set(executionId, structuredClone(claimed));
    return { task: structuredClone(task), execution: structuredClone(claimed) };
  }

  async finishExecution(task: AgentBoardTask, expectedTaskVersion: number, execution: AgentBoardTaskExecution, claimId: string, event: AuditEvent) {
    const currentTask = this.tasks.get(task.id);
    const currentExecution = this.executions.get(execution.id);
    if (!currentTask || currentTask.workspaceId!==task.workspaceId || currentTask.brandId!==task.brandId || currentTask.boardId!==task.boardId || currentTask.version!==expectedTaskVersion || !currentExecution || currentExecution.workspaceId!==task.workspaceId || currentExecution.brandId!==task.brandId || currentExecution.boardId!==task.boardId || currentExecution.taskId!==task.id || currentExecution.version!==execution.version-1 || currentExecution.status!=="running" || currentExecution.claimId!==claimId || !currentExecution.leaseExpiresAt || this.clock().toISOString()>=currentExecution.leaseExpiresAt) return false;
    if (execution.claimId || execution.leaseExpiresAt || !["succeeded","failed","uncertain"].includes(execution.status) || task.activeExecutionId) throw new DomainError("The Board task execution result is invalid.", "agent_board_task_execution_result_invalid", 409);
    this.tasks.set(task.id,structuredClone(task));
    this.executions.set(execution.id,structuredClone(execution));
    this.events.push(structuredClone(event));
    return true;
  }

  async recoverExpiredExecutions(limit = 100) {
    const now = this.clock().toISOString();
    const queueCutoff = new Date(Date.parse(now) - 15 * 60_000).toISOString();
    const expired = [...this.executions.values()].filter((entry)=>(entry.status==="running"&&Boolean(entry.leaseExpiresAt)&&entry.leaseExpiresAt!<=now)||(entry.status==="queued"&&entry.createdAt<=queueCutoff)).slice(0,Math.max(1,Math.min(500,limit)));
    let recovered = 0;
    for (const current of expired) {
      const task = this.tasks.get(current.taskId);
      if (!task || task.activeExecutionId!==current.id || task.status!=="running" || task.version!==current.taskVersion) continue;
      const result = expireAgentBoardTaskExecution({ task, execution: current, reason: current.status === "queued" ? "queue_timeout" : "lease_expired", now });
      this.tasks.set(task.id,structuredClone(result.task));
      this.executions.set(current.id,structuredClone(result.execution));
      this.events.push(structuredClone(result.event));
      recovered += 1;
    }
    return recovered;
  }

  async getContentHandoffByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string) {
    const value = [...this.contentHandoffs.values()].find((entry) => entry.workspaceId === workspaceId && entry.brandId === brandId && entry.boardId === boardId && entry.taskId === taskId && entry.idempotencyKeySha256 === idempotencyKeySha256);
    return value ? structuredClone(value) : null;
  }

  async getContentHandoffByExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string) {
    const value = [...this.contentHandoffs.values()].find((entry) => entry.workspaceId === workspaceId && entry.brandId === brandId && entry.boardId === boardId && entry.taskId === taskId && entry.executionId === executionId);
    return value ? structuredClone(value) : null;
  }

  async createContentHandoff(task: AgentBoardTask, expectedTaskVersion: number, execution: AgentBoardTaskExecution, item: ContentItem, handoff: AgentBoardTaskContentHandoff, event: AuditEvent) {
    let release!: () => void;
    const predecessor = this.contentHandoffTail;
    this.contentHandoffTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      if (!this.contentItems) throw new Error("Content repository is required for Board task handoffs.");
      const currentTask = this.tasks.get(task.id);
      const currentExecution = this.executions.get(execution.id);
      if (!currentTask || currentTask.version !== expectedTaskVersion) return false;
      if (!currentExecution || currentTask.workspaceId !== task.workspaceId || currentTask.brandId !== task.brandId || currentTask.boardId !== task.boardId || currentExecution.workspaceId !== execution.workspaceId || currentExecution.brandId !== execution.brandId || currentExecution.boardId !== execution.boardId || currentExecution.taskId !== execution.taskId) return false;
      if (currentTask.status !== "review" || currentTask.assignee !== "board-agent" || currentTask.activeExecutionId || currentTask.lastExecutionId !== currentExecution.id || currentExecution.status !== "succeeded" || execution.version !== currentExecution.version || handoff.workspaceId !== currentTask.workspaceId || handoff.brandId !== currentTask.brandId || handoff.boardId !== currentTask.boardId || handoff.taskId !== currentTask.id || handoff.executionId !== currentExecution.id || handoff.taskVersion !== currentTask.version || handoff.executionVersion !== currentExecution.version || handoff.responseSha256 !== currentExecution.responseSha256 || handoff.createFingerprint !== agentBoardTaskContentHandoffFingerprint({ task: currentTask, execution: currentExecution }) || handoff.contentItemId !== item.id || item.status !== "inbox" || item.version !== 1 || item.workspaceId !== currentTask.workspaceId || item.brandId !== currentTask.brandId || item.title !== currentTask.title || item.summary !== currentExecution.resultText?.slice(0,2_000) || item.researchDepth !== "standard" || item.riskLevel !== "low" || item.drafts.length || item.approvals.length || item.targets.length || item.publishAttempts.length || item.proofs.length || event.workspaceId !== item.workspaceId || event.contentItemId !== item.id || event.action !== "content.created-from-board-task") throw new DomainError("This Board task handoff is invalid.", "agent_board_task_handoff_invalid", 409);
      if ([...this.contentHandoffs.values()].some((entry) => entry.executionId === handoff.executionId || entry.contentItemId === handoff.contentItemId)) throw new DomainError("This Board execution already became Content.", "agent_board_task_execution_handoff_exists", 409);
      if (this.contentHandoffs.has(handoff.id) || [...this.contentHandoffs.values()].some((entry) => entry.workspaceId === handoff.workspaceId && entry.brandId === handoff.brandId && entry.boardId === handoff.boardId && entry.taskId === handoff.taskId && entry.idempotencyKeySha256 === handoff.idempotencyKeySha256)) throw new DomainError("This Board task handoff Idempotency-Key already exists.", "idempotency_key_conflict", 409);
      await this.contentItems.commit(item, event);
      this.contentHandoffs.set(handoff.id, structuredClone(handoff));
      return true;
    } finally {
      release();
    }
  }
}
