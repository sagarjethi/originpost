import { assertRemoteCorrectionMutation, canonicalSha256, DomainError, verifyRemoteCorrectionIntent } from "@originpost/domain";
import type { Platform, RemoteCorrectionAction, RemoteCorrectionLineage, RemoteCorrectionMutation, RemoteCorrectionOperation, RemoteCorrectionSnapshotEvidence } from "@originpost/domain";
import type { ConnectorManifest } from "./types.js";

export type RemoteCorrectionCapabilityState = "supported" | "unsupported" | "scope_required" | "contract_probe_required" | "manual_only";
export type RemoteCorrectionProviderErrorCategory = "authentication" | "permission" | "not_found" | "rate_limited" | "policy_restricted" | "unsupported" | "invalid_request" | "transient" | "uncertain";
export type RemoteContentState = "live" | "public" | "private" | "unlisted" | "hidden" | "not_found" | "unknown";
export type RemoteProviderObjectKind = "post" | "reel" | "story" | "carousel_container" | "video" | "unknown";

export interface RemoteCorrectionTarget extends RemoteCorrectionLineage {
  workspaceId: string;
  brandId: string;
  mutation: RemoteCorrectionMutation;
}

export interface RemoteCorrectionCapabilityRequest {
  workspaceId: string;
  accountId: string;
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
}

export interface RemoteCorrectionCapabilitySet {
  platform: Extract<Platform, "instagram" | "facebook" | "youtube">;
  providerVersion: string;
  resolvedAt: string;
  actions: Record<RemoteCorrectionAction, { state: RemoteCorrectionCapabilityState; reason?: string | undefined }>;
}

export interface RemoteContentSnapshot extends RemoteCorrectionSnapshotEvidence {
  providerOwnerId: string;
  state: RemoteContentState;
  objectKind: RemoteProviderObjectKind;
  mutableState: Record<string, unknown>;
  observedAt: string;
  providerVersion: string;
  canonicalSha256: string;
}

export interface ExecuteRemoteCorrectionRequest {
  operation: RemoteCorrectionOperation;
  before: RemoteContentSnapshot;
}

export interface ReconcileRemoteCorrectionRequest {
  operation: RemoteCorrectionOperation;
}

export interface SanitizedProviderReceipt {
  provider: "instagram" | "facebook" | "youtube";
  action: RemoteCorrectionAction;
  externalPostId: string;
  occurredAt: string;
  responseSha256: string;
}

export type RemoteCorrectionOutcome =
  | { kind: "provider_confirmed"; receipt: SanitizedProviderReceipt; after: RemoteContentSnapshot }
  | { kind: "uncertain"; reason: string }
  | { kind: "manual_action_required"; reason: string; handoff: "business_manager" | "instagram_native" | "youtube_studio" }
  | { kind: "rejected"; category: RemoteCorrectionProviderErrorCategory; reason: string };

export interface RemoteContentObservation {
  snapshot: RemoteContentSnapshot;
  result: "matches_desired" | "does_not_match" | "absence_consistent_with_removal" | "unknown";
}

export class ProviderRemoteCorrectionError extends Error {
  readonly retrySafety = "reconcile_first" as const;

  constructor(
    message: string,
    public readonly code: RemoteCorrectionProviderErrorCategory,
    public readonly detail: { providerCode?: number; providerSubcode?: number; traceId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ProviderRemoteCorrectionError";
  }
}

export interface RemoteCorrectionConnector {
  readonly manifest: ConnectorManifest;
  correctionCapabilities(request: RemoteCorrectionCapabilityRequest): Promise<RemoteCorrectionCapabilitySet>;
  preflightCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot>;
  /** Identity/lineage read for a manual handoff. This must not require mutation scopes or perform a provider write. */
  preflightManualCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot>;
  executeCorrection(request: ExecuteRemoteCorrectionRequest): Promise<RemoteCorrectionOutcome>;
  reconcileCorrection(request: ReconcileRemoteCorrectionRequest): Promise<RemoteContentObservation>;
}

export function remoteSnapshot(input: Omit<RemoteContentSnapshot, "canonicalSha256">): RemoteContentSnapshot {
  const { canonicalSha256: _callerDigest, ...value } = input as Omit<RemoteContentSnapshot, "canonicalSha256"> & { canonicalSha256?: unknown };
  for (const [field, identity] of Object.entries({ publishProofId: value.publishProofId, contentItemId: value.contentItemId, draftId: value.draftId, accountId: value.accountId, externalPostId: value.externalPostId, providerOwnerId: value.providerOwnerId, providerVersion: value.providerVersion })) {
    if (typeof identity !== "string" || !identity.trim()) throw new DomainError(`${field} is required in a remote provider snapshot.`, "remote_snapshot_invalid", 502);
  }
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new DomainError("Remote snapshot observation time is invalid.", "remote_snapshot_invalid", 502);
  return Object.freeze({ ...value, canonicalSha256: canonicalSha256({ schemaVersion: "originpost.remote-snapshot.v1", value }) });
}

export function verifyRemoteSnapshot(snapshot: RemoteContentSnapshot): boolean {
  const { canonicalSha256: digest, ...value } = snapshot;
  return canonicalSha256({ schemaVersion: "originpost.remote-snapshot.v1", value }) === digest;
}

export function correctionLineage(input: RemoteCorrectionLineage): RemoteCorrectionLineage {
  return {
    publishProofId: input.publishProofId,
    contentItemId: input.contentItemId,
    draftId: input.draftId,
    draftSha256: input.draftSha256,
    platform: input.platform,
    accountId: input.accountId,
    externalPostId: input.externalPostId,
  };
}

export function assertCorrectionExecution(request: ExecuteRemoteCorrectionRequest, platform: Platform): void {
  const { operation, before } = request;
  if (operation.platform !== platform || before.platform !== platform) throw new ProviderRemoteCorrectionError("Remote correction platform does not match this connector.", "invalid_request");
  if (operation.status !== "finalizing") throw new ProviderRemoteCorrectionError("Remote correction must be durably marked finalizing before a provider write.", "invalid_request");
  if (!operation.approval || !operation.beforeSnapshotSha256) throw new ProviderRemoteCorrectionError("Remote correction requires an exact human approval and preflight snapshot.", "invalid_request");
  assertRemoteCorrectionMutation(operation.mutation);
  if (!verifyRemoteCorrectionIntent(operation)) throw new ProviderRemoteCorrectionError("Remote correction intent hash does not match its immutable fields.", "invalid_request");
  if (!verifyRemoteSnapshot(before)) throw new ProviderRemoteCorrectionError("Remote correction preflight snapshot no longer matches its canonical hash.", "invalid_request");
  if (operation.beforeSnapshotSha256 !== before.canonicalSha256) throw new ProviderRemoteCorrectionError("Remote correction preflight snapshot changed before execution.", "invalid_request");
  if (canonicalSha256(correctionLineage(operation)) !== canonicalSha256(correctionLineage(before))) throw new ProviderRemoteCorrectionError("Remote correction does not match the approved publication lineage.", "invalid_request");
}

export function correctionResult(operation: RemoteCorrectionOperation, snapshot: RemoteContentSnapshot): RemoteContentObservation["result"] {
  switch (operation.mutation.action) {
    case "delete_remote": return snapshot.state === "not_found" ? "absence_consistent_with_removal" : "does_not_match";
    case "make_private": return snapshot.state === "private" ? "matches_desired" : "does_not_match";
    case "restore_visibility": return snapshot.state === operation.mutation.visibility ? "matches_desired" : "does_not_match";
    case "manual_remove": return "unknown";
    case "edit_text": return snapshot.mutableState.text === operation.mutation.text ? "matches_desired" : "does_not_match";
    default: throw new ProviderRemoteCorrectionError("Remote correction action is not supported.", "invalid_request");
  }
}

export function assertRemoteCorrectionOutcome(operation: RemoteCorrectionOperation, outcome: RemoteCorrectionOutcome): RemoteCorrectionOutcome {
  if (outcome.kind === "provider_confirmed") {
    const before=operation.beforeSnapshot;
    if(!before||!verifyRemoteSnapshot(outcome.after))throw new ProviderRemoteCorrectionError("Provider confirmation is missing canonical before/after evidence.","uncertain");
    if(canonicalSha256(correctionLineage(outcome.after))!==canonicalSha256(correctionLineage(operation))||outcome.after.providerOwnerId!==before.providerOwnerId)throw new ProviderRemoteCorrectionError("Provider confirmation does not match the approved publication owner and lineage.","uncertain");
    const result=correctionResult(operation,outcome.after);
    if(result!=="matches_desired"&&result!=="absence_consistent_with_removal")throw new ProviderRemoteCorrectionError("Provider confirmation did not prove the approved correction result.","uncertain");
    const receipt=outcome.receipt;
    if(receipt.provider!==operation.platform||receipt.action!==operation.mutation.action||receipt.externalPostId!==operation.externalPostId||!/^[a-f0-9]{64}$/.test(receipt.responseSha256)||!Number.isFinite(Date.parse(receipt.occurredAt)))throw new ProviderRemoteCorrectionError("Provider receipt does not match the approved provider, action, and object.","uncertain");
  } else if(!outcome.reason.trim()||outcome.reason.length>2_000) throw new ProviderRemoteCorrectionError("Provider outcome reason is invalid.","uncertain");
  return outcome;
}

export function assertRemoteCorrectionObservation(operation:RemoteCorrectionOperation,observation:RemoteContentObservation):RemoteContentObservation{
  const before=operation.beforeSnapshot;
  if(!before||!verifyRemoteSnapshot(observation.snapshot)||canonicalSha256(correctionLineage(observation.snapshot))!==canonicalSha256(correctionLineage(operation))||observation.snapshot.providerOwnerId!==before.providerOwnerId)throw new ProviderRemoteCorrectionError("Provider reconciliation does not match the approved publication owner and lineage.","uncertain");
  const computed=correctionResult(operation,observation.snapshot);
  if(observation.result!==computed)throw new ProviderRemoteCorrectionError("Provider reconciliation result does not match its canonical snapshot.","uncertain");
  return observation;
}
