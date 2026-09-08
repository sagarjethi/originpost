import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { canonicalSha256 } from "./remote-correction.js";
import type { Actor, AuditEvent, ContentItem, Platform, PublishProof, PublishTarget } from "./types.js";

export type FirstCommentPlatform = Extract<Platform, "instagram" | "facebook">;
export type FirstCommentStatus = "draft" | "pending_approval" | "approved" | "queued" | "processing" | "succeeded" | "failed" | "uncertain" | "cancelled";
export type FirstCommentExecutionMode = "write" | "reconcile";

export interface FirstCommentApproval {
  actorId: string;
  actorType: "human";
  approvedAt: string;
  mode: "two_person" | "single_owner_override";
  secondConfirmedAt?: string | undefined;
}

export interface FirstCommentIntent {
  id: string;
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  targetId: string;
  draftId: string;
  draftSha256: string;
  platform: FirstCommentPlatform;
  accountId: string;
  body: string;
  bodySha256: string;
  immutableIntentSha256: string;
  status: FirstCommentStatus;
  executionMode: FirstCommentExecutionMode;
  version: number;
  requestedBy: string;
  approval?: FirstCommentApproval | undefined;
  publishProofId?: string | undefined;
  externalPostId?: string | undefined;
  providerCommentId?: string | undefined;
  providerAcceptedAt?: string | undefined;
  providerResponseSha256?: string | undefined;
  lastError?: string | undefined;
  claimOwner?: string | undefined;
  claimExpiresAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type FirstCommentEvidence =
  | { grade: "provider_confirmed" | "provider_reconciled"; providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string; observedAt: string }
  | { grade: "operator_attested"; actorId: string; occurredAt: string; evidenceUrl: string; noteSha256: string; observationSha256: string; observedAt: string };

export interface FirstCommentProof {
  id: string;
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  intentId: string;
  publishProofId: string;
  targetId: string;
  draftId: string;
  draftSha256: string;
  platform: FirstCommentPlatform;
  accountId: string;
  externalPostId: string;
  bodySha256: string;
  evidence: FirstCommentEvidence;
  canonicalSha256: string;
  createdAt: string;
}

export interface FirstCommentRecord { intent: FirstCommentIntent; proofs: FirstCommentProof[] }

export interface FirstCommentExecutionContext {
  intent: FirstCommentIntent;
  publishProof: PublishProof;
}

export interface FirstCommentRepository {
  create(intent: FirstCommentIntent, event: AuditEvent): Promise<boolean>;
  get(workspaceId: string, intentId: string): Promise<FirstCommentRecord | null>;
  list(workspaceId: string, contentItemId: string): Promise<FirstCommentRecord[]>;
  compareAndSet(intent: FirstCommentIntent, expectedVersion: number, expectedStatuses: FirstCommentStatus[], event: AuditEvent): Promise<boolean>;
  claimForExecution(workspaceId: string, intentId: string, owner: string, leaseSeconds: number, event: AuditEvent): Promise<FirstCommentExecutionContext | null>;
  checkpointProviderEvidence(workspaceId: string, intentId: string, owner: string, evidence: { providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string }, at: string): Promise<boolean>;
  finishExecution(workspaceId: string, intentId: string, owner: string, status: "failed" | "uncertain", error: string, event: AuditEvent): Promise<FirstCommentIntent | null>;
  resolveWithProof(input: { workspaceId: string; intentId: string; owner?: string; evidence: FirstCommentEvidence; proofId: string; resolvedAt: string }, event: AuditEvent): Promise<{ intent: FirstCommentIntent; proof: FirstCommentProof } | null>;
  recoverExpiredProcessing(limit?: number): Promise<FirstCommentIntent[]>;
  listForRecovery(limit?: number): Promise<FirstCommentIntent[]>;
}

function required(value: string, label: string, max = 500): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > max) throw new DomainError(`${label} is required and must be at most ${max} characters.`, "first_comment_invalid", 400);
  return normalized;
}

export function firstCommentBody(value: string): string {
  const normalized = required(value, "First comment", 2_200);
  if (/\p{C}/u.test(normalized.replace(/[\n\t]/gu, ""))) throw new DomainError("First comment contains unsupported control characters.", "first_comment_invalid", 400);
  return normalized;
}

export function firstCommentBodySha256(value: string): string {
  return createHash("sha256").update(firstCommentBody(value)).digest("hex");
}

function firstCommentIntentHash(input: Pick<FirstCommentIntent, "workspaceId" | "brandId" | "contentItemId" | "targetId" | "draftId" | "draftSha256" | "platform" | "accountId" | "bodySha256">): string {
  return canonicalSha256({ schemaVersion: "originpost.first-comment-intent.v1", ...input });
}

function targetLineage(item: ContentItem, targetId: string): { target: PublishTarget & { platform: FirstCommentPlatform }; draftSha256: string } {
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "first_comment_target_not_found", 404);
  if (target.platform !== "instagram" && target.platform !== "facebook") throw new DomainError("First comments are supported only for Instagram and Facebook Page targets.", "first_comment_platform_unsupported", 409);
  if (target.status === "cancelled" || target.status === "failed") throw new DomainError("A cancelled or failed target cannot receive a first comment.", "first_comment_target_unavailable", 409);
  const draft = item.drafts.find((entry) => entry.id === target.draftId);
  if (!draft) throw new DomainError("The target draft is unavailable.", "first_comment_draft_not_found", 409);
  const approved = item.approvals.some((approval) => approval.draftId === draft.id && approval.draftSha256 === draft.contentSha256 && approval.decision === "approved");
  if (!approved) throw new DomainError("Approve the exact target draft before adding a first comment.", "first_comment_draft_not_approved", 409);
  return { target: target as PublishTarget & { platform: FirstCommentPlatform }, draftSha256: draft.contentSha256 };
}

export function createFirstCommentIntent(input: { id?: string; item: ContentItem; targetId: string; body: string; actor: Actor; now?: string }): FirstCommentIntent {
  if (input.actor.actorType && input.actor.actorType !== "human") throw new DomainError("A human must create the first comment.", "first_comment_human_required", 403);
  if (input.actor.role === "viewer") throw new DomainError("Viewers cannot create first comments.", "permission_denied", 403);
  const { target, draftSha256 } = targetLineage(input.item, input.targetId);
  const now = input.now ?? new Date().toISOString();
  const body = firstCommentBody(input.body);
  const base = {
    workspaceId: input.item.workspaceId,
    brandId: input.item.brandId,
    contentItemId: input.item.id,
    targetId: target.id,
    draftId: target.draftId,
    draftSha256,
    platform: target.platform,
    accountId: target.accountId,
    bodySha256: firstCommentBodySha256(body),
  } satisfies Pick<FirstCommentIntent, "workspaceId" | "brandId" | "contentItemId" | "targetId" | "draftId" | "draftSha256" | "platform" | "accountId" | "bodySha256">;
  return { id: input.id ?? `first_comment_${randomUUID()}`, ...base, body, immutableIntentSha256: firstCommentIntentHash(base), status: "draft", executionMode: "write", version: 1, requestedBy: input.actor.id, createdAt: now, updatedAt: now };
}

export function reviseFirstCommentIntent(intent: FirstCommentIntent, input: { body: string; actor: Actor; at?: string }): FirstCommentIntent {
  if (intent.status !== "draft") throw new DomainError("Only a draft first comment can be revised.", "first_comment_not_draft", 409);
  if (input.actor.id !== intent.requestedBy && input.actor.role !== "owner" && input.actor.role !== "manager") throw new DomainError("Only the author, a manager, or an owner can revise this first comment.", "permission_denied", 403);
  const body = firstCommentBody(input.body);
  const bodySha256 = firstCommentBodySha256(body);
  const base = { workspaceId: intent.workspaceId, brandId: intent.brandId, contentItemId: intent.contentItemId, targetId: intent.targetId, draftId: intent.draftId, draftSha256: intent.draftSha256, platform: intent.platform, accountId: intent.accountId, bodySha256 };
  return { ...intent, body, bodySha256, immutableIntentSha256: firstCommentIntentHash(base), version: intent.version + 1, updatedAt: input.at ?? new Date().toISOString() };
}

export function submitFirstCommentIntent(intent: FirstCommentIntent, actor: Actor, at = new Date().toISOString()): FirstCommentIntent {
  if (intent.status !== "draft") throw new DomainError("Only a draft first comment can be submitted.", "first_comment_not_draft", 409);
  if (actor.id !== intent.requestedBy && actor.role !== "owner" && actor.role !== "manager") throw new DomainError("Only the author, a manager, or an owner can submit this first comment.", "permission_denied", 403);
  return { ...intent, status: "pending_approval", version: intent.version + 1, updatedAt: at };
}

export function approveFirstCommentIntent(intent: FirstCommentIntent, approval: FirstCommentApproval): FirstCommentIntent {
  if (intent.status !== "pending_approval") throw new DomainError("This first comment is not awaiting approval.", "first_comment_not_pending", 409);
  if (approval.actorType !== "human") throw new DomainError("First-comment approval requires a human.", "first_comment_human_required", 403);
  if (Date.parse(approval.approvedAt) < Date.parse(intent.createdAt)) throw new DomainError("Approval cannot predate the first-comment request.", "first_comment_approval_time", 409);
  return { ...intent, approval, status: "approved", version: intent.version + 1, updatedAt: approval.approvedAt };
}

export function bindFirstCommentToProof(intent: FirstCommentIntent, proof: PublishProof, at = new Date().toISOString()): FirstCommentIntent {
  if (intent.status !== "approved") throw new DomainError("Only an approved first comment can bind to publication proof.", "first_comment_not_approved", 409);
  if (proof.contentItemId !== intent.contentItemId || proof.draftId !== intent.draftId || proof.draftSha256 !== intent.draftSha256 || proof.platform !== intent.platform || proof.accountId !== intent.accountId) {
    throw new DomainError("Publication proof does not match the approved first-comment lineage.", "first_comment_lineage_mismatch", 409);
  }
  return { ...intent, publishProofId: proof.id, externalPostId: proof.externalPostId, status: "queued", version: intent.version + 1, updatedAt: at };
}

export function transitionFirstComment(intent: FirstCommentIntent, status: FirstCommentStatus, at: string, error?: string): FirstCommentIntent {
  const allowed: Record<FirstCommentStatus, FirstCommentStatus[]> = {
    draft: ["pending_approval", "cancelled"], pending_approval: ["approved", "cancelled"], approved: ["queued", "cancelled"], queued: ["processing", "cancelled"], processing: ["succeeded", "failed", "uncertain"], uncertain: ["queued", "succeeded", "cancelled"], failed: [], succeeded: [], cancelled: [],
  };
  if (!allowed[intent.status].includes(status)) throw new DomainError(`First comment cannot move from ${intent.status} to ${status}.`, "first_comment_transition", 409);
  return { ...intent, status, version: intent.version + 1, updatedAt: at, ...(error ? { lastError: error.slice(0, 500) } : { lastError: undefined }), ...(status === "processing" ? {} : { claimOwner: undefined, claimExpiresAt: undefined }) };
}

export function createFirstCommentProof(intent: FirstCommentIntent, evidence: FirstCommentEvidence, proofId: string, createdAt: string): FirstCommentProof {
  if (!intent.publishProofId || !intent.externalPostId) throw new DomainError("First-comment proof requires exact publication proof lineage.", "first_comment_lineage_mismatch", 409);
  if ((evidence.grade === "provider_confirmed" || evidence.grade === "provider_reconciled") && (!/^[a-f0-9]{64}$/u.test(evidence.providerResponseSha256) || !evidence.providerCommentId.trim())) throw new DomainError("Provider first-comment evidence is incomplete.", "first_comment_evidence_invalid", 409);
  if (evidence.grade === "operator_attested") {
    const expected = canonicalSha256({ schemaVersion: "originpost.first-comment-operator-evidence.v1", actorId: evidence.actorId, occurredAt: evidence.occurredAt, evidenceUrl: evidence.evidenceUrl, noteSha256: evidence.noteSha256, intentId: intent.id, externalPostId: intent.externalPostId });
    if (expected !== evidence.observationSha256) throw new DomainError("Operator first-comment evidence does not match its canonical digest.", "first_comment_evidence_invalid", 409);
  }
  const base = { id: proofId, workspaceId: intent.workspaceId, brandId: intent.brandId, contentItemId: intent.contentItemId, intentId: intent.id, publishProofId: intent.publishProofId, targetId: intent.targetId, draftId: intent.draftId, draftSha256: intent.draftSha256, platform: intent.platform, accountId: intent.accountId, externalPostId: intent.externalPostId, bodySha256: intent.bodySha256, evidence, createdAt };
  return { ...base, canonicalSha256: canonicalSha256({ schemaVersion: "originpost.first-comment-proof.v1", value: base }) };
}

export class InMemoryFirstCommentRepository implements FirstCommentRepository {
  private readonly records = new Map<string, FirstCommentRecord>();
  readonly events: AuditEvent[] = [];
  constructor(private readonly contentRepository: { get(workspaceId: string, id: string): Promise<ContentItem | null> }, private readonly clock: () => Date = () => new Date()) {}
  async create(intent: FirstCommentIntent, event: AuditEvent) { if ([...this.records.values()].some((record) => record.intent.workspaceId === intent.workspaceId && record.intent.targetId === intent.targetId && !["cancelled", "failed"].includes(record.intent.status))) return false; this.records.set(intent.id, { intent: structuredClone(intent), proofs: [] }); this.events.push(structuredClone(event)); return true; }
  async get(workspaceId: string, intentId: string) { const value = this.records.get(intentId); return value?.intent.workspaceId === workspaceId ? structuredClone(value) : null; }
  async list(workspaceId: string, contentItemId: string) { return [...this.records.values()].filter((record) => record.intent.workspaceId === workspaceId && record.intent.contentItemId === contentItemId).map((value) => structuredClone(value)); }
  async compareAndSet(intent: FirstCommentIntent, expectedVersion: number, expectedStatuses: FirstCommentStatus[], event: AuditEvent) { const current = this.records.get(intent.id); if (!current || current.intent.version !== expectedVersion || !expectedStatuses.includes(current.intent.status)) return false; current.intent = structuredClone(intent); this.events.push(structuredClone(event)); return true; }
  async claimForExecution(workspaceId: string, intentId: string, owner: string, leaseSeconds: number, event: AuditEvent) { const record = this.records.get(intentId); if (!record || record.intent.workspaceId !== workspaceId || record.intent.status !== "queued" || !record.intent.publishProofId) return null; const item = await this.contentRepository.get(workspaceId, record.intent.contentItemId); const proof = item?.proofs.find((entry) => entry.id === record.intent.publishProofId); if (!proof) return null; const now = this.clock(); record.intent = { ...record.intent, status: "processing", claimOwner: owner, claimExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(), version: record.intent.version + 1, updatedAt: now.toISOString() }; this.events.push(structuredClone(event)); return { intent: structuredClone(record.intent), publishProof: structuredClone(proof) }; }
  async checkpointProviderEvidence(workspaceId: string, intentId: string, owner: string, evidence: { providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string }, at: string) { const record = this.records.get(intentId); if (!record || record.intent.workspaceId !== workspaceId || record.intent.status !== "processing" || record.intent.claimOwner !== owner || Date.parse(record.intent.claimExpiresAt ?? "") <= this.clock().getTime()) return false; record.intent = { ...record.intent, ...evidence, version: record.intent.version + 1, updatedAt: at }; return true; }
  async finishExecution(workspaceId: string, intentId: string, owner: string, status: "failed" | "uncertain", error: string, event: AuditEvent) { const record = this.records.get(intentId); if (!record || record.intent.workspaceId !== workspaceId || record.intent.status !== "processing" || record.intent.claimOwner !== owner || Date.parse(record.intent.claimExpiresAt ?? "") <= this.clock().getTime()) return null; record.intent = transitionFirstComment(record.intent, status, this.clock().toISOString(), error); this.events.push(structuredClone(event)); return structuredClone(record.intent); }
  async resolveWithProof(input: { workspaceId: string; intentId: string; owner?: string; evidence: FirstCommentEvidence; proofId: string; resolvedAt: string }, event: AuditEvent) { const record = this.records.get(input.intentId); if (!record || record.intent.workspaceId !== input.workspaceId || record.proofs.length) return null; if (input.evidence.grade !== "operator_attested" && (record.intent.status !== "processing" || !input.owner || record.intent.claimOwner !== input.owner || Date.parse(record.intent.claimExpiresAt ?? "") <= this.clock().getTime())) return null; if (input.evidence.grade === "operator_attested" && record.intent.status !== "uncertain") return null; const proof = createFirstCommentProof(record.intent, input.evidence, input.proofId, input.resolvedAt); record.intent = { ...record.intent, status: "succeeded", providerCommentId: input.evidence.grade === "operator_attested" ? record.intent.providerCommentId : input.evidence.providerCommentId, providerAcceptedAt: input.evidence.grade === "operator_attested" ? record.intent.providerAcceptedAt : input.evidence.providerAcceptedAt, providerResponseSha256: input.evidence.grade === "operator_attested" ? record.intent.providerResponseSha256 : input.evidence.providerResponseSha256, claimOwner: undefined, claimExpiresAt: undefined, version: record.intent.version + 1, updatedAt: input.resolvedAt }; record.proofs.push(proof); this.events.push(structuredClone(event)); return { intent: structuredClone(record.intent), proof: structuredClone(proof) }; }
  async recoverExpiredProcessing(limit = 100) { const now = this.clock().getTime(); const values = [...this.records.values()].filter((record) => record.intent.status === "processing" && Date.parse(record.intent.claimExpiresAt ?? "") <= now).slice(0, limit); for (const record of values) record.intent = transitionFirstComment(record.intent, "uncertain", this.clock().toISOString(), "The execution lease expired; reconcile before another provider write."); return values.map((record) => structuredClone(record.intent)); }
  async listForRecovery(limit = 100) { return [...this.records.values()].map((record) => record.intent).filter((intent) => ["approved", "queued", "uncertain"].includes(intent.status)).slice(0, limit).map((intent) => structuredClone(intent)); }
}
