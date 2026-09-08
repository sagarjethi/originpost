export type WorkspaceRole = "owner" | "manager" | "creator" | "viewer";
export type CorrectionPlatform = "instagram" | "facebook" | "youtube";
export type CorrectionAction = "make_private" | "restore_visibility" | "delete_remote" | "manual_remove";
export type CorrectionCapabilityState = "supported" | "unsupported" | "scope_required" | "contract_probe_required" | "manual_only";
export type CorrectionStatus = "pending_approval" | "approved" | "pre_write" | "finalizing" | "provider_confirmed" | "reconciled" | "manual_action_required" | "operator_confirmed" | "uncertain" | "rejected" | "cancelled";
export type EvidenceGrade = "provider_confirmed" | "provider_reconciled" | "operator_attested";

export type PublishProofSummary = {
  id: string;
  platform: string;
  liveUrl: string;
  externalPostId?: string | undefined;
  accountId?: string | undefined;
  publishedAt?: string | undefined;
  evidenceMode?: "official" | "manual_attestation" | "provider_reconciliation" | "simulation" | "legacy_unknown" | undefined;
  draftId?: string | undefined;
  draftSha256?: string | undefined;
  approvedSettingsSha256?: string | undefined;
  collaboratorInviteProof?: unknown;
  instagramAiDisclosure?: { requested: boolean; observed: boolean; label: "ai_info" } | undefined;
};

export type CapabilityAction = { state: CorrectionCapabilityState; reason?: string | undefined };
export type CorrectionCapabilities = {
  platform: CorrectionPlatform;
  providerVersion?: string | undefined;
  resolvedAt?: string | undefined;
  actions: Partial<Record<CorrectionAction, CapabilityAction>>;
};

export type CorrectionOperation = {
  id: string;
  publishProofId: string;
  platform: CorrectionPlatform;
  externalPostId: string;
  mutation: { action: CorrectionAction; visibility?: "public" | "unlisted" | undefined };
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approval?: { actorId?: string | undefined; approvedAt?: string | undefined; mode?: "two_person" | "single_owner_override" | undefined; secondConfirmedAt?: string | undefined } | undefined;
  immutableIntentSha256: string;
  beforeSnapshotSha256?: string | undefined;
  status: CorrectionStatus;
  statusReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type CorrectionAttempt = {
  id: string;
  kind: "execute" | "reconcile";
  status: "started" | "completed" | "failed";
  requestSha256: string;
  responseSha256?: string | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
};

export type RemovalProof = {
  id: string;
  operationId: string;
  evidenceGrade: EvidenceGrade;
  canonicalSha256: string;
  previousProofSha256: string;
  beforeSnapshotSha256?: string | undefined;
  afterObservationSha256?: string | undefined;
  providerReceiptSha256?: string | undefined;
  occurredAt?: string | undefined;
  observedAt?: string | undefined;
  createdAt?: string | undefined;
};

export type CorrectionRecord = { operation: CorrectionOperation; attempts: CorrectionAttempt[]; proofs: RemovalProof[] };

export const correctionActions: ReadonlyArray<{ value: CorrectionAction; label: string; detail: string }> = [
  { value: "make_private", label: "Make private", detail: "Hide the published item from public view without deleting it." },
  { value: "restore_visibility", label: "Restore visibility", detail: "Make a private or unlisted item visible again." },
  { value: "delete_remote", label: "Delete from platform", detail: "Permanently remove the published item when the provider contract allows it." },
  { value: "manual_remove", label: "Manual handoff", detail: "Complete the action in the provider and attach human evidence." },
];

const platforms = new Set<CorrectionPlatform>(["instagram", "facebook", "youtube"]);
const statuses = new Set<CorrectionStatus>(["pending_approval", "approved", "pre_write", "finalizing", "provider_confirmed", "reconciled", "manual_action_required", "operator_confirmed", "uncertain", "rejected", "cancelled"]);
const actionValues = new Set<CorrectionAction>(correctionActions.map((action) => action.value));
const capabilityStates = new Set<CorrectionCapabilityState>(["supported", "unsupported", "scope_required", "contract_probe_required", "manual_only"]);
const evidenceGrades = new Set<EvidenceGrade>(["provider_confirmed", "provider_reconciled", "operator_attested"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function correctionPermission(role: WorkspaceRole | undefined) {
  const allowed = role === "owner" || role === "manager";
  return { canRequest: allowed, canApprove: allowed };
}

export function correctionApprovalMode(role: WorkspaceRole | undefined, actorId: string, requestedBy: string): "two_person" | "single_owner_override" | "blocked" {
  if ((role === "owner" || role === "manager") && actorId !== requestedBy) return "two_person";
  if (role === "owner" && actorId === requestedBy) return "single_owner_override";
  return "blocked";
}

export function hasEligiblePublishProofs(proofs: readonly PublishProofSummary[]): boolean {
  return proofs.some(isEligiblePublishProof);
}

export function isEligiblePublishProof(proof: PublishProofSummary): boolean {
  if (!proof.id || !platforms.has(proof.platform as CorrectionPlatform) || !["official", "manual_attestation", "provider_reconciliation"].includes(proof.evidenceMode ?? "legacy_unknown")) return false;
  try { return !new URL(proof.liveUrl).hostname.endsWith(".invalid"); }
  catch { return false; }
}

export function correctionControlState(status: CorrectionStatus, approvalMode: "two_person" | "single_owner_override" | "blocked") {
  return {
    approve: status === "pending_approval" && approvalMode !== "blocked",
    reconcile: status === "uncertain" || status === "finalizing",
    attest: status === "manual_action_required",
  };
}

export function parseCapabilityResponse(value: unknown): CorrectionCapabilities | null {
  const root = record(value);
  const data = record(root?.data);
  const raw = record(data?.capabilities);
  const platform = text(raw?.platform);
  if (!platforms.has(platform as CorrectionPlatform)) return null;
  const rawActions = record(raw?.actions);
  const actions: CorrectionCapabilities["actions"] = {};
  for (const action of correctionActions) {
    const entry = record(rawActions?.[action.value]);
    const state = text(entry?.state);
    if (!capabilityStates.has(state as CorrectionCapabilityState)) continue;
    actions[action.value] = { state: state as CorrectionCapabilityState, ...(text(entry?.reason) ? { reason: text(entry?.reason) } : {}) };
  }
  return {
    platform: platform as CorrectionPlatform,
    ...(text(raw?.providerVersion) ? { providerVersion: text(raw?.providerVersion) } : {}),
    ...(text(raw?.resolvedAt) ? { resolvedAt: text(raw?.resolvedAt) } : {}),
    actions,
  };
}

function parseOperation(value: unknown): CorrectionOperation | null {
  const raw = record(value);
  const mutation = record(raw?.mutation);
  const id = text(raw?.id);
  const publishProofId = text(raw?.publishProofId);
  const platform = text(raw?.platform);
  const externalPostId = text(raw?.externalPostId);
  const action = text(mutation?.action);
  const reason = text(raw?.reason);
  const requestedBy = text(raw?.requestedBy);
  const requestedAt = text(raw?.requestedAt);
  const immutableIntentSha256 = text(raw?.immutableIntentSha256);
  const status = text(raw?.status);
  const createdAt = text(raw?.createdAt);
  const updatedAt = text(raw?.updatedAt);
  if (!id || !publishProofId || !platforms.has(platform as CorrectionPlatform) || !externalPostId || !actionValues.has(action as CorrectionAction) || !reason || !requestedBy || !requestedAt || !immutableIntentSha256 || !statuses.has(status as CorrectionStatus) || !createdAt || !updatedAt) return null;
  const approval = record(raw?.approval);
  const visibility = mutation?.visibility === "public" || mutation?.visibility === "unlisted" ? mutation.visibility : undefined;
  return {
    id,
    publishProofId,
    platform: platform as CorrectionPlatform,
    externalPostId,
    mutation: { action: action as CorrectionAction, ...(visibility ? { visibility } : {}) },
    reason,
    requestedBy,
    requestedAt,
    ...(approval ? { approval: {
      ...(text(approval.actorId) ? { actorId: text(approval.actorId) } : {}),
      ...(text(approval.approvedAt) ? { approvedAt: text(approval.approvedAt) } : {}),
      ...(approval.mode === "two_person" || approval.mode === "single_owner_override" ? { mode: approval.mode } : {}),
      ...(text(approval.secondConfirmedAt) ? { secondConfirmedAt: text(approval.secondConfirmedAt) } : {}),
    } } : {}),
    immutableIntentSha256,
    ...(text(raw?.beforeSnapshotSha256) ? { beforeSnapshotSha256: text(raw?.beforeSnapshotSha256) } : {}),
    status: status as CorrectionStatus,
    ...(text(raw?.statusReason) ? { statusReason: text(raw?.statusReason) } : {}),
    createdAt,
    updatedAt,
  };
}

function parseAttempt(value: unknown): CorrectionAttempt | null {
  const raw = record(value);
  const id = text(raw?.id);
  const kind = raw?.kind;
  const status = raw?.status;
  const requestSha256 = text(raw?.requestSha256);
  const startedAt = text(raw?.startedAt);
  if (!id || (kind !== "execute" && kind !== "reconcile") || (status !== "started" && status !== "completed" && status !== "failed") || !requestSha256 || !startedAt) return null;
  return { id, kind, status, requestSha256, startedAt, ...(text(raw?.responseSha256) ? { responseSha256: text(raw?.responseSha256) } : {}), ...(text(raw?.errorCode) ? { errorCode: text(raw?.errorCode) } : {}), ...(text(raw?.errorSummary) ? { errorSummary: text(raw?.errorSummary) } : {}), ...(text(raw?.completedAt) ? { completedAt: text(raw?.completedAt) } : {}) };
}

function parseProof(value: unknown): RemovalProof | null {
  const raw = record(value);
  const id = text(raw?.id);
  const operationId = text(raw?.operationId);
  const evidenceGrade = text(raw?.evidenceGrade);
  const canonicalSha256 = text(raw?.canonicalSha256);
  const previousProofSha256 = text(raw?.previousProofSha256);
  if (!id || !operationId || !evidenceGrades.has(evidenceGrade as EvidenceGrade) || !canonicalSha256 || !previousProofSha256) return null;
  return { id, operationId, evidenceGrade: evidenceGrade as EvidenceGrade, canonicalSha256, previousProofSha256, ...(text(raw?.beforeSnapshotSha256) ? { beforeSnapshotSha256: text(raw?.beforeSnapshotSha256) } : {}), ...(text(raw?.afterObservationSha256) ? { afterObservationSha256: text(raw?.afterObservationSha256) } : {}), ...(text(raw?.providerReceiptSha256) ? { providerReceiptSha256: text(raw?.providerReceiptSha256) } : {}), ...(text(raw?.occurredAt) ? { occurredAt: text(raw?.occurredAt) } : {}), ...(text(raw?.observedAt) ? { observedAt: text(raw?.observedAt) } : {}), ...(text(raw?.createdAt) ? { createdAt: text(raw?.createdAt) } : {}) };
}

export function parseCorrectionListResponse(value: unknown): CorrectionRecord[] {
  const root = record(value);
  const values = Array.isArray(root?.data) ? root.data : [];
  return values.flatMap((entry) => {
    const raw = record(entry);
    const operation = parseOperation(raw?.operation);
    if (!operation) return [];
    return [{ operation, attempts: Array.isArray(raw?.attempts) ? raw.attempts.flatMap((attempt) => parseAttempt(attempt) ?? []) : [], proofs: Array.isArray(raw?.proofs) ? raw.proofs.flatMap((proof) => parseProof(proof) ?? []) : [] }];
  });
}

export function parseCorrectionRecordResponse(value: unknown): CorrectionRecord | null {
  const root = record(value);
  const data = record(root?.data);
  const operation = parseOperation(data?.operation);
  if (!operation) return null;
  return { operation, attempts: Array.isArray(data?.attempts) ? data.attempts.flatMap((attempt) => parseAttempt(attempt) ?? []) : [], proofs: Array.isArray(data?.proofs) ? data.proofs.flatMap((proof) => parseProof(proof) ?? []) : [] };
}

export function parseMutationResponse(value: unknown): CorrectionOperation | null {
  const root = record(value);
  const data = record(root?.data);
  return parseOperation(data?.operation);
}

export function correctionStatusView(status: CorrectionStatus): { label: string; detail: string; tone: "neutral" | "success" | "warning" | "danger"; actionRequired: boolean; terminal: boolean } {
  const views: Record<CorrectionStatus, ReturnType<typeof correctionStatusView>> = {
    pending_approval: { label: "Pending approval", detail: "A manager or owner must approve before anything changes on the platform.", tone: "warning", actionRequired: true, terminal: false },
    approved: { label: "Approved", detail: "The exact request and provider snapshot were approved.", tone: "neutral", actionRequired: false, terminal: false },
    pre_write: { label: "Pre-write check", detail: "OriginPost is checking the approved state before the provider write.", tone: "neutral", actionRequired: false, terminal: false },
    finalizing: { label: "Finalizing", detail: "The provider write is in progress. Do not repeat it.", tone: "neutral", actionRequired: false, terminal: false },
    provider_confirmed: { label: "Provider confirmed", detail: "The provider returned confirmation and OriginPost saved provider evidence.", tone: "success", actionRequired: false, terminal: true },
    reconciled: { label: "Provider reconciled", detail: "A provider read-back verified the approved result.", tone: "success", actionRequired: false, terminal: true },
    manual_action_required: { label: "Manual action required", detail: "Complete the action in the provider, then attach human evidence.", tone: "warning", actionRequired: true, terminal: false },
    operator_confirmed: { label: "Operator attested", detail: "A person supplied evidence. The provider did not independently confirm it.", tone: "warning", actionRequired: false, terminal: true },
    uncertain: { label: "Uncertain result", detail: "The provider result is unknown. Reconcile it; never repeat the write blindly.", tone: "danger", actionRequired: true, terminal: false },
    rejected: { label: "Rejected", detail: "The provider or safety checks rejected this operation.", tone: "danger", actionRequired: true, terminal: true },
    cancelled: { label: "Cancelled", detail: "The correction was cancelled before completion.", tone: "neutral", actionRequired: false, terminal: true },
  };
  return views[status];
}

export function evidenceGradeView(grade: EvidenceGrade): { label: string; detail: string; tone: "success" | "warning" } {
  if (grade === "provider_confirmed") return { label: "Provider confirmed", detail: "The provider returned a confirmed result.", tone: "success" };
  if (grade === "provider_reconciled") return { label: "Provider reconciled", detail: "A later provider read-back verified the result.", tone: "success" };
  return { label: "Operator attested", detail: "A person supplied evidence. The provider did not independently confirm it.", tone: "warning" };
}

export function capabilityCopy(state: CorrectionCapabilityState | undefined): { label: string; tone: "success" | "warning" | "danger" } {
  if (state === "supported") return { label: "Supported", tone: "success" };
  if (state === "manual_only") return { label: "Manual only", tone: "warning" };
  if (state === "scope_required") return { label: "Reconnect required", tone: "warning" };
  if (state === "contract_probe_required") return { label: "Provider check required", tone: "warning" };
  return { label: "Unsupported", tone: "danger" };
}

export function manualGuidance(platform: CorrectionPlatform): string {
  if (platform === "facebook") return "Open the exact Page post in Meta Business Manager. Complete the action there, then attach an HTTPS evidence link.";
  if (platform === "instagram") return "Open the exact media in Instagram. Complete the action there, then attach an HTTPS evidence link.";
  return "Open the exact video in YouTube Studio. Complete the action there, then attach an HTTPS evidence link.";
}

export function shortHash(value: string | undefined): string {
  if (!value) return "Not recorded";
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

export function localDateTimeInputValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function attestationTimeError(occurredAt: string, approvedAt: string | undefined, now = new Date().toISOString()): string | null {
  const occurredTime = Date.parse(occurredAt);
  const approvalTime = approvedAt ? Date.parse(approvedAt) : Number.NaN;
  const nowTime = Date.parse(now);
  if (!Number.isFinite(occurredTime)) return "Choose a valid action time.";
  if (!Number.isFinite(approvalTime)) return "The approval time is unavailable. Refresh before adding evidence.";
  if (occurredTime < approvalTime) return "Action time cannot be before this correction was approved.";
  if (Number.isFinite(nowTime) && occurredTime > nowTime) return "Action time cannot be in the future.";
  return null;
}

export function operationNeedsPoll(status: CorrectionStatus): boolean {
  return status === "approved" || status === "pre_write" || status === "finalizing" || status === "uncertain";
}
