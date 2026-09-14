import { DomainError, imageGenerationHash, type AuditEvent, type CompleteImageGenerationInput, type FailImageGenerationInput, type ImageGenerationRecord, type ImageGenerationRepository } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type GenerationRow = { payload: ImageGenerationRecord };

async function audit(sql: Sql | TransactionSql, event: AuditEvent) {
  await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${event.workspaceId},${event.contentItemId ?? null},${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt}) on conflict(id) do nothing`;
}

export class PostgresImageGenerationRepository implements ImageGenerationRepository {
  constructor(private readonly sql: Sql) {}

  async create(record: ImageGenerationRecord, event: AuditEvent) {
    return await this.sql.begin(async (sql) => {
      const inserted = await sql<{ id: string }[]>`
        insert into image_generations(
          id,workspace_id,brand_id,version,content_item_id,status,provider,model,prompt,prompt_sha256,visual_intent,size,quality,
          output_format,moderation,alt_text,source_evidence_ids,disclosure_required,request_fingerprint_sha256,idempotency_key_sha256,
          lease_owner,lease_expires_at,created_by,created_at,payload
        ) values (
          ${record.id},${record.workspaceId},${record.brandId},${record.version},${record.contentItemId ?? null},${record.status},${record.provider},${record.model},
          ${record.prompt},${record.promptSha256},${record.visualIntent},${record.size},${record.quality},${record.outputFormat},${record.moderation},${record.altText},
          ${sql.json(record.sourceEvidenceIds as never)},${record.disclosureRequired},${record.requestFingerprintSha256},${record.idempotencyKeySha256},
          ${record.leaseOwner!},${record.leaseExpiresAt!},${record.createdBy},${record.createdAt},${sql.json(record as never)}
        ) on conflict(workspace_id,idempotency_key_sha256) do nothing returning id`;
      if (inserted[0]) {
        await audit(sql, event);
        return { record, created: true };
      }
      const rows = await sql<GenerationRow[]>`select payload from image_generations where workspace_id=${record.workspaceId} and idempotency_key_sha256=${record.idempotencyKeySha256} limit 1`;
      const existing = rows[0]?.payload;
      if (!existing || existing.requestFingerprintSha256 !== record.requestFingerprintSha256) throw new DomainError("This idempotency key was already used for another image request.", "idempotency_conflict", 409);
      return { record: existing, created: false };
    }).catch((error: unknown) => {
      const value = error as { code?: string; constraint?: string };
      if (value.code === "23505") throw new DomainError("Image generation already exists.", "image_generation_exists", 409);
      throw error;
    });
  }

  async get(workspaceId: string, id: string) {
    const rows = await this.sql<GenerationRow[]>`select payload from image_generations where workspace_id=${workspaceId} and id=${id} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async list(workspaceId: string, brandId?: string, limit = 100) {
    const bounded = Math.max(1, Math.min(200, limit));
    const rows = brandId
      ? await this.sql<GenerationRow[]>`select payload from image_generations where workspace_id=${workspaceId} and brand_id=${brandId} order by created_at desc,id desc limit ${bounded}`
      : await this.sql<GenerationRow[]>`select payload from image_generations where workspace_id=${workspaceId} order by created_at desc,id desc limit ${bounded}`;
    return rows.map((row) => row.payload);
  }

  async complete(input: CompleteImageGenerationInput) {
    return this.sql.begin(async (sql) => {
      const rows = await sql<GenerationRow[]>`select payload from image_generations where workspace_id=${input.workspaceId} and id=${input.id} and status='generating' and lease_owner=${input.leaseOwner} for update`;
      const current = rows[0]?.payload;
      if (!current) return null;
      const revisedPrompt = input.revisedPrompt?.normalize("NFC").trim();
      const next: ImageGenerationRecord = {
        ...current,
        version: current.version + 1,
        status: "ready",
        outputMediaId: input.outputMediaId,
        outputSha256: input.outputSha256,
        ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
        ...(revisedPrompt ? { revisedPrompt, revisedPromptSha256: imageGenerationHash(revisedPrompt) } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        finishedAt: input.finishedAt,
      };
      delete (next as Partial<ImageGenerationRecord>).leaseOwner;
      delete (next as Partial<ImageGenerationRecord>).leaseExpiresAt;
      const changed = await sql<{ id: string }[]>`update image_generations set version=${next.version},status='ready',lease_owner=null,lease_expires_at=null,output_media_id=${next.outputMediaId!},output_sha256=${next.outputSha256!},provider_request_id=${next.providerRequestId ?? null},revised_prompt=${next.revisedPrompt ?? null},revised_prompt_sha256=${next.revisedPromptSha256 ?? null},usage=${next.usage ? sql.json(next.usage as never) : null},finished_at=${next.finishedAt!},payload=${sql.json(next as never)} where workspace_id=${input.workspaceId} and id=${input.id} and version=${current.version} and lease_owner=${input.leaseOwner} returning id`;
      if (!changed[0]) return null;
      await audit(sql, input.event);
      return next;
    });
  }

  async fail(input: FailImageGenerationInput) {
    return this.sql.begin(async (sql) => {
      const rows = await sql<GenerationRow[]>`select payload from image_generations where workspace_id=${input.workspaceId} and id=${input.id} and status='generating' and lease_owner=${input.leaseOwner} for update`;
      const current = rows[0]?.payload;
      if (!current) return null;
      const next: ImageGenerationRecord = {
        ...current,
        version: current.version + 1,
        status: input.status,
        errorCode: input.errorCode.slice(0, 100),
        errorSummary: input.errorSummary.slice(0, 500),
        ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
        finishedAt: input.finishedAt,
      };
      delete (next as Partial<ImageGenerationRecord>).leaseOwner;
      delete (next as Partial<ImageGenerationRecord>).leaseExpiresAt;
      const changed = await sql<{ id: string }[]>`update image_generations set version=${next.version},status=${next.status},lease_owner=null,lease_expires_at=null,error_code=${next.errorCode!},error_summary=${next.errorSummary!},provider_request_id=${next.providerRequestId ?? null},finished_at=${next.finishedAt!},payload=${sql.json(next as never)} where workspace_id=${input.workspaceId} and id=${input.id} and version=${current.version} and lease_owner=${input.leaseOwner} returning id`;
      if (!changed[0]) return null;
      await audit(sql, input.event);
      return next;
    });
  }
}
