import { assertRemoteCorrectionResolutionClaim,canonicalSha256,createRemovalProof,resolveRemoteCorrectionEvidence,verifyRemoteCorrectionIntent, type AuditEvent, type OutboxMessageInput, type PublishProof, type RemoteCorrectionAttempt, type RemoteCorrectionOperation, type RemoteCorrectionRecord, type RemoteCorrectionRepository, type RemoteCorrectionStatus, type RemovalProof, type ResolveRemoteCorrectionInput } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type OperationRow = { payload: RemoteCorrectionOperation };
type AttemptRow = { id: string; workspace_id: string; operation_id: string; kind: RemoteCorrectionAttempt["kind"]; status: RemoteCorrectionAttempt["status"]; request_sha256: string; response_sha256: string | null; error_code: string | null; error_summary: string | null; started_at: Date; completed_at: Date | null };
type ProofRow = { payload: RemovalProof };

function attempt(row: AttemptRow): RemoteCorrectionAttempt {
  return { id: row.id, workspaceId: row.workspace_id, operationId: row.operation_id, kind: row.kind, status: row.status, requestSha256: row.request_sha256, ...(row.response_sha256 ? { responseSha256: row.response_sha256 } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.error_summary ? { errorSummary: row.error_summary } : {}), startedAt: row.started_at.toISOString(), ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}) };
}

async function audit(sql: Sql | TransactionSql, event: AuditEvent) {
  await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at) values (${event.id}, ${event.workspaceId}, ${event.contentItemId ?? null}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt}) on conflict (id) do nothing`;
}

export class PostgresRemoteCorrectionRepository implements RemoteCorrectionRepository {
  constructor(private readonly sql: Sql) {}

  async create(operation: RemoteCorrectionOperation, event: AuditEvent, outbox: OutboxMessageInput[] = []): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<{ id: string }[]>`insert into remote_correction_operations (id,workspace_id,brand_id,content_item_id,publish_proof_id,account_id,platform,external_post_id,immutable_intent_sha256,status,requested_by,approved_by,payload,created_at,updated_at) values (${operation.id},${operation.workspaceId},${operation.brandId},${operation.contentItemId},${operation.publishProofId},${operation.accountId},${operation.platform},${operation.externalPostId},${operation.immutableIntentSha256},${operation.status},${operation.requestedBy},${operation.approval?.actorId ?? null},${sql.json(operation as never)},${operation.createdAt},${operation.updatedAt}) on conflict (workspace_id,immutable_intent_sha256) do nothing returning id`;
      if (!rows.length) return false;
      await audit(sql, event);
      for (const message of outbox) await sql`insert into outbox_events (id,workspace_id,topic,dedupe_key,payload,available_at,created_at) values (${message.id},${message.workspaceId},${message.topic},${message.dedupeKey},${sql.json(message.payload as never)},${message.availableAt},${message.createdAt}) on conflict (workspace_id,dedupe_key) do nothing`;
      return true;
    });
  }

  async get(workspaceId: string, operationId: string): Promise<RemoteCorrectionRecord | null> {
    const rows = await this.sql<OperationRow[]>`select payload from remote_correction_operations where workspace_id=${workspaceId} and id=${operationId} limit 1`;
    return rows[0] ? this.record(rows[0].payload) : null;
  }

  async list(workspaceId: string, filters: { contentItemId?: string; publishProofId?: string } = {}): Promise<RemoteCorrectionRecord[]> {
    const rows = await this.sql<OperationRow[]>`select payload from remote_correction_operations where workspace_id=${workspaceId} and (${filters.contentItemId ?? null}::text is null or content_item_id=${filters.contentItemId ?? null}) and (${filters.publishProofId ?? null}::text is null or publish_proof_id=${filters.publishProofId ?? null}) order by created_at desc`;
    return Promise.all(rows.map((row) => this.record(row.payload)));
  }

  async compareAndSet(operation: RemoteCorrectionOperation, expected: readonly RemoteCorrectionStatus[], event: AuditEvent, outbox: OutboxMessageInput[] = [], claimId?: string): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<{ id: string }[]>`update remote_correction_operations set status=${operation.status}, approved_by=${operation.approval?.actorId ?? null}, immutable_intent_sha256=${operation.immutableIntentSha256}, payload=${sql.json(operation as never)}, updated_at=${operation.updatedAt}, active_claim_id=case when ${operation.status} in ('pre_write','finalizing','uncertain') then active_claim_id else null end, claim_lease_expires_at=case when ${operation.status} in ('pre_write','finalizing','uncertain') then claim_lease_expires_at else null end where id=${operation.id} and workspace_id=${operation.workspaceId} and status = any(${expected as string[]}) and (${claimId ?? null}::text is null or (active_claim_id=${claimId ?? null} and claim_lease_expires_at > clock_timestamp())) returning id`;
      if (!rows.length) return false;
      await audit(sql, event);
      for (const message of outbox) await sql`insert into outbox_events (id,workspace_id,topic,dedupe_key,payload,available_at,created_at) values (${message.id},${message.workspaceId},${message.topic},${message.dedupeKey},${sql.json(message.payload as never)},${message.availableAt},${message.createdAt}) on conflict (workspace_id,dedupe_key) do nothing`;
      return true;
    });
  }

  async claim(workspaceId: string, operationId: string, claimId: string, kind: RemoteCorrectionAttempt["kind"], claimedAt: string, leaseExpiresAt: string): Promise<RemoteCorrectionOperation | null> {
    const statuses = kind === "execute" ? ["approved", "pre_write"] : ["finalizing", "uncertain"];
    const rows = await this.sql<OperationRow[]>`update remote_correction_operations set active_claim_id=${claimId},claim_lease_expires_at=${leaseExpiresAt},updated_at=${claimedAt} where workspace_id=${workspaceId} and id=${operationId} and status = any(${statuses}) and (active_claim_id is null or claim_lease_expires_at < ${claimedAt}) returning payload`;
    return rows[0]?.payload ?? null;
  }

  async saveAttempt(value: RemoteCorrectionAttempt): Promise<void> {
    await this.sql`insert into remote_correction_attempts (id,workspace_id,operation_id,kind,status,request_sha256,response_sha256,error_code,error_summary,started_at,completed_at) values (${value.id},${value.workspaceId},${value.operationId},${value.kind},${value.status},${value.requestSha256},${value.responseSha256 ?? null},${value.errorCode ?? null},${value.errorSummary?.slice(0,500) ?? null},${value.startedAt},${value.completedAt ?? null}) on conflict (id) do update set status=excluded.status,response_sha256=excluded.response_sha256,error_code=excluded.error_code,error_summary=excluded.error_summary,completed_at=excluded.completed_at where remote_correction_attempts.workspace_id=excluded.workspace_id and remote_correction_attempts.operation_id=excluded.operation_id`;
  }

  async resolveWithProof(input:ResolveRemoteCorrectionInput,event:AuditEvent):Promise<{operation:RemoteCorrectionOperation;proof:RemovalProof}|null>{
    assertRemoteCorrectionResolutionClaim(input);
    return this.sql.begin(async (sql) => {
      const locked = await sql<{ payload: RemoteCorrectionOperation;active_claim_id:string|null }[]>`select payload,active_claim_id from remote_correction_operations where workspace_id=${input.workspaceId} and id=${input.operationId} and status = any(${input.expected as string[]}) for update`;
      if (!locked.length) return null;
      const current=locked[0]!.payload;
      if(!verifyRemoteCorrectionIntent(current))return null;
      if(input.evidence.grade!=="operator_attested"&&locked[0]!.active_claim_id!==input.claimId)return null;
      if(event.workspaceId!==current.workspaceId||event.contentItemId!==current.contentItemId)throw new Error("Remote correction audit lineage does not match the locked operation.");
      const lineage=await sql<{proof:PublishProof}[]>`select p.payload as proof from publish_proofs p join content_items c on c.id=p.content_item_id and c.workspace_id=p.workspace_id join connected_accounts a on a.id=p.account_id and a.workspace_id=p.workspace_id and a.brand_id=c.brand_id where p.id=${current.publishProofId} and p.workspace_id=${current.workspaceId} and p.content_item_id=${current.contentItemId} and p.account_id=${current.accountId} and p.platform=${current.platform} and p.external_post_id=${current.externalPostId} and c.brand_id=${current.brandId} limit 1 for share of p,c,a`;
      if(!lineage[0]||canonicalSha256({schemaVersion:"originpost.publish-proof.v1",value:lineage[0].proof})!==current.publishProofSha256)throw new Error("The locked correction no longer matches its canonical publication proof and account lineage.");
      const operation=resolveRemoteCorrectionEvidence(current,input.evidence,input.resolvedAt);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${current.workspaceId}:${current.accountId}:${current.externalPostId}`},0))`;
      const prior = await sql<{ digest:string|null }[]>`select coalesce((select canonical_sha256 from removal_proofs where workspace_id=${current.workspaceId} and account_id=${current.accountId} and external_post_id=${current.externalPostId} order by created_at desc,id desc limit 1),${current.publishProofSha256}) as digest`;
      if (!prior[0]?.digest) throw new Error("The publication proof chain root is missing.");
      const proof = createRemovalProof({ id:input.proofId,evidence:input.evidence,createdAt:input.resolvedAt, operation, previousProofSha256: prior[0].digest });
      let resolved:{id:string}[];
      if(input.evidence.grade==="operator_attested")resolved=await sql<{id:string}[]>`update remote_correction_operations set status=${operation.status},payload=${sql.json(operation as never)},updated_at=${operation.updatedAt},active_claim_id=null,claim_lease_expires_at=null where workspace_id=${operation.workspaceId} and id=${operation.id} returning id`;
      else{const claimId=input.claimId;if(!claimId)return null;resolved=await sql<{id:string}[]>`update remote_correction_operations set status=${operation.status},payload=${sql.json(operation as never)},updated_at=${operation.updatedAt},active_claim_id=null,claim_lease_expires_at=null where workspace_id=${operation.workspaceId} and id=${operation.id} and active_claim_id=${claimId} and claim_lease_expires_at > clock_timestamp() returning id`;}
      if(!resolved.length)return null;
      await sql`insert into removal_proofs (id,workspace_id,operation_id,content_item_id,publish_proof_id,account_id,external_post_id,evidence_grade,previous_proof_sha256,canonical_sha256,payload,created_at) values (${proof.id},${proof.workspaceId},${proof.operationId},${proof.contentItemId},${proof.publishProofId},${proof.accountId},${proof.externalPostId},${proof.evidenceGrade},${proof.previousProofSha256},${proof.canonicalSha256},${sql.json(proof as never)},${proof.createdAt})`;
      await audit(sql,event);
      return {operation,proof};
    });
  }

  private async record(operation: RemoteCorrectionOperation): Promise<RemoteCorrectionRecord> {
    const attempts = await this.sql<AttemptRow[]>`select * from remote_correction_attempts where workspace_id=${operation.workspaceId} and operation_id=${operation.id} order by started_at,id`;
    const proofs = await this.sql<ProofRow[]>`select payload from removal_proofs where workspace_id=${operation.workspaceId} and operation_id=${operation.id} order by created_at,id`;
    return { operation, attempts: attempts.map(attempt), proofs: proofs.map((row) => row.payload) };
  }
}
