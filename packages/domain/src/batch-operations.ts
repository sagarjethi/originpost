import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent, DeliveryMode, Platform, ResearchDepth, RiskLevel, YouTubePrivacyStatus } from "./types.js";

export const batchPlanStatuses = ["ready", "processing", "review_ready", "partially_failed", "completed", "archived"] as const;
export type BatchPlanStatus = (typeof batchPlanStatuses)[number];
export const batchRowStatuses = ["invalid", "ready", "review_ready", "individual_review", "approved", "scheduled", "failed"] as const;
export type BatchRowStatus = (typeof batchRowStatuses)[number];
export type BatchRowFailedStep = "validation" | "prepare" | "approval" | "schedule";

export interface BatchYouTubeSettings { privacyStatus: YouTubePrivacyStatus; madeForKids: boolean; containsSyntheticMedia: boolean; notifySubscribers: boolean }
export interface BatchInputRow {
  externalRef: string; title: string; summary?: string | undefined; researchDepth?: ResearchDepth | undefined; riskLevel?: RiskLevel | undefined;
  platform: Platform; format: "image" | "carousel" | "reel" | "story" | "short" | "text"; caption: string; mediaAssetIds?: string[] | undefined;
  accountId?: string | undefined; scheduledFor?: string | undefined; timezone?: string | undefined; deliveryMode?: DeliveryMode | undefined; youtubeSettings?: BatchYouTubeSettings | undefined;
}
export interface BatchPlanRow {
  rowNumber: number; fingerprintSha256: string; externalRef: string; title: string; summary: string; researchDepth: ResearchDepth; riskLevel: RiskLevel;
  platform: Platform; format: BatchInputRow["format"]; caption: string; mediaAssetIds: string[]; accountId?: string | undefined; scheduledFor?: string | undefined;
  timezone?: string | undefined; deliveryMode: DeliveryMode; youtubeSettings?: BatchYouTubeSettings | undefined; status: BatchRowStatus; errors: string[]; warnings: string[];
  bulkApprovalEligible: boolean; failedStep?: BatchRowFailedStep | undefined; contentItemId?: string | undefined; draftId?: string | undefined; targetId?: string | undefined;
}
export interface BatchPlan {
  id: string; workspaceId: string; brandId: string; version: number; name: string; sourceSha256: string; status: BatchPlanStatus; rows: BatchPlanRow[];
  createdBy: string; createdAt: string; updatedAt: string; committedAt?: string | undefined; archivedAt?: string | undefined;
}
export interface BatchPlanRepository {
  create(plan: BatchPlan, event: AuditEvent): Promise<{ plan: BatchPlan; created: boolean }>;
  list(workspaceId: string, brandId?: string, limit?: number): Promise<BatchPlan[]>;
  get(workspaceId: string, id: string): Promise<BatchPlan | null>;
  replace(workspaceId: string, id: string, expectedVersion: number, plan: BatchPlan, event: AuditEvent): Promise<BatchPlan | null>;
}

const platformFormats: Record<Platform, ReadonlySet<BatchInputRow["format"]>> = { instagram: new Set(["image", "carousel", "reel", "story"]), facebook: new Set(["image", "reel", "text"]), youtube: new Set(["short"]) };
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`; return JSON.stringify(value); }
export function batchSha256(value: unknown): string { return createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function validTimezone(value: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; } }

function normalizedRow(input: BatchInputRow, rowNumber: number, now: string): BatchPlanRow {
  const externalRef = input.externalRef.trim(); const title = input.title.trim(); const summary = input.summary?.trim() ?? ""; const caption = input.caption.trim();
  const mediaAssetIds = [...new Set(input.mediaAssetIds?.map((value) => value.trim()).filter(Boolean) ?? [])]; const accountId = input.accountId?.trim() || undefined;
  const scheduledFor = input.scheduledFor?.trim() || undefined; const timezone = input.timezone?.trim() || undefined; const researchDepth = input.researchDepth ?? "standard";
  const riskLevel = input.riskLevel ?? "low"; const deliveryMode = input.deliveryMode ?? "auto_publish"; const errors: string[] = []; const warnings: string[] = [];
  if (!externalRef) errors.push("externalRef is required."); else if (externalRef.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(externalRef)) errors.push("externalRef must be 1–200 letters, numbers, dot, dash, underscore, or colon.");
  if (!title || title.length > 180) errors.push("title must contain 1–180 characters."); if (summary.length > 2000) errors.push("summary cannot exceed 2,000 characters.");
  if (!caption || caption.length > 10_000) errors.push("caption must contain 1–10,000 characters."); if (!platformFormats[input.platform]?.has(input.format)) errors.push(`${input.format} is not supported for ${input.platform} batch drafts.`);
  if (mediaAssetIds.length > 20) errors.push("A row can use at most 20 media assets."); if (input.format === "text" && mediaAssetIds.length) errors.push("A text post cannot include media.");
  if (["image", "reel", "story", "short"].includes(input.format) && mediaAssetIds.length !== 1) errors.push(`${input.format} needs exactly one media asset.`);
  if (input.format === "carousel" && (mediaAssetIds.length < 2 || mediaAssetIds.length > 10)) errors.push("A carousel needs 2–10 media assets.");
  if (Boolean(accountId) !== Boolean(scheduledFor)) errors.push("accountId and scheduledFor must be supplied together.");
  if (scheduledFor) { const time = Date.parse(scheduledFor); if (!Number.isFinite(time)) errors.push("scheduledFor must be an ISO date-time."); else if (time <= Date.parse(now)) errors.push("scheduledFor must be in the future."); }
  if (timezone && !validTimezone(timezone)) errors.push("timezone must be a valid IANA time zone.");
  if (input.platform === "youtube" && accountId && !input.youtubeSettings) errors.push("YouTube scheduling needs audience and synthetic-media declarations.");
  if (input.platform !== "youtube" && input.youtubeSettings) errors.push("youtubeSettings can be used only for YouTube rows.");
  if (riskLevel === "high" || riskLevel === "sensitive") warnings.push("This risk level requires individual review and cannot use batch approval.");
  const canonical = { externalRef, title, summary, researchDepth, riskLevel, platform: input.platform, format: input.format, caption, mediaAssetIds, accountId: accountId ?? null, scheduledFor: scheduledFor ?? null, timezone: timezone ?? null, deliveryMode, youtubeSettings: input.youtubeSettings ?? null };
  return { rowNumber, fingerprintSha256: batchSha256(canonical), externalRef, title, summary, researchDepth, riskLevel, platform: input.platform, format: input.format, caption, mediaAssetIds, ...(accountId ? { accountId } : {}), ...(scheduledFor ? { scheduledFor } : {}), ...(timezone ? { timezone } : {}), deliveryMode, ...(input.youtubeSettings ? { youtubeSettings: input.youtubeSettings } : {}), status: errors.length ? "invalid" : "ready", errors, warnings, bulkApprovalEligible: errors.length === 0 && riskLevel !== "high" && riskLevel !== "sensitive", ...(errors.length ? { failedStep: "validation" as const } : {}) };
}

export function createBatchPlan(input: { id: string; workspaceId: string; brandId: string; name: string; rows: BatchInputRow[]; actor: Actor }, now = new Date().toISOString()): BatchPlan {
  if (input.actor.actorType && input.actor.actorType !== "human") throw new DomainError("Only a signed-in person can create a batch.", "human_required", 403);
  if (!can(input.actor.role, "content:create") || !can(input.actor.role, "content:edit")) throw new DomainError("This role cannot create batch drafts.", "permission_denied", 403);
  const name = input.name.trim(); if (name.length < 2 || name.length > 120) throw new DomainError("Batch name must contain 2–120 characters.", "batch_name_invalid");
  if (input.rows.length < 1 || input.rows.length > 100) throw new DomainError("A batch must contain 1–100 rows.", "batch_size_invalid");
  const rows = input.rows.map((row, index) => normalizedRow(row, index + 1, now)); const externalRefs = new Map<string, number[]>(); const fingerprints = new Map<string, number[]>();
  for (const row of rows) { externalRefs.set(row.externalRef.toLowerCase(), [...(externalRefs.get(row.externalRef.toLowerCase()) ?? []), row.rowNumber]); fingerprints.set(row.fingerprintSha256, [...(fingerprints.get(row.fingerprintSha256) ?? []), row.rowNumber]); }
  const duplicateRows = new Set([...externalRefs.values(), ...fingerprints.values()].filter((list) => list.length > 1).flat());
  const checked = rows.map((row) => duplicateRows.has(row.rowNumber) ? { ...row, status: "invalid" as const, bulkApprovalEligible: false, failedStep: "validation" as const, errors: [...row.errors, "This row duplicates another externalRef or exact post in the batch."] } : row);
  const sourceSha256 = batchSha256({ brandId: input.brandId, rows: checked.map(({ status: _status, errors: _errors, warnings: _warnings, bulkApprovalEligible: _eligible, failedStep: _failedStep, ...row }) => row) });
  return { id: input.id, workspaceId: input.workspaceId, brandId: input.brandId, version: 1, name, sourceSha256, status: "ready", rows: checked, createdBy: input.actor.id, createdAt: now, updatedAt: now };
}
export function addBatchRowDiagnostics(plan: BatchPlan, diagnostics: ReadonlyMap<number, { errors?: string[]; warnings?: string[] }>): BatchPlan {
  const rows = plan.rows.map((row) => { const extra = diagnostics.get(row.rowNumber); if (!extra) return row; const errors = [...row.errors, ...(extra.errors ?? [])]; const warnings = [...row.warnings, ...(extra.warnings ?? [])]; return { ...row, errors, warnings, status: errors.length ? "invalid" as const : row.status, bulkApprovalEligible: row.bulkApprovalEligible && errors.length === 0, ...(errors.length ? { failedStep: "validation" as const } : {}) }; }); return { ...plan, rows };
}
export function batchContentItemId(plan: Pick<BatchPlan, "workspaceId" | "id">, row: Pick<BatchPlanRow, "fingerprintSha256">): string { return `content_batch_${batchSha256([plan.workspaceId, plan.id, row.fingerprintSha256]).slice(0, 32)}`; }
export function batchTargetId(plan: Pick<BatchPlan, "workspaceId" | "id">, row: Pick<BatchPlanRow, "fingerprintSha256">): string { return `target_batch_${batchSha256([plan.workspaceId, plan.id, row.fingerprintSha256, "schedule"]).slice(0, 32)}`; }
export function summarizeBatchPlan(rows: BatchPlanRow[]): BatchPlanStatus { const actionable = rows.filter((row) => row.status !== "invalid"); if (actionable.length && actionable.every((row) => row.status === "approved" || row.status === "scheduled" || row.status === "individual_review")) return "completed"; if (actionable.some((row) => row.status === "failed")) return "partially_failed"; if (actionable.some((row) => ["review_ready", "individual_review", "approved", "scheduled"].includes(row.status))) return "review_ready"; return "ready"; }

export class InMemoryBatchPlanRepository implements BatchPlanRepository {
  private readonly plans = new Map<string, BatchPlan>();
  async create(plan: BatchPlan): Promise<{ plan: BatchPlan; created: boolean }> { const existing = [...this.plans.values()].find((entry) => entry.workspaceId === plan.workspaceId && entry.brandId === plan.brandId && entry.sourceSha256 === plan.sourceSha256); if (existing) return { plan: structuredClone(existing), created: false }; this.plans.set(plan.id, structuredClone(plan)); return { plan: structuredClone(plan), created: true }; }
  async list(workspaceId: string, brandId?: string, limit = 50): Promise<BatchPlan[]> { return [...this.plans.values()].filter((plan) => plan.workspaceId === workspaceId && (!brandId || plan.brandId === brandId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((plan) => structuredClone(plan)); }
  async get(workspaceId: string, id: string): Promise<BatchPlan | null> { const plan = this.plans.get(id); return plan?.workspaceId === workspaceId ? structuredClone(plan) : null; }
  async replace(workspaceId: string, id: string, expectedVersion: number, plan: BatchPlan): Promise<BatchPlan | null> { const existing = this.plans.get(id); if (!existing || existing.workspaceId !== workspaceId || existing.version !== expectedVersion) return null; this.plans.set(id, structuredClone(plan)); return structuredClone(plan); }
}

export function normalizeContentImportRow(value: Record<string, unknown>, rowNumber: number) {
  const externalRef = typeof value.externalRef === "string" ? value.externalRef.trim() : ""; const title = typeof value.title === "string" ? value.title.trim() : ""; const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  const researchDepth = ["quick", "standard", "deep"].includes(String(value.researchDepth)) ? value.researchDepth as ResearchDepth : "standard"; const riskLevel = ["low", "medium", "high", "sensitive"].includes(String(value.riskLevel)) ? value.riskLevel as RiskLevel : "low"; const errors: string[] = [];
  if (!externalRef) errors.push("externalRef is required."); else if (externalRef.length > 200) errors.push("externalRef is longer than 200 characters."); else if (!/^[A-Za-z0-9._:-]+$/.test(externalRef)) errors.push("externalRef contains unsupported characters.");
  if (!title) errors.push("title is required."); else if (title.length > 180) errors.push("title is longer than 180 characters."); if (summary.length > 2000) errors.push("summary is longer than 2,000 characters.");
  return { rowNumber, externalRef, title, summary, researchDepth, riskLevel, status: errors.length ? "invalid" as const : "valid" as const, errors };
}
