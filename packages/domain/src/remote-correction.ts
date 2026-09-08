import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { AuditEvent, OutboxMessageInput, Platform, PublishProof } from "./types.js";

export const remoteCorrectionActions = ["edit_text", "make_private", "restore_visibility", "delete_remote", "manual_remove"] as const;
export type RemoteCorrectionAction = (typeof remoteCorrectionActions)[number];

export const remoteCorrectionStatuses = [
  "pending_approval",
  "approved",
  "pre_write",
  "finalizing",
  "provider_confirmed",
  "reconciled",
  "manual_action_required",
  "operator_confirmed",
  "uncertain",
  "rejected",
  "cancelled",
] as const;
export type RemoteCorrectionStatus = (typeof remoteCorrectionStatuses)[number];
export type RemoteCorrectionEvidenceGrade = "provider_confirmed" | "provider_reconciled" | "operator_attested";
const resolutionEvidence = Symbol("originpost.remote-correction-resolution-evidence");

export type RemoteCorrectionMutation =
  | { action: "edit_text"; text: string }
  | { action: "make_private" }
  | { action: "restore_visibility"; visibility: "public" | "unlisted" }
  | { action: "delete_remote" }
  | { action: "manual_remove" };

export interface RemoteCorrectionLineage {
  publishProofId: string;
  contentItemId: string;
  draftId: string;
  draftSha256: string;
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
  accountId: string;
  externalPostId: string;
}

export interface RemoteCorrectionApproval {
  actorId: string;
  actorType: "human";
  approvedAt: string;
  mode?: "two_person" | "single_owner_override" | undefined;
  secondConfirmedAt?: string | undefined;
}

export interface RemoteCorrectionSnapshotEvidence extends RemoteCorrectionLineage {
  providerOwnerId: string;
  state: string;
  objectKind: string;
  mutableState: Record<string, unknown>;
  observedAt: string;
  providerVersion: string;
  canonicalSha256: string;
}

export interface RemoteCorrectionOperation extends RemoteCorrectionLineage {
  id: string;
  workspaceId: string;
  brandId: string;
  mutation: RemoteCorrectionMutation;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approval?: RemoteCorrectionApproval | undefined;
  publishProofSha256: string;
  beforeSnapshotSha256?: string | undefined;
  beforeSnapshot?: RemoteCorrectionSnapshotEvidence | undefined;
  immutableIntentSha256: string;
  status: RemoteCorrectionStatus;
  statusReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRemoteCorrectionOperationInput {
  id: string;
  workspaceId: string;
  brandId: string;
  publishProof: PublishProof;
  mutation: RemoteCorrectionMutation;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approval: RemoteCorrectionApproval;
  beforeSnapshotSha256: string;
}

export type CreateRemoteCorrectionRequestInput = Omit<CreateRemoteCorrectionOperationInput, "approval" | "beforeSnapshotSha256">;
export interface ApproveRemoteCorrectionInput {
  operation: RemoteCorrectionOperation;
  approval: RemoteCorrectionApproval;
  beforeSnapshot: RemoteCorrectionSnapshotEvidence;
}

export interface RemovalProof extends RemoteCorrectionLineage {
  id: string;
  operationId: string;
  workspaceId: string;
  mutation: RemoteCorrectionMutation;
  reason: string;
  requestedBy: string;
  approvedBy: string;
  immutableIntentSha256: string;
  evidenceGrade: RemoteCorrectionEvidenceGrade;
  beforeSnapshotSha256: string;
  afterObservationSha256: string;
  providerReceiptSha256?: string | undefined;
  previousProofSha256: string;
  occurredAt: string;
  observedAt: string;
  canonicalSha256: string;
  createdAt: string;
  operatorAttestation?:{actorId:string;target:string;evidenceRef:string;noteSha256:string}|undefined;
}

export interface CreateRemovalProofInput {
  id: string;
  operation: RemoteCorrectionOperation;
  previousProofSha256: string;
  createdAt: string;
  evidence:
    | { grade: "provider_confirmed"; afterObservationSha256: string; providerReceiptSha256: string; occurredAt: string; observedAt: string }
    | { grade: "provider_reconciled"; afterObservationSha256: string; occurredAt: string; observedAt: string }
    | { grade: "operator_attested"; afterObservationSha256: string; actorId: string; occurredAt: string; observedAt: string; evidenceRef: string; target: string; noteSha256:string };
}

export type RemoteCorrectionAttemptKind = "execute" | "reconcile";
export type RemoteCorrectionAttemptStatus = "started" | "completed" | "failed";

export interface RemoteCorrectionAttempt {
  id: string;
  workspaceId: string;
  operationId: string;
  kind: RemoteCorrectionAttemptKind;
  status: RemoteCorrectionAttemptStatus;
  requestSha256: string;
  responseSha256?: string | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
}

export interface RemoteCorrectionRecord {
  operation: RemoteCorrectionOperation;
  attempts: RemoteCorrectionAttempt[];
  proofs: RemovalProof[];
}
interface ResolveRemoteCorrectionBase {
  workspaceId:string;
  operationId:string;
  expected:readonly RemoteCorrectionStatus[];
  proofId:string;
  resolvedAt:string;
}
type ProviderResolutionEvidence=Extract<CreateRemovalProofInput["evidence"],{grade:"provider_confirmed"|"provider_reconciled"}>;
type OperatorResolutionEvidence=Extract<CreateRemovalProofInput["evidence"],{grade:"operator_attested"}>;
export type ResolveRemoteCorrectionInput =
  | (ResolveRemoteCorrectionBase & {evidence:ProviderResolutionEvidence;claimId:string})
  | (ResolveRemoteCorrectionBase & {evidence:OperatorResolutionEvidence;claimId?:never});

export function assertRemoteCorrectionResolutionClaim(input:ResolveRemoteCorrectionInput):void{
  iso(input.resolvedAt,"Resolution time");
  if(input.evidence.grade==="operator_attested"){
    if("claimId" in input&&input.claimId!==undefined)throw new DomainError("Operator attestation must not use a provider mutation claim.","remote_correction_claim_invalid",409);
    return;
  }
  if(typeof input.claimId!=="string"||!input.claimId.trim())throw new DomainError("Provider resolution claim ID is required.","remote_correction_claim_required",409);
}

export interface RemoteCorrectionRepository {
  create(operation: RemoteCorrectionOperation, event: AuditEvent, outbox?: OutboxMessageInput[]): Promise<boolean>;
  get(workspaceId: string, operationId: string): Promise<RemoteCorrectionRecord | null>;
  list(workspaceId: string, filters?: { contentItemId?: string; publishProofId?: string }): Promise<RemoteCorrectionRecord[]>;
  claim(workspaceId: string, operationId: string, claimId: string, kind: RemoteCorrectionAttemptKind, claimedAt: string, leaseExpiresAt: string): Promise<RemoteCorrectionOperation | null>;
  compareAndSet(operation: RemoteCorrectionOperation, expected: readonly RemoteCorrectionStatus[], event: AuditEvent, outbox?: OutboxMessageInput[], claimId?: string): Promise<boolean>;
  saveAttempt(attempt: RemoteCorrectionAttempt): Promise<void>;
  resolveWithProof(input: ResolveRemoteCorrectionInput, event: AuditEvent): Promise<{operation:RemoteCorrectionOperation;proof:RemovalProof} | null>;
}

export function resolveRemoteCorrectionEvidence(operation:RemoteCorrectionOperation,evidence:CreateRemovalProofInput["evidence"],at:string):Readonly<RemoteCorrectionOperation>{
  if(evidence.grade==="provider_confirmed")return resolveProviderConfirmed(operation,evidence,at);
  if(evidence.grade==="provider_reconciled")return resolveProviderReconciled(operation,evidence,at);
  return resolveOperatorAttestation(operation,evidence,at);
}

type Transition = Readonly<{ from: readonly RemoteCorrectionStatus[]; to: RemoteCorrectionStatus }>;

const transitions: Record<Exclude<RemoteCorrectionStatus, "pending_approval" | "approved">, Transition> = {
  pre_write: { from: ["approved"], to: "pre_write" },
  finalizing: { from: ["pre_write"], to: "finalizing" },
  provider_confirmed: { from: ["finalizing"], to: "provider_confirmed" },
  reconciled: { from: ["finalizing", "uncertain"], to: "reconciled" },
  manual_action_required: { from: ["approved", "pre_write", "finalizing", "uncertain"], to: "manual_action_required" },
  operator_confirmed: { from: ["manual_action_required"], to: "operator_confirmed" },
  uncertain: { from: ["finalizing"], to: "uncertain" },
  rejected: { from: ["approved", "pre_write", "finalizing", "uncertain"], to: "rejected" },
  cancelled: { from: ["approved", "pre_write", "uncertain", "manual_action_required"], to: "cancelled" },
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function required(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new DomainError(`${field} is required.`, "remote_correction_invalid", 400);
  return normalized;
}

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError(`${field} must be a lowercase SHA-256 digest.`, "remote_correction_invalid", 400);
  return value;
}

function iso(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new DomainError(`${field} must be an ISO timestamp.`, "remote_correction_invalid", 400);
  return value;
}

export function assertRemoteCorrectionMutation(input: unknown): RemoteCorrectionMutation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("Correction mutation must be an object.", "remote_correction_invalid", 400);
  const value = input as Record<string, unknown>;
  if (!remoteCorrectionActions.includes(value.action as RemoteCorrectionAction)) throw new DomainError("Correction action is not supported.", "remote_correction_invalid", 400);
  const allowed = value.action === "edit_text" ? ["action", "text"] : value.action === "restore_visibility" ? ["action", "visibility"] : ["action"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new DomainError("Correction mutation contains unsupported fields.", "remote_correction_invalid", 400);
  if (value.action === "edit_text") {
    const text = required(String(value.text ?? ""), "Correction text");
    if (text.length > 10_000) throw new DomainError("Correction text is too long.", "remote_correction_invalid", 400);
    return { action: "edit_text", text };
  }
  if (value.action === "restore_visibility") {
    if (value.visibility !== "public" && value.visibility !== "unlisted") throw new DomainError("Restore visibility must be public or unlisted.", "remote_correction_invalid", 400);
    return { action: "restore_visibility", visibility: value.visibility };
  }
  return { action: value.action } as RemoteCorrectionMutation;
}

function intentValue(operation: Omit<RemoteCorrectionOperation, "immutableIntentSha256" | "status" | "statusReason" | "createdAt" | "updatedAt">): unknown {
  return operation;
}

export function createRemoteCorrectionOperation(input: CreateRemoteCorrectionOperationInput): Readonly<RemoteCorrectionOperation> {
  if (input.approval.actorType !== "human") throw new DomainError("Remote correction requires human approval.", "remote_correction_human_approval_required", 409);
  const request = createRemoteCorrectionRequest(input);
  throw new DomainError("Use createRemoteCorrectionRequest followed by approveRemoteCorrectionRequest with snapshot evidence.", "remote_correction_split_approval_required", 409);
}

export function createRemoteCorrectionRequest(input: CreateRemoteCorrectionRequestInput): Readonly<RemoteCorrectionOperation> {
  const mutation = assertRemoteCorrectionMutation(input.mutation);
  const reason = required(input.reason, "Correction reason");
  if (reason.length > 2_000) throw new DomainError("Correction reason is too long.", "remote_correction_invalid", 400);
  const base = {
    id: required(input.id, "Operation ID"),
    workspaceId: required(input.workspaceId, "Workspace ID"),
    brandId: required(input.brandId, "Brand ID"),
    publishProofId: required(input.publishProof.id, "Publish proof ID"),
    contentItemId: required(input.publishProof.contentItemId, "Content item ID"),
    draftId: required(input.publishProof.draftId, "Draft ID"),
    draftSha256: sha256(input.publishProof.draftSha256, "Draft hash"),
    platform: input.publishProof.platform,
    accountId: required(input.publishProof.accountId, "Account ID"),
    externalPostId: required(input.publishProof.externalPostId, "External post ID"),
    mutation,
    reason,
    requestedBy: required(input.requestedBy, "Requester ID"),
    requestedAt: iso(input.requestedAt, "Requested at"),
    publishProofSha256: canonicalSha256({ schemaVersion: "originpost.publish-proof.v1", value: input.publishProof }),
  };
  const immutableIntentSha256 = canonicalSha256({ schemaVersion: "originpost.remote-correction-intent.v1", value: intentValue(base) });
  return Object.freeze({ ...base, immutableIntentSha256, status: "pending_approval" as const, createdAt: input.requestedAt, updatedAt: input.requestedAt });
}

export function approveRemoteCorrectionRequest(input: ApproveRemoteCorrectionInput): Readonly<RemoteCorrectionOperation> {
  const operation = input.operation;
  if (operation.status !== "pending_approval" || operation.approval) throw new DomainError("Only a pending request can be approved.", "remote_correction_transition_invalid", 409);
  if (input.approval.actorType !== "human") throw new DomainError("Remote correction requires human approval.", "remote_correction_human_approval_required", 409);
  if (operation.requestedBy === input.approval.actorId && input.approval.mode !== "single_owner_override") throw new DomainError("Remote correction requester and approver must be different people unless the sole owner records an override.", "remote_correction_separation_required", 409);
  const approvedAt = iso(input.approval.approvedAt, "Approved at");
  if (Date.parse(approvedAt) < Date.parse(operation.requestedAt)) throw new DomainError("Approval cannot predate the request.", "remote_correction_invalid", 400);
  const mode = input.approval.mode ?? "two_person";
  if (mode === "single_owner_override" && (!input.approval.secondConfirmedAt || Date.parse(iso(input.approval.secondConfirmedAt, "Second confirmation time")) < Date.parse(approvedAt))) throw new DomainError("Single-owner override requires a second confirmation at or after approval.", "remote_correction_second_confirmation_required", 409);
  const snapshot = input.beforeSnapshot;
  for (const value of [snapshot.providerOwnerId,snapshot.publishProofId,snapshot.contentItemId,snapshot.draftId,snapshot.accountId,snapshot.externalPostId,snapshot.providerVersion]) required(value,"Snapshot identity");
  if (snapshot.publishProofId!==operation.publishProofId||snapshot.contentItemId!==operation.contentItemId||snapshot.draftId!==operation.draftId||snapshot.accountId!==operation.accountId||snapshot.externalPostId!==operation.externalPostId||snapshot.platform!==operation.platform) throw new DomainError("Approval snapshot does not match publication lineage.","remote_correction_lineage_mismatch",409);
  const base = { ...operation, approval: { actorId: required(input.approval.actorId, "Approver ID"), actorType: "human" as const, approvedAt, mode, ...(input.approval.secondConfirmedAt ? { secondConfirmedAt: input.approval.secondConfirmedAt } : {}) }, beforeSnapshotSha256: sha256(snapshot.canonicalSha256, "Before snapshot hash"), beforeSnapshot: structuredClone(snapshot) };
  const { immutableIntentSha256: _hash, status: _status, statusReason: _reason, createdAt: _created, updatedAt: _updated, ...intent } = base;
  return Object.freeze({ ...base, immutableIntentSha256: canonicalSha256({ schemaVersion: "originpost.remote-correction-intent.v1", value: intentValue(intent) }), status: "approved" as const, updatedAt: approvedAt });
}

export function verifyRemoteCorrectionIntent(operation: RemoteCorrectionOperation): boolean {
  const { immutableIntentSha256, status: _status, statusReason: _statusReason, createdAt: _createdAt, updatedAt: _updatedAt, ...base } = operation;
  return canonicalSha256({ schemaVersion: "originpost.remote-correction-intent.v1", value: intentValue(base) }) === immutableIntentSha256;
}

export function advanceRemoteCorrectionOperation(
  operation: RemoteCorrectionOperation,
  next: "pre_write" | "finalizing" | "manual_action_required" | "uncertain" | "rejected" | "cancelled",
  at: string,
  statusReason?: string,
): Readonly<RemoteCorrectionOperation> {
  if (!verifyRemoteCorrectionIntent(operation)) throw new DomainError("Remote correction intent no longer matches its immutable hash.", "remote_correction_intent_mismatch", 409);
  const transition = transitions[next];
  if (!transition.from.includes(operation.status)) {
    throw new DomainError(`Remote correction cannot move from ${operation.status} to ${next}.`, "remote_correction_transition_invalid", 409);
  }
  const normalizedReason = statusReason === undefined ? undefined : required(statusReason, "Status reason");
  return Object.freeze({
    ...operation,
    status: transition.to,
    ...(normalizedReason ? { statusReason: normalizedReason } : { statusReason: undefined }),
    updatedAt: iso(at, "Transition time"),
  });
}

function removalProofValue(proof: Omit<RemovalProof, "canonicalSha256">): unknown {
  return proof;
}

export function operatorAttestationObservationSha256(input:{actorId:string;target:string;evidenceRef:string;noteSha256:string;occurredAt:string}):string{
  const value={actorId:required(input.actorId,"Attesting actor"),target:required(input.target,"Attested target"),evidenceRef:required(input.evidenceRef,"Attestation evidence"),noteSha256:sha256(input.noteSha256,"Attestation note hash"),occurredAt:iso(input.occurredAt,"Attestation occurrence time")};
  return canonicalSha256({schemaVersion:"originpost.operator-attestation.v1",...value});
}

export function createRemovalProof(input: CreateRemovalProofInput): Readonly<RemovalProof> {
  const operation = input.operation;
  if (!verifyRemoteCorrectionIntent(operation)) throw new DomainError("Remote correction intent no longer matches its immutable hash.", "remote_correction_intent_mismatch", 409);
  const allowed: RemoteCorrectionStatus[] = ["provider_confirmed", "reconciled", "operator_confirmed"];
  if (!allowed.includes(operation.status)) throw new DomainError("Removal proof requires a resolved remote correction operation.", "removal_proof_operation_unresolved", 409);
  const evidence = input.evidence;
  if ((operation as RemoteCorrectionOperation & { [resolutionEvidence]?: RemoteCorrectionEvidenceGrade })[resolutionEvidence] !== evidence.grade) throw new DomainError("Removal proof requires the matching evidence-carrying resolution command.", "removal_proof_resolution_evidence_required", 409);
  if (operation.status === "provider_confirmed" && evidence.grade !== "provider_confirmed") throw new DomainError("Provider-confirmed operations require provider-confirmed evidence.", "removal_proof_grade_mismatch", 409);
  if (operation.status === "reconciled" && evidence.grade !== "provider_reconciled") throw new DomainError("Reconciled operations require reconciled evidence.", "removal_proof_grade_mismatch", 409);
  if (operation.status === "operator_confirmed" && evidence.grade !== "operator_attested") throw new DomainError("Manual operations require operator-attested evidence.", "removal_proof_grade_mismatch", 409);
  if (evidence.grade === "operator_attested") {
    required(evidence.actorId, "Attesting actor"); required(evidence.evidenceRef, "Attestation evidence"); required(evidence.target, "Attested target"); sha256(evidence.noteSha256,"Attestation note hash");
    if(evidence.afterObservationSha256!==operatorAttestationObservationSha256(evidence))throw new DomainError("Operator attestation observation hash does not match its stored evidence.","removal_proof_operator_evidence_mismatch",409);
  }
  if (Date.parse(evidence.occurredAt) < Date.parse(operation.approval?.approvedAt ?? operation.requestedAt) || Date.parse(evidence.observedAt) < Date.parse(evidence.occurredAt) || Date.parse(input.createdAt) < Date.parse(evidence.observedAt)) throw new DomainError("Removal proof timestamps must follow request, approval, occurrence, observation, and creation order.", "removal_proof_time_invalid", 409);
  const base: Omit<RemovalProof, "canonicalSha256"> = {
    id: required(input.id, "Removal proof ID"),
    operationId: operation.id,
    workspaceId: operation.workspaceId,
    publishProofId: operation.publishProofId,
    contentItemId: operation.contentItemId,
    draftId: operation.draftId,
    draftSha256: operation.draftSha256,
    platform: operation.platform,
    accountId: operation.accountId,
    externalPostId: operation.externalPostId,
    mutation: operation.mutation,
    reason: operation.reason,
    requestedBy: operation.requestedBy,
    approvedBy: operation.approval?.actorId ?? (() => { throw new DomainError("Resolved correction requires approval.", "remote_correction_approval_required", 409); })(),
    immutableIntentSha256: operation.immutableIntentSha256,
    evidenceGrade: evidence.grade,
    beforeSnapshotSha256: sha256(operation.beforeSnapshotSha256 ?? "", "Before snapshot hash"),
    afterObservationSha256: sha256(evidence.afterObservationSha256, "After observation hash"),
    ...(evidence.grade === "provider_confirmed" ? { providerReceiptSha256: sha256(evidence.providerReceiptSha256, "Provider receipt hash") } : {}),
    previousProofSha256: sha256(input.previousProofSha256, "Previous proof hash"),
    occurredAt: iso(evidence.occurredAt, "Occurred at"),
    observedAt: iso(evidence.observedAt, "Observed at"),
    createdAt: iso(input.createdAt, "Created at"),
    ...(evidence.grade==="operator_attested"?{operatorAttestation:{actorId:evidence.actorId,target:evidence.target,evidenceRef:evidence.evidenceRef,noteSha256:evidence.noteSha256}}:{}),
  };
  return Object.freeze({ ...base, canonicalSha256: canonicalSha256({ schemaVersion: "originpost.removal-proof.v1", value: removalProofValue(base) }) });
}

export function resolveProviderConfirmed(operation: RemoteCorrectionOperation, evidence: Extract<CreateRemovalProofInput["evidence"], { grade: "provider_confirmed" }>, at: string): Readonly<RemoteCorrectionOperation> {
  if (operation.status !== "finalizing") throw new DomainError("Provider confirmation requires a finalizing operation.", "remote_correction_transition_invalid", 409);
  sha256(evidence.afterObservationSha256, "After observation hash"); sha256(evidence.providerReceiptSha256, "Provider receipt hash");
  return resolvedOperation({ ...operation, status: "provider_confirmed" as const, statusReason: undefined, updatedAt: iso(at, "Resolution time") }, evidence.grade);
}

export function resolveProviderReconciled(operation: RemoteCorrectionOperation, evidence: Extract<CreateRemovalProofInput["evidence"], { grade: "provider_reconciled" }>, at: string): Readonly<RemoteCorrectionOperation> {
  if (operation.status !== "finalizing" && operation.status !== "uncertain") throw new DomainError("Reconciliation requires a finalizing or uncertain operation.", "remote_correction_transition_invalid", 409);
  sha256(evidence.afterObservationSha256, "After observation hash");
  return resolvedOperation({ ...operation, status: "reconciled" as const, statusReason: undefined, updatedAt: iso(at, "Resolution time") }, evidence.grade);
}

export function resolveOperatorAttestation(operation: RemoteCorrectionOperation, evidence: Extract<CreateRemovalProofInput["evidence"], { grade: "operator_attested" }>, at: string): Readonly<RemoteCorrectionOperation> {
  if (operation.status !== "manual_action_required") throw new DomainError("Operator attestation requires a manual-action operation.", "remote_correction_transition_invalid", 409);
  required(evidence.actorId, "Attesting actor"); required(evidence.evidenceRef, "Attestation evidence"); required(evidence.target, "Attested target"); sha256(evidence.noteSha256,"Attestation note hash");
  if (evidence.target !== operation.externalPostId) throw new DomainError("Attestation target does not match the approved provider object.", "remote_correction_lineage_mismatch", 409);
  if(evidence.afterObservationSha256!==operatorAttestationObservationSha256(evidence))throw new DomainError("Operator attestation observation hash does not match its evidence.","removal_proof_operator_evidence_mismatch",409);
  return resolvedOperation({ ...operation, status: "operator_confirmed" as const, statusReason: undefined, updatedAt: iso(at, "Attestation time") }, evidence.grade);
}

function resolvedOperation(operation: RemoteCorrectionOperation, grade: RemoteCorrectionEvidenceGrade): Readonly<RemoteCorrectionOperation> {
  Object.defineProperty(operation, resolutionEvidence, { value: grade, enumerable: false, configurable: false, writable: false });
  return Object.freeze(operation);
}

export function verifyRemovalProof(proof: RemovalProof): boolean {
  try{
    if(proof.evidenceGrade==="operator_attested"){
      if(!proof.operatorAttestation||proof.afterObservationSha256!==operatorAttestationObservationSha256({...proof.operatorAttestation,occurredAt:proof.occurredAt}))return false;
    }else if(proof.operatorAttestation)return false;
    const { canonicalSha256: digest, ...base } = proof;
    return canonicalSha256({ schemaVersion: "originpost.removal-proof.v1", value: removalProofValue(base) }) === digest;
  }catch{return false;}
}

export function verifyRemovalProofChain(publishProof:PublishProof,proofs:readonly RemovalProof[]):boolean{
  const root=canonicalSha256({schemaVersion:"originpost.publish-proof.v1",value:publishProof});
  const byPrevious=new Map<string,RemovalProof>();
  for(const proof of proofs){
    if(!verifyRemovalProof(proof)||proof.publishProofId!==publishProof.id||proof.contentItemId!==publishProof.contentItemId||proof.draftId!==publishProof.draftId||proof.draftSha256!==publishProof.draftSha256||proof.platform!==publishProof.platform||proof.accountId!==publishProof.accountId||proof.externalPostId!==publishProof.externalPostId||byPrevious.has(proof.previousProofSha256))return false;
    byPrevious.set(proof.previousProofSha256,proof);
  }
  let head=root,visited=0; const seen=new Set<string>();
  while(byPrevious.has(head)){if(seen.has(head))return false;seen.add(head);const next=byPrevious.get(head)!;head=next.canonicalSha256;visited++;}
  return visited===proofs.length;
}
