import {
  createFirstCommentProof,
  transitionFirstComment,
  type AuditEvent,
  type FirstCommentEvidence,
  type FirstCommentIntent,
  type FirstCommentProof,
  type FirstCommentRecord,
  type FirstCommentRepository,
  type FirstCommentStatus,
  type PublishProof,
} from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type IntentRow = { payload: FirstCommentIntent };
type ProofRow = { payload: FirstCommentProof };
type LockedIntentRow = {
  payload: FirstCommentIntent;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  now: Date;
};

async function audit(sql: Sql | TransactionSql, event: AuditEvent) {
  await sql`insert into audit_events (id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at)
    values (${event.id},${event.workspaceId},${event.contentItemId ?? null},${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt})
    on conflict(id) do nothing`;
}

export class PostgresFirstCommentRepository implements FirstCommentRepository {
  constructor(private readonly sql: Sql) {}

  async create(intent: FirstCommentIntent, event: AuditEvent) {
    return this.sql.begin(async (sql) => {
      const rows = await sql<{ id: string }[]>`insert into first_comment_intents(
        id,workspace_id,brand_id,content_item_id,target_id,draft_id,draft_sha256,platform,account_id,
        body_sha256,immutable_intent_sha256,status,execution_mode,version,requested_by,approved_by,
        publish_proof_id,external_post_id,provider_comment_id,provider_accepted_at,provider_response_sha256,
        claim_owner,claim_expires_at,payload,created_at,updated_at
      ) values (
        ${intent.id},${intent.workspaceId},${intent.brandId},${intent.contentItemId},${intent.targetId},${intent.draftId},${intent.draftSha256},${intent.platform},${intent.accountId},
        ${intent.bodySha256},${intent.immutableIntentSha256},${intent.status},${intent.executionMode},${intent.version},${intent.requestedBy},${intent.approval?.actorId ?? null},
        ${intent.publishProofId ?? null},${intent.externalPostId ?? null},${intent.providerCommentId ?? null},${intent.providerAcceptedAt ?? null},${intent.providerResponseSha256 ?? null},
        null,null,${sql.json(intent as never)},${intent.createdAt},${intent.updatedAt}
      ) on conflict do nothing returning id`;
      if (!rows.length) return false;
      await audit(sql, event);
      return true;
    });
  }

  async get(workspaceId: string, intentId: string) {
    const rows = await this.sql<IntentRow[]>`select payload from first_comment_intents where workspace_id=${workspaceId} and id=${intentId} limit 1`;
    return rows[0] ? this.record(rows[0].payload) : null;
  }

  async list(workspaceId: string, contentItemId: string) {
    const rows = await this.sql<IntentRow[]>`select payload from first_comment_intents where workspace_id=${workspaceId} and content_item_id=${contentItemId} order by created_at desc,id`;
    return Promise.all(rows.map((row) => this.record(row.payload)));
  }

  async compareAndSet(intent: FirstCommentIntent, expectedVersion: number, expectedStatuses: FirstCommentStatus[], event: AuditEvent) {
    return this.sql.begin(async (sql) => {
      const rows = await sql<{ id: string }[]>`update first_comment_intents set
        status=${intent.status},execution_mode=${intent.executionMode},version=${intent.version},body_sha256=${intent.bodySha256},
        immutable_intent_sha256=${intent.immutableIntentSha256},approved_by=${intent.approval?.actorId ?? null},
        publish_proof_id=${intent.publishProofId ?? null},external_post_id=${intent.externalPostId ?? null},
        provider_comment_id=${intent.providerCommentId ?? null},provider_accepted_at=${intent.providerAcceptedAt ?? null},
        provider_response_sha256=${intent.providerResponseSha256 ?? null},claim_owner=null,claim_expires_at=null,
        payload=${sql.json(intent as never)},updated_at=${intent.updatedAt}
        where workspace_id=${intent.workspaceId} and id=${intent.id} and version=${expectedVersion}
          and status=any(${expectedStatuses as string[]}) returning id`;
      if (!rows.length) return false;
      await audit(sql, event);
      return true;
    });
  }

  async claimForExecution(workspaceId: string, intentId: string, owner: string, leaseSeconds: number, event: AuditEvent) {
    return this.sql.begin(async (sql) => {
      const locked = await sql<LockedIntentRow[]>`select payload,claim_owner,claim_expires_at,clock_timestamp() as now
        from first_comment_intents where workspace_id=${workspaceId} and id=${intentId} and status='queued' for update`;
      if (!locked[0]) return null;
      const current = locked[0].payload;
      const proofRows = await sql<{ payload: PublishProof }[]>`select payload from publish_proofs
        where workspace_id=${workspaceId} and id=${current.publishProofId ?? ""} and content_item_id=${current.contentItemId}
          and account_id=${current.accountId} and platform=${current.platform} and external_post_id=${current.externalPostId ?? ""}
        limit 1 for share`;
      const proof = proofRows[0]?.payload;
      if (!proof || proof.draftId !== current.draftId || proof.draftSha256 !== current.draftSha256) return null;
      const at = locked[0].now;
      const claimExpiresAt = new Date(at.getTime() + Math.max(30, Math.min(900, leaseSeconds)) * 1_000).toISOString();
      const processing: FirstCommentIntent = {
        ...current,
        status: "processing",
        version: current.version + 1,
        claimOwner: owner,
        claimExpiresAt,
        updatedAt: at.toISOString(),
      };
      const changed = await sql<{ id: string }[]>`update first_comment_intents set
        status='processing',version=${processing.version},claim_owner=${owner},claim_expires_at=${claimExpiresAt},
        payload=${sql.json(processing as never)},updated_at=${processing.updatedAt}
        where workspace_id=${workspaceId} and id=${intentId} and version=${current.version} and status='queued' returning id`;
      if (!changed.length) return null;
      await audit(sql, event);
      return { intent: processing, publishProof: proof };
    });
  }

  async checkpointProviderEvidence(workspaceId: string, intentId: string, owner: string, evidence: { providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string }, at: string) {
    return this.sql.begin(async (sql) => {
      const locked = await sql<LockedIntentRow[]>`select payload,claim_owner,claim_expires_at,clock_timestamp() as now
        from first_comment_intents where workspace_id=${workspaceId} and id=${intentId} and status='processing' for update`;
      const row = locked[0];
      if (!row || row.claim_owner !== owner || !row.claim_expires_at || row.claim_expires_at.getTime() <= row.now.getTime()) return false;
      const next: FirstCommentIntent = { ...row.payload, ...evidence, version: row.payload.version + 1, updatedAt: at };
      const changed = await sql<{ id: string }[]>`update first_comment_intents set
        provider_comment_id=${evidence.providerCommentId},provider_accepted_at=${evidence.providerAcceptedAt},
        provider_response_sha256=${evidence.providerResponseSha256},version=${next.version},payload=${sql.json(next as never)},updated_at=${at}
        where workspace_id=${workspaceId} and id=${intentId} and status='processing' and claim_owner=${owner}
          and claim_expires_at>clock_timestamp() returning id`;
      return changed.length === 1;
    });
  }

  async finishExecution(workspaceId: string, intentId: string, owner: string, status: "failed" | "uncertain", error: string, event: AuditEvent) {
    return this.sql.begin(async (sql) => {
      const locked = await sql<LockedIntentRow[]>`select payload,claim_owner,claim_expires_at,clock_timestamp() as now
        from first_comment_intents where workspace_id=${workspaceId} and id=${intentId} and status='processing' for update`;
      const row = locked[0];
      if (!row || row.claim_owner !== owner || !row.claim_expires_at || row.claim_expires_at.getTime() <= row.now.getTime()) return null;
      const next = transitionFirstComment(row.payload, status, row.now.toISOString(), error);
      const changed = await sql<{ id: string }[]>`update first_comment_intents set
        status=${next.status},version=${next.version},claim_owner=null,claim_expires_at=null,payload=${sql.json(next as never)},updated_at=${next.updatedAt}
        where workspace_id=${workspaceId} and id=${intentId} and status='processing' and claim_owner=${owner}
          and claim_expires_at>clock_timestamp() returning id`;
      if (!changed.length) return null;
      await audit(sql, event);
      return next;
    });
  }

  async resolveWithProof(input: { workspaceId: string; intentId: string; owner?: string; evidence: FirstCommentEvidence; proofId: string; resolvedAt: string }, event: AuditEvent) {
    return this.sql.begin(async (sql) => {
      const rows = await sql<LockedIntentRow[]>`select payload,claim_owner,claim_expires_at,clock_timestamp() as now
        from first_comment_intents where workspace_id=${input.workspaceId} and id=${input.intentId} for update`;
      const row = rows[0];
      if (!row) return null;
      const current = row.payload;
      const operator = input.evidence.grade === "operator_attested";
      const providerEvidence = input.evidence.grade === "operator_attested" ? null : input.evidence;
      if (operator ? current.status !== "uncertain" : current.status !== "processing") return null;
      if (!operator && (!input.owner || row.claim_owner !== input.owner || !row.claim_expires_at || row.claim_expires_at.getTime() <= row.now.getTime())) return null;
      const lineage = await sql<{ payload: PublishProof }[]>`select payload from publish_proofs
        where workspace_id=${current.workspaceId} and id=${current.publishProofId ?? ""} and content_item_id=${current.contentItemId}
          and account_id=${current.accountId} and platform=${current.platform} and external_post_id=${current.externalPostId ?? ""}
        limit 1 for share`;
      if (!lineage[0] || lineage[0].payload.draftId !== current.draftId || lineage[0].payload.draftSha256 !== current.draftSha256) return null;
      const proof = createFirstCommentProof(current, input.evidence, input.proofId, input.resolvedAt);
      const succeeded: FirstCommentIntent = {
        ...current,
        status: "succeeded",
        version: current.version + 1,
        providerCommentId: providerEvidence?.providerCommentId ?? current.providerCommentId,
        providerAcceptedAt: providerEvidence?.providerAcceptedAt ?? current.providerAcceptedAt,
        providerResponseSha256: providerEvidence?.providerResponseSha256 ?? current.providerResponseSha256,
        claimOwner: undefined,
        claimExpiresAt: undefined,
        updatedAt: input.resolvedAt,
      };
      const updated = operator
        ? await sql<{ id: string }[]>`update first_comment_intents set status='succeeded',version=${succeeded.version},claim_owner=null,claim_expires_at=null,payload=${sql.json(succeeded as never)},updated_at=${input.resolvedAt}
            where workspace_id=${current.workspaceId} and id=${current.id} and status='uncertain' returning id`
        : await sql<{ id: string }[]>`update first_comment_intents set status='succeeded',version=${succeeded.version},provider_comment_id=${providerEvidence!.providerCommentId},provider_accepted_at=${providerEvidence!.providerAcceptedAt},provider_response_sha256=${providerEvidence!.providerResponseSha256},claim_owner=null,claim_expires_at=null,payload=${sql.json(succeeded as never)},updated_at=${input.resolvedAt}
            where workspace_id=${current.workspaceId} and id=${current.id} and status='processing' and claim_owner=${input.owner!} and claim_expires_at>clock_timestamp() returning id`;
      if (!updated.length) return null;
      await sql`insert into first_comment_proofs(id,workspace_id,brand_id,content_item_id,intent_id,publish_proof_id,target_id,account_id,external_post_id,body_sha256,evidence_grade,canonical_sha256,payload,created_at)
        values(${proof.id},${proof.workspaceId},${proof.brandId},${proof.contentItemId},${proof.intentId},${proof.publishProofId},${proof.targetId},${proof.accountId},${proof.externalPostId},${proof.bodySha256},${proof.evidence.grade},${proof.canonicalSha256},${sql.json(proof as never)},${proof.createdAt})`;
      await audit(sql, event);
      return { intent: succeeded, proof };
    });
  }

  async recoverExpiredProcessing(limit = 100) {
    return this.sql.begin(async (sql) => {
      const locked = await sql<{ payload: FirstCommentIntent; now: Date }[]>`select payload,clock_timestamp() as now from first_comment_intents
        where status='processing' and claim_expires_at<=clock_timestamp() order by claim_expires_at,id
        limit ${Math.max(1, Math.min(500, limit))} for update skip locked`;
      const recovered: FirstCommentIntent[] = [];
      for (const row of locked) {
        const next = transitionFirstComment(row.payload, "uncertain", row.now.toISOString(), "The execution lease expired; reconcile before another provider write.");
        await sql`update first_comment_intents set status='uncertain',version=${next.version},claim_owner=null,claim_expires_at=null,payload=${sql.json(next as never)},updated_at=${next.updatedAt}
          where workspace_id=${next.workspaceId} and id=${next.id}`;
        recovered.push(next);
      }
      return recovered;
    });
  }

  async listForRecovery(limit = 100) {
    const rows = await this.sql<IntentRow[]>`select payload from first_comment_intents
      where status in ('approved','queued','uncertain') order by updated_at,id limit ${Math.max(1, Math.min(500, limit))}`;
    return rows.map((row) => row.payload);
  }

  private async record(intent: FirstCommentIntent): Promise<FirstCommentRecord> {
    const proofs = await this.sql<ProofRow[]>`select payload from first_comment_proofs where workspace_id=${intent.workspaceId} and intent_id=${intent.id} order by created_at,id`;
    return { intent, proofs: proofs.map((row) => row.payload) };
  }
}
