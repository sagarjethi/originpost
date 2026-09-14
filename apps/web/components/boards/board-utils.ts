export type BoardStatus = "provisioning" | "setup_required" | "ready" | "attention" | "archived";

export type BoardView = {
  id: string;
  version: number;
  name: string;
  purpose: string;
  status: BoardStatus;
  lastCheckedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type BoardSkillView = {
  /** Provider identifier used only when writing the toggle back to the API. */
  id: string;
  label: string;
  enabled: boolean;
  applied: boolean;
};

export type BoardPendingWriteView = {
  id: string;
  subsystem: "memory" | "skills";
  action: string;
  summary: string;
  origin: "foreground" | "background_review";
  createdAt: number;
  sha256: string;
};

export type BoardPendingWriteDetailView = BoardPendingWriteView & { detail: string; detailTruncated: boolean };

export type BoardHermesView = {
  configured: boolean;
  healthy: boolean;
  modelReady: boolean;
  memoryEnabled: boolean;
  memoryWriteApproval: boolean;
  skillWriteApproval: boolean;
  isolation: {
    verified: boolean;
    profileScoped: boolean;
    memoryScoped: boolean;
    skillsScoped: boolean;
    stateScoped: boolean;
    externalSkillsBlocked: boolean;
    unsafeToolsBlocked: boolean;
    filesystemSandbox: false;
  };
  pending: boolean;
  decisionPending: boolean;
  pendingManagementAvailable: boolean;
  pendingWrites: BoardPendingWriteView[];
  lastCheckedAt?: string;
  skills: BoardSkillView[];
};

export type BoardRunView = {
  id: string;
  status: "succeeded" | "failed";
  model: string;
  requestSha256: string;
  responseSha256?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  createdAt: string;
};

export const BOARD_TASK_STATUSES = ["triage", "todo", "ready", "running", "blocked", "review", "done", "archived"] as const;
export type BoardTaskStatus = typeof BOARD_TASK_STATUSES[number];

export type BoardTaskView = {
  id: string;
  boardId: string;
  version: number;
  title: string;
  description: string;
  status: BoardTaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  assignee: "team" | "board-agent";
  parentTaskIds: string[];
  blockedReason?: string;
  resultSummary?: string;
  dueAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type BoardTaskCommentView = {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
};

export type BoardTaskExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "uncertain";

export type BoardTaskExecutionView = {
  id: string;
  taskId: string;
  status: BoardTaskExecutionStatus;
  model?: string;
  resultText?: string;
  errorSummary?: string;
  contentItemId?: string;
  createdAt: string;
  updatedAt: string;
};

export type BoardTaskHandoffView = {
  executionId: string;
  contentItemId: string;
};

export function boardTaskHandoffRequestBody(workspaceId: string, brandId: string, executionId: string) {
  return { workspaceId, brandId, executionId };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) return undefined;
  return value;
}

function safeStatus(value: unknown): BoardStatus {
  return value === "provisioning" || value === "setup_required" || value === "ready" || value === "attention" || value === "archived" ? value : "setup_required";
}

function safeTaskStatus(value: unknown): BoardTaskStatus | null {
  return BOARD_TASK_STATUSES.includes(value as BoardTaskStatus) ? value as BoardTaskStatus : null;
}

export function parseBoardTask(value: unknown): BoardTaskView | null {
  const row = record(value);
  const status = safeTaskStatus(row?.status);
  const createdAt = safeDate(row?.createdAt);
  const updatedAt = safeDate(row?.updatedAt);
  if (!row || typeof row.id !== "string" || typeof row.boardId !== "string" || typeof row.title !== "string" || !status || !createdAt || !updatedAt) return null;
  const title = row.title.trim().slice(0, 180);
  if (!title) return null;
  const priority = row.priority === "low" || row.priority === "high" || row.priority === "urgent" ? row.priority : "normal";
  const assignee = row.assignee === "board-agent" ? "board-agent" : "team";
  const parentTaskIds = (Array.isArray(row.parentTaskIds) ? row.parentTaskIds : []).filter((id): id is string => typeof id === "string" && /^agent_board_task_[a-f0-9-]{36}$/u.test(id)).slice(0, 20);
  const blockedReason = typeof row.blockedReason === "string" ? row.blockedReason.trim().slice(0, 2_000) : "";
  const resultSummary = typeof row.resultSummary === "string" ? row.resultSummary.trim().slice(0, 4_000) : "";
  const dueAt = safeDate(row.dueAt);
  const completedAt = safeDate(row.completedAt);
  return {
    id: row.id,
    boardId: row.boardId,
    version: typeof row.version === "number" && Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
    title,
    description: typeof row.description === "string" ? row.description.trim().slice(0, 8_000) : "",
    status,
    priority,
    assignee,
    parentTaskIds,
    ...(blockedReason ? { blockedReason } : {}),
    ...(resultSummary ? { resultSummary } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    createdAt,
    updatedAt,
  };
}

export function parseBoardTasks(value: unknown): BoardTaskView[] {
  const root = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root?.tasks) ? root.tasks : [];
  return rows.map(parseBoardTask).filter((task): task is BoardTaskView => Boolean(task));
}

export function parseBoardTaskComments(value: unknown): BoardTaskCommentView[] {
  const root = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root?.comments) ? root.comments : [];
  return rows.flatMap((value): BoardTaskCommentView[] => {
    const row = record(value);
    const createdAt = safeDate(row?.createdAt);
    if (!row || typeof row.id !== "string" || typeof row.body !== "string" || typeof row.authorName !== "string" || !createdAt) return [];
    const body = row.body.trim().slice(0, 4_000);
    const authorName = row.authorName.trim().slice(0, 160);
    return body && authorName ? [{ id: row.id, body, authorName, createdAt }] : [];
  });
}

export function parseBoardTaskExecutions(value: unknown): BoardTaskExecutionView[] {
  const root = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root?.executions) ? root.executions : [];
  return rows.flatMap((value): BoardTaskExecutionView[] => {
    const row = record(value);
    const createdAt = safeDate(row?.createdAt);
    const updatedAt = safeDate(row?.updatedAt);
    const status = row?.status;
    if (!row || typeof row.id !== "string" || typeof row.taskId !== "string" || !createdAt || !updatedAt || (status !== "queued" && status !== "running" && status !== "succeeded" && status !== "failed" && status !== "uncertain")) return [];
    const id = row.id.trim().slice(0, 200);
    const taskId = row.taskId.trim().slice(0, 200);
    if (!id || !taskId) return [];
    const model = typeof row.model === "string" ? row.model.trim().slice(0, 200) : "";
    const resultText = typeof row.resultText === "string" ? row.resultText.trim().slice(0, 100_000) : "";
    const errorSummary = typeof row.errorSummary === "string" ? row.errorSummary.trim().slice(0, 2_000) : "";
    const contentItemId = typeof row.contentItemId === "string" ? row.contentItemId.trim().slice(0, 200) : "";
    return [{ id, taskId, status, ...(model ? { model } : {}), ...(resultText ? { resultText } : {}), ...(errorSummary ? { errorSummary } : {}), ...(contentItemId ? { contentItemId } : {}), createdAt, updatedAt }];
  });
}

export function hasActiveBoardTaskExecution(executions: BoardTaskExecutionView[]): boolean {
  return executions.some((execution) => execution.status === "queued" || execution.status === "running");
}

export function parseBoardTaskHandoff(value: unknown, expectedExecutionId: string): BoardTaskHandoffView | null {
  const root = record(value);
  const handoff = record(root?.handoff);
  const contentItem = record(root?.contentItem);
  const contentItemId = typeof contentItem?.id === "string" ? contentItem.id.trim().slice(0, 200) : "";
  const responseExecutionId = typeof handoff?.executionId === "string" ? handoff.executionId.trim().slice(0, 200) : expectedExecutionId;
  if (!root || !handoff || !contentItemId || !expectedExecutionId || responseExecutionId !== expectedExecutionId) return null;
  if (typeof handoff.contentItemId === "string" && handoff.contentItemId !== contentItemId) return null;
  return { executionId: expectedExecutionId, contentItemId };
}

const taskTransitions: Record<BoardTaskStatus, BoardTaskStatus[]> = {
  triage: ["todo", "archived"],
  todo: ["triage", "ready", "blocked", "archived"],
  ready: ["todo", "running", "blocked", "archived"],
  running: ["blocked", "review"],
  blocked: ["todo", "archived"],
  review: ["running", "blocked", "done"],
  done: ["archived"],
  archived: [],
};

export function boardTaskNextStatuses(status: BoardTaskStatus): BoardTaskStatus[] {
  return taskTransitions[status];
}

export function parseBoard(value: unknown): BoardView | null {
  const source = record(value);
  if (!source || typeof source.id !== "string" || typeof source.name !== "string") return null;
  const name = source.name.trim().slice(0, 100);
  if (!name) return null;
  const lastCheckedAt = safeDate(source.lastCheckedAt);
  const createdAt = safeDate(source.createdAt);
  const updatedAt = safeDate(source.updatedAt);
  return {
    id: source.id,
    version: typeof source.version === "number" && Number.isInteger(source.version) && source.version > 0 ? source.version : 1,
    name,
    purpose: typeof source.purpose === "string" ? source.purpose.trim().slice(0, 600) : "",
    status: safeStatus(source.status),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function parseBoards(value: unknown): BoardView[] {
  const source = record(value);
  const values = Array.isArray(value) ? value : Array.isArray(source?.items) ? source.items : Array.isArray(source?.boards) ? source.boards : [];
  return values.map(parseBoard).filter((board): board is BoardView => Boolean(board));
}

function skillLabel(name: string, position: number): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) return `Skill ${position + 1}`;
  return name.replace(/[_.-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function parseBoardHermes(value: unknown): BoardHermesView {
  const root = record(value) ?? {};
  const source = record(root.hermes) ?? record(root.plugin) ?? root;
  const memory = record(source.memory) ?? {};
  const approvals = record(source.approvals) ?? {};
  const isolation = record(source.isolation) ?? {};
  const rawSkills = Array.isArray(source.skills) ? source.skills : [];
  const lastCheckedAt = safeDate(source.lastCheckedAt);
  const pendingWrites = (Array.isArray(source.pendingWrites) ? source.pendingWrites : []).flatMap((value): BoardPendingWriteView[] => {
    const item = record(value);
    if (!item || typeof item.id !== "string" || !/^[a-f0-9]{8}$/u.test(item.id) || (item.subsystem !== "memory" && item.subsystem !== "skills") || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256) || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) return [];
    return [{ id: item.id, subsystem: item.subsystem, action: typeof item.action === "string" ? item.action.slice(0, 80) : "", summary: typeof item.summary === "string" ? item.summary.slice(0, 300) : "", origin: item.origin === "background_review" ? "background_review" : "foreground", createdAt: item.createdAt, sha256: item.sha256 }];
  });
  const skills = rawSkills.flatMap((value, position) => {
    const skill = record(value);
    const id = typeof skill?.name === "string" ? skill.name : typeof skill?.id === "string" ? skill.id : "";
    if (!id) return [];
    return [{ id, label: skillLabel(id, position), enabled: skill?.enabled === true, applied: skill?.applied === true }];
  });
  return {
    configured: source.configured === true,
    healthy: source.healthy === true,
    modelReady: source.modelReady === true,
    memoryEnabled: memory.enabled === true || source.memoryEnabled === true,
    memoryWriteApproval: memory.writeApproval === true || source.memoryWriteApproval === true || approvals.memory === true,
    skillWriteApproval: source.skillWriteApproval === true || approvals.skills === true,
    isolation: {
      verified: isolation.verified === true,
      profileScoped: isolation.profileScoped === true,
      memoryScoped: isolation.memoryScoped === true,
      skillsScoped: isolation.skillsScoped === true,
      stateScoped: isolation.stateScoped === true,
      externalSkillsBlocked: isolation.externalSkillsBlocked === true,
      unsafeToolsBlocked: isolation.unsafeToolsBlocked === true,
      filesystemSandbox: false,
    },
    pending: source.pending === true,
    decisionPending: source.decisionPending === true,
    pendingManagementAvailable: source.pendingManagementAvailable === true,
    pendingWrites,
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    skills,
  };
}

export function parseBoardRuns(value: unknown): BoardRunView[] {
  const root = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root?.runs) ? root.runs : [];
  return rows.flatMap((value): BoardRunView[] => {
    const row = record(value);
    if (!row || typeof row.id !== "string" || (row.status !== "succeeded" && row.status !== "failed") || typeof row.model !== "string" || typeof row.requestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.requestSha256) || typeof row.latencyMs !== "number" || !Number.isFinite(row.latencyMs)) return [];
    const createdAt = safeDate(row.createdAt);
    if (!createdAt) return [];
    const responseSha256 = typeof row.responseSha256 === "string" && /^[a-f0-9]{64}$/u.test(row.responseSha256) ? row.responseSha256 : undefined;
    const inputTokens = typeof row.inputTokens === "number" && Number.isInteger(row.inputTokens) && row.inputTokens >= 0 ? row.inputTokens : undefined;
    const outputTokens = typeof row.outputTokens === "number" && Number.isInteger(row.outputTokens) && row.outputTokens >= 0 ? row.outputTokens : undefined;
    return [{
      id: row.id,
      status: row.status,
      model: row.model.slice(0, 200),
      requestSha256: row.requestSha256,
      ...(responseSha256 ? { responseSha256 } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      latencyMs: Math.max(0, row.latencyMs),
      createdAt,
    }];
  });
}

export function boardStatusLabel(status: BoardStatus): string {
  if (status === "ready") return "Ready";
  if (status === "provisioning") return "Setting up";
  if (status === "attention") return "Needs attention";
  if (status === "archived") return "Archived";
  return "Setup required";
}

export function formatBoardStamp(value?: string): string {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
