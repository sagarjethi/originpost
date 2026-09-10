import { randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { createOutboxMessage } from "./outbox.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent, OutboxMessageInput } from "./types.js";

export type AgentBoardStatus = "provisioning" | "setup_required" | "ready" | "attention" | "archived";

export interface AgentBoardPluginDecision {
  decisionKey: string;
  idempotencyScopeKey: string;
  subsystem: "memory" | "skills";
  pendingId: string;
  decision: "approve" | "reject";
  expectedSha256: string;
  idempotencyKey: string;
  requestedConfigurationEpoch: number;
  requestedCapabilityEpoch: number;
  requestedBy: string;
  requestedAt: string;
}

export interface AgentBoard {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  name: string;
  slug: string;
  purpose: string;
  /** First-party internal module. It is not an entry in the untrusted plugin catalog. */
  pluginId: "org.originpost.hermes-boards";
  hermesProfile: string;
  status: AgentBoardStatus;
  memoryIsolation: "hermes-profile";
  memoryWriteApproval: true;
  skillWriteApproval: true;
  desiredSkills: string[];
  observedSkills: string[];
  configurationEpoch: number;
  observedConfigurationEpoch: number;
  capabilityEpoch: number;
  /** Set only after the archived Board's remote Hermes capability has been disabled. */
  runtimeDeactivatedAt?: string;
  /** Bounded, non-secret hashes used to make asynchronous plugin decisions exactly-once. */
  appliedPluginDecisionKeys?: string[];
  /** Bounded route/idempotency hashes used to reject changed-body key reuse. */
  appliedPluginIdempotencyScopeKeys?: string[];
  /** Durable saga state; never exposed through the public Board response. */
  pendingPluginDecision?: AgentBoardPluginDecision;
  lastCheckedAt?: string;
  lastError?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBoardRunLedgerEntry {
  id: string;
  workspaceId: string;
  brandId: string;
  boardId: string;
  configurationEpoch: number;
  model: string;
  status: "succeeded" | "failed";
  requestSha256: string;
  responseSha256?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  errorCode?: string;
  createdBy: string;
  createdAt: string;
}

export interface AgentBoardRepository {
  list(workspaceId: string, brandId: string, includeArchived?: boolean): Promise<AgentBoard[]>;
  get(workspaceId: string, id: string): Promise<AgentBoard | null>;
  create(board: AgentBoard, event: AuditEvent, outbox?: OutboxMessageInput): Promise<void>;
  update(board: AgentBoard, expectedVersion: number, event: AuditEvent, outbox?: OutboxMessageInput): Promise<AgentBoard | null>;
  recordRun(run: AgentBoardRunLedgerEntry, event: AuditEvent, expected?: { configurationEpoch: number; capabilityEpoch: number }): Promise<boolean>;
  listRuns(workspaceId: string, boardId: string, limit?: number): Promise<AgentBoardRunLedgerEntry[]>;
}

const clean = (value: string, maximum: number, label: string) => {
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) throw new DomainError(`${label} must contain 1–${maximum} safe characters.`, "agent_board_invalid");
  return result;
};

const slug = (value: string) => {
  const result = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 54).replace(/-+$/u, "");
  if (!result) throw new DomainError("Board name needs at least one letter or number for its URL.", "agent_board_slug_invalid");
  return result;
};

function skills(values: string[]): string[] {
  if (values.length > 100) throw new DomainError("A board can enable at most 100 skills.", "agent_board_skills_invalid");
  const normalized = values.map((value) => clean(value, 160, "Skill name"));
  if (normalized.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value))) throw new DomainError("A skill name contains unsupported characters.", "agent_board_skills_invalid");
  return [...new Set(normalized)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

const owner = (actor: Actor) => {
  if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can manage agent boards.", "permission_denied", 403);
};

const event = (board: AgentBoard, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent => ({
  id: `evt_${randomUUID()}`,
  workspaceId: board.workspaceId,
  actorId: actor.id,
  actorType: "human",
  action,
  detail: { boardId: board.id, brandId: board.brandId, hermesProfile: board.hermesProfile, ...detail },
  createdAt: board.updatedAt,
});

export function createAgentBoard(input: { workspaceId: string; brandId: string; name: string; purpose: string; pluginConfigured: boolean; actor: Actor; now?: string }): { board: AgentBoard; event: AuditEvent } {
  owner(input.actor);
  const now = input.now ?? new Date().toISOString();
  const id = `agent_board_${randomUUID()}`;
  const boardSlug = slug(clean(input.name, 100, "Board name"));
  const board: AgentBoard = {
    id,
    workspaceId: clean(input.workspaceId, 100, "Workspace ID"),
    brandId: clean(input.brandId, 100, "Brand ID"),
    version: 1,
    name: clean(input.name, 100, "Board name"),
    slug: boardSlug,
    purpose: clean(input.purpose, 600, "Board purpose"),
    pluginId: "org.originpost.hermes-boards",
    hermesProfile: `opb_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    status: input.pluginConfigured ? "provisioning" : "setup_required",
    memoryIsolation: "hermes-profile",
    memoryWriteApproval: true,
    skillWriteApproval: true,
    desiredSkills: [],
    observedSkills: [],
    configurationEpoch: 1,
    observedConfigurationEpoch: 0,
    capabilityEpoch: 1,
    ...(input.pluginConfigured ? {} : { lastError: "Configure the internal Hermes Boards plugin, then provision this board." }),
    createdBy: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  return { board, event: event(board, input.actor, "agent-board.created", { name: board.name, pluginId: board.pluginId, status: board.status }) };
}

export function queueAgentBoardReconcile(input: { current: AgentBoard; actor: Actor; expectedVersion: number; desiredSkills?: string[]; rotateCapabilities?: boolean; now?: string }): { board: AgentBoard; event: AuditEvent; outbox: OutboxMessageInput } {
  owner(input.actor);
  if (input.current.status === "archived") throw new DomainError("Archived boards cannot change their Hermes plugin.", "agent_board_archived", 409);
  if (input.current.pendingPluginDecision) throw new DomainError("A Board plugin decision is still being applied.", "agent_board_plugin_decision_pending", 409);
  if (input.current.version !== input.expectedVersion) throw new DomainError("This board changed. Refresh and try again.", "version_conflict", 409);
  const now = input.now ?? new Date().toISOString();
  const desiredSkills = input.desiredSkills === undefined ? input.current.desiredSkills : skills(input.desiredSkills);
  const capabilityChanged = input.rotateCapabilities === true || desiredSkills.join("\u0000") !== input.current.desiredSkills.join("\u0000");
  const board: AgentBoard = {
    ...input.current,
    version: input.current.version + 1,
    status: "provisioning",
    desiredSkills,
    configurationEpoch: input.current.configurationEpoch + 1,
    capabilityEpoch: input.current.capabilityEpoch + (capabilityChanged ? 1 : 0),
    updatedAt: now,
  };
  delete board.lastError;
  const outbox = createOutboxMessage({
    workspaceId: board.workspaceId,
    topic: "board.plugin.reconcile",
    dedupeKey: `board-plugin:${board.id}:epoch:${board.configurationEpoch}`,
    payload: { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, configurationEpoch: board.configurationEpoch },
    now,
  });
  return {
    board,
    event: event(board, input.actor, "agent-board.plugin-reconcile-requested", { version: board.version, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch, desiredSkillCount: board.desiredSkills.length }),
    outbox,
  };
}

export function observeAgentBoardPlugin(input: { current: AgentBoard; configurationEpoch: number; healthy: boolean; observedSkills?: string[]; errorCode?: string; now?: string }): AgentBoard {
  if (input.current.status === "archived" || input.current.pendingPluginDecision || input.configurationEpoch !== input.current.configurationEpoch) return input.current;
  const now = input.now ?? new Date().toISOString();
  const board: AgentBoard = {
    ...input.current,
    version: input.current.version + 1,
    status: input.healthy ? "ready" : "attention",
    observedSkills: input.observedSkills === undefined ? input.current.observedSkills : skills(input.observedSkills),
    observedConfigurationEpoch: input.healthy ? input.configurationEpoch : input.current.observedConfigurationEpoch,
    lastCheckedAt: now,
    updatedAt: now,
    ...(input.errorCode ? { lastError: clean(input.errorCode, 300, "Board error") } : {}),
  };
  if (input.healthy) delete board.lastError;
  return board;
}

export function observeAgentBoardDeactivated(input: { current: AgentBoard; configurationEpoch: number; capabilityEpoch: number; now?: string }): AgentBoard {
  if (input.current.status !== "archived" || input.current.configurationEpoch !== input.configurationEpoch || input.current.capabilityEpoch !== input.capabilityEpoch || input.current.runtimeDeactivatedAt) return input.current;
  const now = input.now ?? new Date().toISOString();
  return {
    ...input.current,
    version: input.current.version + 1,
    runtimeDeactivatedAt: now,
    lastCheckedAt: now,
    updatedAt: now,
  };
}

export function queueAgentBoardPluginDecision(input: {
  current: AgentBoard;
  actor: Actor;
  subsystem: "memory" | "skills";
  pendingId: string;
  decision: "approve" | "reject";
  expectedSha256: string;
  idempotencyKey: string;
  decisionKey: string;
  idempotencyScopeKey: string;
  now?: string;
}): { board: AgentBoard; event: AuditEvent; outbox?: OutboxMessageInput; alreadyQueued: boolean; alreadyApplied: boolean } {
  owner(input.actor);
  if (input.current.status === "archived") throw new DomainError("Archived Boards cannot manage pending writes.", "agent_board_archived", 409);
  if (!/^[a-f0-9]{64}$/u.test(input.decisionKey) || !/^[a-f0-9]{64}$/u.test(input.idempotencyScopeKey) || !/^[a-f0-9]{8}$/u.test(input.pendingId) || !/^[a-f0-9]{64}$/u.test(input.expectedSha256) || !/^[A-Za-z0-9_-]{16,100}$/u.test(input.idempotencyKey)) {
    throw new DomainError("The Board plugin decision is invalid.", "agent_board_plugin_decision_invalid", 409);
  }
  if (input.current.appliedPluginDecisionKeys?.includes(input.decisionKey)) {
    return { board: input.current, event: event(input.current, input.actor, "agent-board.plugin-decision-replayed", { decisionKey: input.decisionKey, applied: true }), alreadyQueued: false, alreadyApplied: true };
  }
  if (input.current.appliedPluginIdempotencyScopeKeys?.includes(input.idempotencyScopeKey)) throw new DomainError("This Idempotency-Key was already used with a different Board plugin decision.", "idempotency_key_conflict", 409);
  if (input.current.pendingPluginDecision) {
    if (input.current.pendingPluginDecision.decisionKey !== input.decisionKey) throw new DomainError("A Board plugin decision is still being applied.", "agent_board_plugin_decision_pending", 409);
    const queued = createOutboxMessage({
      workspaceId: input.current.workspaceId,
      topic: "board.plugin.decision",
      dedupeKey: `board-plugin-decision:${input.decisionKey}`,
      payload: { workspaceId: input.current.workspaceId, brandId: input.current.brandId, boardId: input.current.id, ...input.current.pendingPluginDecision },
      ...(input.now ? { now: input.now } : {}),
    });
    return { board: input.current, event: event(input.current, input.actor, "agent-board.plugin-decision-replayed", { decisionKey: input.decisionKey, applied: false }), outbox: queued, alreadyQueued: true, alreadyApplied: false };
  }
  const now = input.now ?? new Date().toISOString();
  const pendingPluginDecision: AgentBoardPluginDecision = {
    decisionKey: input.decisionKey,
    idempotencyScopeKey: input.idempotencyScopeKey,
    subsystem: input.subsystem,
    pendingId: input.pendingId,
    decision: input.decision,
    expectedSha256: input.expectedSha256,
    idempotencyKey: input.idempotencyKey,
    requestedConfigurationEpoch: input.current.configurationEpoch,
    requestedCapabilityEpoch: input.current.capabilityEpoch,
    requestedBy: input.actor.id,
    requestedAt: now,
  };
  const board: AgentBoard = {
    ...input.current,
    version: input.current.version + 1,
    ...(input.subsystem === "skills" && input.decision === "approve" ? { status: "provisioning" as const } : {}),
    pendingPluginDecision,
    updatedAt: now,
  };
  if (input.subsystem === "skills" && input.decision === "approve") delete board.lastError;
  const outbox = createOutboxMessage({
    workspaceId: board.workspaceId,
    topic: "board.plugin.decision",
    dedupeKey: `board-plugin-decision:${input.decisionKey}`,
    payload: { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, ...pendingPluginDecision },
    now,
  });
  return {
    board,
    event: event(board, input.actor, `agent-board.${input.subsystem}-write-${input.decision}-requested`, {
      subsystem: input.subsystem,
      pendingId: input.pendingId,
      pendingSha256: input.expectedSha256,
      decisionKey: input.decisionKey,
      configurationEpoch: board.configurationEpoch,
      capabilityEpoch: board.capabilityEpoch,
    }),
    outbox,
    alreadyQueued: false,
    alreadyApplied: false,
  };
}

export function observeAgentBoardPluginDecision(input: {
  current: AgentBoard;
  decisionKey: string;
  subsystem: "memory" | "skills";
  decision: "approve" | "reject";
  pendingId: string;
  expectedSha256: string;
  now?: string;
}): { board: AgentBoard; event: AuditEvent; outbox?: OutboxMessageInput; alreadyApplied: boolean } {
  if (!/^[a-f0-9]{64}$/u.test(input.decisionKey) || !/^[a-f0-9]{8}$/u.test(input.pendingId) || !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new DomainError("The Board plugin decision receipt is invalid.", "agent_board_plugin_decision_invalid", 409);
  }
  if (input.current.appliedPluginDecisionKeys?.includes(input.decisionKey)) {
    return {
      board: input.current,
      event: {
        id: `evt_${randomUUID()}`,
        workspaceId: input.current.workspaceId,
        actorId: "board-plugin-worker",
        actorType: "system",
        action: "agent-board.plugin-decision-replayed",
        detail: { boardId: input.current.id, decisionKey: input.decisionKey },
        createdAt: input.now ?? new Date().toISOString(),
      },
      alreadyApplied: true,
    };
  }
  if (input.current.pendingPluginDecision?.decisionKey !== input.decisionKey || input.current.pendingPluginDecision.subsystem !== input.subsystem || input.current.pendingPluginDecision.decision !== input.decision || input.current.pendingPluginDecision.pendingId !== input.pendingId || input.current.pendingPluginDecision.expectedSha256 !== input.expectedSha256) {
    throw new DomainError("The durable Board plugin decision does not match the Hermes receipt.", "agent_board_plugin_decision_mismatch", 409);
  }
  const now = input.now ?? new Date().toISOString();
  const skillChanged = input.subsystem === "skills" && input.decision === "approve";
  const appliedPluginDecisionKeys = [...(input.current.appliedPluginDecisionKeys ?? []), input.decisionKey].slice(-100);
  const appliedPluginIdempotencyScopeKeys = [...(input.current.appliedPluginIdempotencyScopeKeys ?? []), input.current.pendingPluginDecision.idempotencyScopeKey].slice(-100);
  const board: AgentBoard = {
    ...input.current,
    version: input.current.version + 1,
    appliedPluginDecisionKeys,
    appliedPluginIdempotencyScopeKeys,
    ...(skillChanged ? {
      status: "provisioning" as const,
      configurationEpoch: input.current.configurationEpoch + 1,
      capabilityEpoch: input.current.capabilityEpoch + 1,
    } : {}),
    updatedAt: now,
  };
  delete board.pendingPluginDecision;
  if (skillChanged) delete board.lastError;
  const outbox = skillChanged ? createOutboxMessage({
    workspaceId: board.workspaceId,
    topic: "board.plugin.reconcile",
    dedupeKey: `board-plugin:${board.id}:epoch:${board.configurationEpoch}`,
    payload: { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, configurationEpoch: board.configurationEpoch },
    now,
  }) : undefined;
  return {
    board,
    event: {
      id: `evt_${randomUUID()}`,
      workspaceId: board.workspaceId,
      actorId: "board-plugin-worker",
      actorType: "system",
      action: "agent-board.plugin-decision-applied",
      detail: {
        boardId: board.id,
        brandId: board.brandId,
        decisionKey: input.decisionKey,
        subsystem: input.subsystem,
        decision: input.decision,
        pendingId: input.pendingId,
        pendingSha256: input.expectedSha256,
        reconcileQueued: skillChanged,
        configurationEpoch: board.configurationEpoch,
        capabilityEpoch: board.capabilityEpoch,
      },
      createdAt: now,
    },
    ...(outbox ? { outbox } : {}),
    alreadyApplied: false,
  };
}

export function reviseAgentBoard(input: { current: AgentBoard; actor: Actor; expectedVersion: number; name?: string; purpose?: string; status?: AgentBoardStatus; checkedAt?: string; error?: string }): { board: AgentBoard; event: AuditEvent; outbox?: OutboxMessageInput } {
  owner(input.actor);
  if (input.current.pendingPluginDecision) throw new DomainError("A Board plugin decision is still being applied.", "agent_board_plugin_decision_pending", 409);
  if (input.current.version !== input.expectedVersion) throw new DomainError("This board changed. Refresh and try again.", "version_conflict", 409);
  const now = input.checkedAt ?? new Date().toISOString();
  const nextPurpose = input.purpose === undefined ? input.current.purpose : clean(input.purpose, 600, "Board purpose");
  const purposeChanged = nextPurpose !== input.current.purpose;
  const archiving = input.status === "archived" && input.current.status !== "archived";
  const runtimePolicyChanged = purposeChanged && !archiving;
  const board: AgentBoard = {
    ...input.current,
    version: input.current.version + 1,
    ...(input.name === undefined ? {} : { name: clean(input.name, 100, "Board name") }),
    purpose: nextPurpose,
    ...(runtimePolicyChanged || archiving ? {
      status: archiving ? "archived" as const : "provisioning" as const,
      configurationEpoch: input.current.configurationEpoch + 1,
      capabilityEpoch: input.current.capabilityEpoch + 1,
    } : input.status === undefined ? {} : { status: input.status }),
    ...(input.checkedAt ? { lastCheckedAt: input.checkedAt } : {}),
    ...(input.error ? { lastError: clean(input.error, 300, "Board error") } : {}),
    updatedAt: now,
  };
  if (!input.error && (input.status === "ready" || input.status === "archived")) delete board.lastError;
  if (runtimePolicyChanged) delete board.lastError;
  const outbox = runtimePolicyChanged || archiving ? createOutboxMessage({
    workspaceId: board.workspaceId,
    topic: archiving ? "board.plugin.deactivate" : "board.plugin.reconcile",
    dedupeKey: `board-plugin:${board.id}:${archiving ? "deactivate" : "reconcile"}:epoch:${board.configurationEpoch}`,
    payload: { workspaceId: board.workspaceId, brandId: board.brandId, boardId: board.id, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch },
    now,
  }) : undefined;
  return {
    board,
    event: event(board, input.actor, input.status === "archived" ? "agent-board.archived" : runtimePolicyChanged ? "agent-board.plugin-reconcile-requested" : "agent-board.updated", { version: board.version, status: board.status, nameChanged: input.name !== undefined, purposeChanged, configurationEpoch: board.configurationEpoch, capabilityEpoch: board.capabilityEpoch, errorCode: input.error ? "hermes_board_plugin_unavailable" : undefined }),
    ...(outbox ? { outbox } : {}),
  };
}

export class InMemoryAgentBoardRepository implements AgentBoardRepository {
  private readonly boards = new Map<string, AgentBoard>();
  private readonly events: AuditEvent[] = [];
  private readonly runs: AgentBoardRunLedgerEntry[] = [];
  private readonly outbox: OutboxMessageInput[] = [];
  constructor(private readonly appendOutbox?: (messages: OutboxMessageInput[]) => void) {}

  async list(workspaceId: string, brandId: string, includeArchived = false) {
    return [...this.boards.values()].filter((board) => board.workspaceId === workspaceId && board.brandId === brandId && (includeArchived || board.status !== "archived")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map((board) => structuredClone(board));
  }

  async get(workspaceId: string, id: string) {
    const board = this.boards.get(id);
    return board?.workspaceId === workspaceId ? structuredClone(board) : null;
  }

  async create(board: AgentBoard, eventValue: AuditEvent, outbox?: OutboxMessageInput) {
    if ([...this.boards.values()].some((entry) => entry.workspaceId === board.workspaceId && entry.brandId === board.brandId && entry.slug === board.slug && entry.status !== "archived")) throw new DomainError("This brand already has a board with that name.", "agent_board_slug_exists", 409);
    if ([...this.boards.values()].some((entry) => entry.hermesProfile === board.hermesProfile)) throw new DomainError("This Board runtime profile is already assigned.", "agent_board_profile_exists", 409);
    this.boards.set(board.id, structuredClone(board));
    this.events.push(structuredClone(eventValue));
    if (outbox) { this.outbox.push(structuredClone(outbox)); this.appendOutbox?.([structuredClone(outbox)]); }
  }

  async update(board: AgentBoard, expectedVersion: number, eventValue: AuditEvent, outbox?: OutboxMessageInput) {
    const current = this.boards.get(board.id);
    if (!current || current.workspaceId !== board.workspaceId || current.version !== expectedVersion) return null;
    if (board.hermesProfile !== current.hermesProfile || board.pluginId !== current.pluginId || board.workspaceId !== current.workspaceId || board.brandId !== current.brandId || board.id !== current.id) throw new DomainError("A Board's runtime identity cannot be changed.", "agent_board_identity_immutable", 409);
    if ([...this.boards.values()].some((entry) => entry.id !== board.id && entry.workspaceId === board.workspaceId && entry.brandId === board.brandId && entry.slug === board.slug && entry.status !== "archived")) throw new DomainError("This brand already has a board with that name.", "agent_board_slug_exists", 409);
    if ([...this.boards.values()].some((entry) => entry.id !== board.id && entry.hermesProfile === board.hermesProfile)) throw new DomainError("This Board runtime profile is already assigned.", "agent_board_profile_exists", 409);
    this.boards.set(board.id, structuredClone(board));
    this.events.push(structuredClone(eventValue));
    if (outbox) { this.outbox.push(structuredClone(outbox)); this.appendOutbox?.([structuredClone(outbox)]); }
    return structuredClone(board);
  }

  async recordRun(run: AgentBoardRunLedgerEntry, eventValue: AuditEvent, expected?: { configurationEpoch: number; capabilityEpoch: number }) {
    const board = this.boards.get(run.boardId);
    if (!board || board.workspaceId !== run.workspaceId || board.brandId !== run.brandId) throw new DomainError("Agent board not found.", "agent_board_not_found", 404);
    if (expected && (board.status !== "ready" || board.pendingPluginDecision !== undefined || board.configurationEpoch !== expected.configurationEpoch || board.observedConfigurationEpoch !== expected.configurationEpoch || board.capabilityEpoch !== expected.capabilityEpoch)) return false;
    this.runs.push(structuredClone(run));
    this.events.push(structuredClone(eventValue));
    return true;
  }

  async listRuns(workspaceId: string, boardId: string, limit = 50) {
    return this.runs.filter((run) => run.workspaceId === workspaceId && run.boardId === boardId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(200, limit))).map((run) => structuredClone(run));
  }
}
