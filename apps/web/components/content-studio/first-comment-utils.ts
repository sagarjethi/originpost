export type FirstCommentStatus = "draft" | "pending_approval" | "approved" | "queued" | "processing" | "succeeded" | "failed" | "uncertain" | "cancelled";
export type FirstCommentRole = "viewer" | "creator" | "manager" | "owner";

export type FirstCommentIntentView = {
  id: string;
  targetId: string;
  platform: "instagram" | "facebook";
  body: string;
  bodySha256: string;
  status: FirstCommentStatus;
  executionMode: "write" | "reconcile";
  version: number;
  requestedBy: string;
  approval?: { actorId: string; approvedAt: string; mode: "two_person" | "single_owner_override" };
  publishProofId?: string;
  externalPostId?: string;
  providerAcceptedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type FirstCommentProofView = {
  id: string;
  canonicalSha256: string;
  evidence: { grade: "provider_confirmed" | "provider_reconciled" | "operator_attested"; observedAt: string };
  createdAt: string;
};

export type FirstCommentRecordView = { intent: FirstCommentIntentView; proofs: FirstCommentProofView[] };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseFirstCommentRecords(value: unknown): FirstCommentRecordView[] {
  const root = object(value);
  const rows = Array.isArray(root?.data) ? root.data : [];
  return rows.flatMap((entry) => {
    const record = object(entry); const intent = object(record?.intent);
    if (!record || !intent || typeof intent.id !== "string" || typeof intent.targetId !== "string" || (intent.platform !== "instagram" && intent.platform !== "facebook") || typeof intent.body !== "string" || typeof intent.bodySha256 !== "string" || typeof intent.version !== "number" || typeof intent.requestedBy !== "string" || typeof intent.createdAt !== "string" || typeof intent.updatedAt !== "string") return [];
    const statuses = new Set<FirstCommentStatus>(["draft", "pending_approval", "approved", "queued", "processing", "succeeded", "failed", "uncertain", "cancelled"]);
    if (!statuses.has(intent.status as FirstCommentStatus)) return [];
    const approval = object(intent.approval);
    const proofs = Array.isArray(record.proofs) ? record.proofs.flatMap((proofValue) => {
      const proof = object(proofValue); const evidence = object(proof?.evidence);
      if (!proof || !evidence || typeof proof.id !== "string" || typeof proof.canonicalSha256 !== "string" || typeof proof.createdAt !== "string" || (evidence.grade !== "provider_confirmed" && evidence.grade !== "provider_reconciled" && evidence.grade !== "operator_attested") || typeof evidence.observedAt !== "string") return [];
      return [{ id: proof.id, canonicalSha256: proof.canonicalSha256, createdAt: proof.createdAt, evidence: { grade: evidence.grade, observedAt: evidence.observedAt } } satisfies FirstCommentProofView];
    }) : [];
    return [{ intent: {
      id: intent.id, targetId: intent.targetId, platform: intent.platform, body: intent.body, bodySha256: intent.bodySha256,
      status: intent.status as FirstCommentStatus, executionMode: intent.executionMode === "reconcile" ? "reconcile" : "write", version: intent.version, requestedBy: intent.requestedBy,
      ...(approval && typeof approval.actorId === "string" && typeof approval.approvedAt === "string" && (approval.mode === "two_person" || approval.mode === "single_owner_override") ? { approval: { actorId: approval.actorId, approvedAt: approval.approvedAt, mode: approval.mode } } : {}),
      ...(typeof intent.publishProofId === "string" ? { publishProofId: intent.publishProofId } : {}), ...(typeof intent.externalPostId === "string" ? { externalPostId: intent.externalPostId } : {}),
      ...(typeof intent.providerAcceptedAt === "string" ? { providerAcceptedAt: intent.providerAcceptedAt } : {}), ...(typeof intent.lastError === "string" ? { lastError: intent.lastError } : {}),
      createdAt: intent.createdAt, updatedAt: intent.updatedAt,
    }, proofs }];
  });
}

export function firstCommentPermission(role: FirstCommentRole | undefined) {
  return { canDraft: role === "creator" || role === "manager" || role === "owner", canApprove: role === "manager" || role === "owner", canAttest: role === "manager" || role === "owner" };
}

export function firstCommentNeedsPoll(status: FirstCommentStatus) {
  return status === "approved" || status === "queued" || status === "processing";
}

export function firstCommentStatusCopy(status: FirstCommentStatus, executionMode: "write" | "reconcile") {
  if (status === "draft") return { label: "Draft", tone: "neutral", detail: "Edit this comment, then submit it for separate approval." };
  if (status === "pending_approval") return { label: "Approval needed", tone: "warning", detail: "The post and this exact comment are approved separately." };
  if (status === "approved") return { label: "Waiting for post", tone: "neutral", detail: "OriginPost will bind the comment to the exact publication proof before any provider call." };
  if (status === "queued") return { label: executionMode === "reconcile" ? "Inspection queued" : "Send queued", tone: "neutral", detail: executionMode === "reconcile" ? "The next provider action is read-only." : "The approved comment is waiting for one leased provider write." };
  if (status === "processing") return { label: executionMode === "reconcile" ? "Inspecting" : "Sending", tone: "neutral", detail: "OriginPost is checking the live post before recording proof." };
  if (status === "succeeded") return { label: "Proof recorded", tone: "success", detail: "The first comment has provider or operator evidence bound to the exact post." };
  if (status === "failed") return { label: "Failed safely", tone: "danger", detail: "No automatic retry will occur. Fix access or create a new governed request." };
  if (status === "uncertain") return { label: "Action required", tone: "warning", detail: "The provider outcome is not proven. Inspect first; never send another comment blindly." };
  return { label: "Cancelled", tone: "muted", detail: "This request will not contact the provider." };
}

export function firstCommentEvidenceLabel(grade: FirstCommentProofView["evidence"]["grade"]) {
  if (grade === "provider_confirmed") return "Provider confirmed";
  if (grade === "provider_reconciled") return "Provider reconciled";
  return "Operator attested";
}
