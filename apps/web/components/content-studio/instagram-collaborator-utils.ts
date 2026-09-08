export type CollaboratorCapability =
  | { state: "supported"; connectionMode: "facebook_login"; publish: true; statusRead: true; maxCollaborators: 3 }
  | { state: "unsupported"; connectionMode: "instagram_login" | "facebook_login"; reason: "facebook_login_required" | "required_scopes_missing" | "endpoint_family_unsupported" | "endpoint_probe_required"; maxCollaborators: 3 };

export type CollaboratorCandidate = CollaboratorSettingsApproval & {
  id: string;
  status: "pending_approval" | "approved";
  requestedBy: string;
  requestedAt: string;
  approvalId?: string | undefined;
  approvedBy?: string | undefined;
};

export type CollaboratorSettingsApproval = {
  collaborators: string[];
  shareToFeed: boolean;
  isAiGenerated: boolean;
  reelCover?: {mode:"instagram_default"}|{mode:"video_frame";offsetMs:number}|{mode:"custom_image";mediaId:string;mediaSha256:string}|undefined;
  approvedSettingsSha256: string;
  accountId: string;
  publishingUsername: string;
  approvedAt?: string | undefined;
  draftId?: string | undefined;
  draftSha256?: string | undefined;
};

export type CollaboratorInviteProof =
  | { requestedUsernames: []; requestedUsernamesSha256: string; requestState: "not_requested"; providerConnectionMode: "instagram_login" | "facebook_login" }
  | { requestedUsernames: string[]; requestedUsernamesSha256: string; requestState: "requested_unverified"; providerConnectionMode: "facebook_login" };

export type CollaboratorSnapshotStatus = "pending" | "accepted" | "not_returned" | "unavailable";
export type CollaboratorStatusSnapshot = {
  proofId: string;
  externalMediaId: string;
  username: string;
  providerScopedUserId?: string | undefined;
  status: CollaboratorSnapshotStatus;
  capturedAt: string;
  providerResponseSha256: string;
};
export type CollaboratorStatusResult = {
  snapshots: CollaboratorStatusSnapshot[];
  trackingStatus: "not_started" | "pending" | "processing" | "complete" | "unavailable" | "expired";
  providerReadComplete: boolean;
  availability: string;
  capturedAt?: string | undefined;
  rawResponseSha256?: string | undefined;
  error?: string | undefined;
  nextAttemptAt?: string | undefined;
};

const usernamePattern = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function dataObject(value: unknown): Record<string, unknown> | null {
  const root = object(value);
  return object(root?.data) ?? root;
}

function normalizeOne(value: string): string | null {
  const normalized = value.normalize("NFC").trim().replace(/^@/u, "").toLowerCase();
  return usernamePattern.test(normalized) ? normalized : null;
}

export function normalizeCollaboratorInput(value: string, publishingUsername?: string): { usernames: string[]; error: string | null } {
  const parts = value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
  const usernames: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const username = normalizeOne(part);
    if (!username) return { usernames: [], error: "Use Instagram usernames with letters, numbers, periods, or underscores." };
    if (!seen.has(username)) { seen.add(username); usernames.push(username); }
  }
  if (usernames.length > 3) return { usernames: [], error: "Instagram accepts at most 3 collaborators." };
  const publisher = publishingUsername ? normalizeOne(publishingUsername) : null;
  if (publisher && seen.has(publisher)) return { usernames: [], error: "The publishing Instagram account cannot invite itself." };
  return { usernames, error: null };
}

export function parseCollaboratorCapability(value: unknown): CollaboratorCapability | null {
  return parseCollaboratorCapabilityView(value)?.capability ?? null;
}

export function parseCollaboratorCapabilityView(value: unknown): { capability: CollaboratorCapability; publishingUsername?: string } | null {
  const data = dataObject(value);
  const raw = object(data?.capability) ?? data;
  const publishingUsername = typeof data?.publishingUsername === "string" ? normalizeOne(data.publishingUsername) : null;
  if (raw?.state === "supported" && raw.connectionMode === "facebook_login" && raw.publish === true && raw.statusRead === true && raw.maxCollaborators === 3) {
    return { capability: { state: "supported", connectionMode: "facebook_login", publish: true, statusRead: true, maxCollaborators: 3 }, ...(publishingUsername ? { publishingUsername } : {}) };
  }
  const unsupportedReasons = new Set(["facebook_login_required", "required_scopes_missing", "endpoint_family_unsupported", "endpoint_probe_required"]);
  if (raw?.state === "unsupported" && (raw.connectionMode === "instagram_login" || raw.connectionMode === "facebook_login") && unsupportedReasons.has(String(raw.reason)) && raw.maxCollaborators === 3) {
    return { capability: { state: "unsupported", connectionMode: raw.connectionMode, reason: raw.reason as Extract<CollaboratorCapability,{state:"unsupported"}>["reason"], maxCollaborators: 3 }, ...(publishingUsername ? { publishingUsername } : {}) };
  }
  return null;
}

export function parseCollaboratorSettingsApproval(value: unknown): CollaboratorSettingsApproval | null {
  const data = dataObject(value);
  const settings = object(data?.settings) ?? data;
  const accountId = text(data?.accountId);
  const publishingUsername = typeof data?.publishingUsername === "string" ? normalizeOne(data.publishingUsername) : null;
  if (!accountId || !publishingUsername || !Array.isArray(settings?.collaborators) || settings.collaborators.some((entry) => typeof entry !== "string") || (settings.isAiGenerated !== undefined && typeof settings.isAiGenerated !== "boolean") || !sha256Pattern.test(String(settings.approvedSettingsSha256 ?? ""))) return null;
  const normalized = normalizeCollaboratorInput(settings.collaborators.join(" "), publishingUsername);
  if (normalized.error || normalized.usernames.length !== settings.collaborators.length) return null;
  const coverRaw=object(settings.reelCover);let reelCover:CollaboratorSettingsApproval["reelCover"];
  if(coverRaw?.mode==="instagram_default"&&Object.keys(coverRaw).length===1)reelCover={mode:"instagram_default"};
  else if(coverRaw?.mode==="video_frame"&&Number.isInteger(coverRaw.offsetMs)&&Number(coverRaw.offsetMs)>=0)reelCover={mode:"video_frame",offsetMs:Number(coverRaw.offsetMs)};
  else if(coverRaw?.mode==="custom_image"&&text(coverRaw.mediaId)&&sha256Pattern.test(String(coverRaw.mediaSha256??"")))reelCover={mode:"custom_image",mediaId:String(coverRaw.mediaId),mediaSha256:String(coverRaw.mediaSha256)};
  else if(settings.reelCover!==undefined)return null;
  return {
    collaborators: normalized.usernames,
    shareToFeed:settings.shareToFeed!==false,
    isAiGenerated:settings.isAiGenerated===true,
    ...(reelCover?{reelCover}:{}),
    approvedSettingsSha256: String(settings.approvedSettingsSha256),
    accountId,
    publishingUsername,
    ...(text(data?.approvedAt) ? { approvedAt: text(data?.approvedAt) } : {}),
    ...(text(data?.draftId) ? { draftId: text(data?.draftId) } : {}),
    ...(text(data?.draftSha256) ? { draftSha256: text(data?.draftSha256) } : {}),
  };
}

export function parseCollaboratorCandidates(value: unknown): CollaboratorCandidate[] {
  const root = object(value);
  const values = Array.isArray(root?.data) ? root.data : Array.isArray(value) ? value : [];
  return values.flatMap((entry) => {
    const raw = object(entry);
    const approval = parseCollaboratorSettingsApproval(raw);
    const id = text(raw?.id);
    const requestedBy = text(raw?.requestedBy);
    const requestedAt = text(raw?.requestedAt);
    const status = raw?.status;
    if (!approval || !id || !requestedBy || !requestedAt || (status !== "pending_approval" && status !== "approved")) return [];
    return [{ ...approval, id, status, requestedBy, requestedAt, ...(text(raw?.approvalId) ? { approvalId: text(raw?.approvalId) } : {}), ...(text(raw?.approvedBy) ? { approvedBy: text(raw?.approvedBy) } : {}) }];
  });
}

export function parseCollaboratorInviteProof(value: unknown): CollaboratorInviteProof | null {
  const data = dataObject(value);
  const raw = object(data?.collaboratorInviteProof) ?? object(data?.inviteProof) ?? data;
  if (!Array.isArray(raw?.requestedUsernames) || raw.requestedUsernames.some((entry) => typeof entry !== "string") || !sha256Pattern.test(String(raw.requestedUsernamesSha256 ?? ""))) return null;
  const normalized = normalizeCollaboratorInput(raw.requestedUsernames.join(" "));
  if (normalized.error || normalized.usernames.length !== raw.requestedUsernames.length) return null;
  if (raw.requestState === "not_requested" && normalized.usernames.length === 0 && (raw.providerConnectionMode === "instagram_login" || raw.providerConnectionMode === "facebook_login")) {
    return { requestedUsernames: [], requestedUsernamesSha256: String(raw.requestedUsernamesSha256), requestState: "not_requested", providerConnectionMode: raw.providerConnectionMode };
  }
  if (raw.requestState === "requested_unverified" && normalized.usernames.length > 0 && raw.providerConnectionMode === "facebook_login") {
    return { requestedUsernames: normalized.usernames, requestedUsernamesSha256: String(raw.requestedUsernamesSha256), requestState: "requested_unverified", providerConnectionMode: "facebook_login" };
  }
  return null;
}

function parseSnapshot(value: unknown): CollaboratorStatusSnapshot | null {
  const raw = object(value);
  const proofId = text(raw?.proofId);
  const externalMediaId = text(raw?.externalMediaId);
  const username = typeof raw?.username === "string" ? normalizeOne(raw.username) : null;
  const capturedAt = text(raw?.capturedAt);
  const providerResponseSha256 = text(raw?.providerResponseSha256);
  const status = raw?.status;
  if (!proofId || !externalMediaId || !username || !capturedAt || !providerResponseSha256 || !sha256Pattern.test(providerResponseSha256) || (status !== "pending" && status !== "accepted" && status !== "not_returned" && status !== "unavailable")) return null;
  return { proofId, externalMediaId, username, status, capturedAt, providerResponseSha256, ...(text(raw?.providerScopedUserId) ? { providerScopedUserId: text(raw?.providerScopedUserId) } : {}) };
}

export function parseCollaboratorStatusResult(value: unknown): CollaboratorStatusResult | null {
  const data = dataObject(value);
  const statuses = new Set(["not_started", "pending", "processing", "complete", "unavailable", "expired"]);
  if (!Array.isArray(data?.snapshots) || !statuses.has(String(data?.trackingStatus)) || typeof data?.providerReadComplete !== "boolean" || !text(data.availability)) return null;
  const snapshots = data.snapshots.flatMap((entry) => parseSnapshot(entry) ?? []);
  if (snapshots.length !== data.snapshots.length) return null;
  const capturedAt = text(data.capturedAt);
  const rawResponseSha256 = text(data.rawResponseSha256);
  if (rawResponseSha256 && !sha256Pattern.test(rawResponseSha256)) return null;
  const error = object(data.error);
  const retry = object(data.retry);
  return { snapshots, trackingStatus: String(data.trackingStatus) as CollaboratorStatusResult["trackingStatus"], providerReadComplete: data.providerReadComplete, availability: String(data.availability), ...(capturedAt ? { capturedAt } : {}), ...(rawResponseSha256 ? { rawResponseSha256 } : {}), ...(text(error?.message) ? { error: text(error?.message) } : {}), ...(text(retry?.nextAttemptAt) ? { nextAttemptAt: text(retry?.nextAttemptAt) } : {}) };
}

export function collaboratorStatusRows(requestedUsernames: readonly string[], snapshots: readonly CollaboratorStatusSnapshot[]): Array<{ username: string; status: CollaboratorSnapshotStatus; capturedAt?: string | undefined }> {
  const observed = new Map(snapshots.map((snapshot) => [snapshot.username, snapshot]));
  return requestedUsernames.map((raw) => {
    const username = normalizeOne(raw) ?? raw;
    const snapshot = observed.get(username);
    return { username, status: snapshot?.status ?? "not_returned", ...(snapshot?.capturedAt ? { capturedAt: snapshot.capturedAt } : {}) };
  });
}

export function collaboratorStatusCopy(status: CollaboratorSnapshotStatus): { label: string; detail: string; tone: "success" | "warning" | "neutral" } {
  if (status === "accepted") return { label: "Accepted", detail: "Instagram reports that this collaborator accepted the invite.", tone: "success" };
  if (status === "pending") return { label: "Pending", detail: "The invite was requested but has not been accepted yet.", tone: "warning" };
  if (status === "not_returned") return { label: "Not returned", detail: "Instagram did not return this username in the latest complete status read.", tone: "neutral" };
  return { label: "Temporarily unavailable", detail: "OriginPost could not read a reliable provider status. Try a later refresh.", tone: "warning" };
}

export function shortCollaboratorHash(value: string | undefined): string {
  if (!value) return "Not recorded";
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}
