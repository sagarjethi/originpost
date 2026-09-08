import { assertRemoteCorrectionResolutionClaim,createRemovalProof,resolveRemoteCorrectionEvidence,verifyRemoteCorrectionIntent, type AuditEvent, type CreateRemovalProofInput, type OutboxMessageInput, type RemoteCorrectionAttempt, type RemoteCorrectionOperation, type RemoteCorrectionRecord, type RemoteCorrectionRepository, type RemoteCorrectionStatus, type RemovalProof, type ResolveRemoteCorrectionInput } from "@originpost/domain";
import type { InMemoryOutboxRepository } from "@originpost/domain";

export class InMemoryRemoteCorrectionRepository implements RemoteCorrectionRepository {
  private readonly operations = new Map<string, RemoteCorrectionOperation>();
  private readonly attempts = new Map<string, RemoteCorrectionAttempt>();
  private readonly proofs = new Map<string, RemovalProof>();
  private readonly claims = new Map<string, { id: string; expiresAt: string }>();

  constructor(private readonly outbox: InMemoryOutboxRepository, private readonly clock:()=>Date=()=>new Date()) {}

  async create(operation: RemoteCorrectionOperation, _event: AuditEvent, outbox: OutboxMessageInput[] = []): Promise<boolean> {
    if ([...this.operations.values()].some((entry) => entry.workspaceId === operation.workspaceId && entry.immutableIntentSha256 === operation.immutableIntentSha256)) return false;
    this.operations.set(operation.id, structuredClone(operation));
    this.outbox.append(outbox);
    return true;
  }

  async get(workspaceId: string, operationId: string): Promise<RemoteCorrectionRecord | null> {
    const operation = this.operations.get(operationId);
    if (!operation || operation.workspaceId !== workspaceId) return null;
    return this.record(operation);
  }

  async list(workspaceId: string, filters: { contentItemId?: string; publishProofId?: string } = {}): Promise<RemoteCorrectionRecord[]> {
    return [...this.operations.values()]
      .filter((entry) => entry.workspaceId === workspaceId && (!filters.contentItemId || entry.contentItemId === filters.contentItemId) && (!filters.publishProofId || entry.publishProofId === filters.publishProofId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((entry) => this.record(entry));
  }

  async compareAndSet(operation: RemoteCorrectionOperation, expected: readonly RemoteCorrectionStatus[], _event: AuditEvent, outbox: OutboxMessageInput[] = [], claimId?: string): Promise<boolean> {
    const current = this.operations.get(operation.id);
    const claim=claimId?this.claims.get(operation.id):undefined;
    if (!current || current.workspaceId !== operation.workspaceId || !expected.includes(current.status) || (current.status !== "pending_approval" && current.immutableIntentSha256 !== operation.immutableIntentSha256) || (claimId && (!claim||claim.id!==claimId||Date.parse(claim.expiresAt)<=this.clock().getTime()))) return false;
    this.operations.set(operation.id, structuredClone(operation));
    this.outbox.append(outbox);
    if (!["pre_write", "finalizing", "uncertain"].includes(operation.status)) this.claims.delete(operation.id);
    return true;
  }

  async claim(workspaceId: string, operationId: string, claimId: string, kind: RemoteCorrectionAttempt["kind"], claimedAt: string, leaseExpiresAt: string): Promise<RemoteCorrectionOperation | null> {
    const operation = this.operations.get(operationId);
    const existing = this.claims.get(operationId);
    if (!operation || operation.workspaceId !== workspaceId || (existing && existing.expiresAt > claimedAt)) return null;
    if (kind === "execute" && operation.status !== "approved" && operation.status !== "pre_write") return null;
    if (kind === "reconcile" && operation.status !== "finalizing" && operation.status !== "uncertain") return null;
    this.claims.set(operationId, { id: claimId, expiresAt: leaseExpiresAt });
    return structuredClone(operation);
  }

  async saveAttempt(attempt: RemoteCorrectionAttempt): Promise<void> {
    const operation = this.operations.get(attempt.operationId);
    if (!operation || operation.workspaceId !== attempt.workspaceId) throw new Error("Remote correction attempt lineage does not exist.");
    this.attempts.set(attempt.id, structuredClone(attempt));
  }

  private async appendProof(input: Omit<CreateRemovalProofInput, "previousProofSha256">): Promise<RemovalProof | null> {
    if ([...this.proofs.values()].some((entry) => entry.operationId === input.operation.id)) return null;
    const prior = [...this.proofs.values()].filter((entry) => entry.workspaceId === input.operation.workspaceId && entry.accountId === input.operation.accountId && entry.externalPostId === input.operation.externalPostId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]?.canonicalSha256;
    const operation = this.operations.get(input.operation.id);
    if (!operation) throw new Error("Remote correction operation does not exist.");
    const proof = createRemovalProof({ ...input, previousProofSha256: prior ?? input.operation.publishProofSha256 });
    this.proofs.set(proof.id, structuredClone(proof));
    return structuredClone(proof);
  }

  async resolveWithProof(input:ResolveRemoteCorrectionInput,event:AuditEvent):Promise<{operation:RemoteCorrectionOperation;proof:RemovalProof}|null>{
    assertRemoteCorrectionResolutionClaim(input);
    const current=this.operations.get(input.operationId); if(!current||current.workspaceId!==input.workspaceId||!input.expected.includes(current.status)||!verifyRemoteCorrectionIntent(current))return null;
    if(input.evidence.grade!=="operator_attested"){const claim=this.claims.get(current.id);if(!claim||claim.id!==input.claimId||Date.parse(claim.expiresAt)<=this.clock().getTime())return null;}
    if(event.workspaceId!==current.workspaceId||event.contentItemId!==current.contentItemId)throw new Error("Remote correction audit lineage does not match the stored operation.");
    const operation=resolveRemoteCorrectionEvidence(current,input.evidence,input.resolvedAt);
    const proof = await this.appendProof({ id:input.proofId,evidence:input.evidence,createdAt:input.resolvedAt, operation });
    if (!proof) return null;
    this.operations.set(operation.id, structuredClone(operation)); this.claims.delete(operation.id);
    return {operation:structuredClone(operation),proof};
  }

  private record(operation: RemoteCorrectionOperation): RemoteCorrectionRecord {
    return {
      operation: structuredClone(operation),
      attempts: [...this.attempts.values()].filter((entry) => entry.operationId === operation.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((entry) => structuredClone(entry)),
      proofs: [...this.proofs.values()].filter((entry) => entry.operationId === operation.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((entry) => structuredClone(entry)),
    };
  }
}
