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
  pending: boolean;
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
    healthy: source.healthy === true || source.status === "ready",
    modelReady: source.modelReady === true,
    memoryEnabled: memory.enabled === true || source.memoryEnabled === true,
    memoryWriteApproval: memory.writeApproval === true || source.memoryWriteApproval === true || approvals.memory === true,
    skillWriteApproval: source.skillWriteApproval === true || approvals.skills === true,
    pending: source.pending === true,
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
