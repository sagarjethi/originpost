import type { ShareCaptureCleanupCandidate, ShareCaptureMedia, ShareCaptureReceipt, ShareCaptureRepository } from "@originpost/domain";
import type { Sql } from "postgres";

type ReceiptRow = {
  id: string;
  created_workspace_id: string;
  user_id: string;
  token_hash: string;
  version: number;
  status: ShareCaptureReceipt["status"];
  title: string | null;
  shared_text: string | null;
  original_url: string | null;
  normalized_url: string | null;
  dedupe_sha256: string;
  media: ShareCaptureMedia | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  materialization_sha256: string | null;
  materialization_workspace_id: string | null;
  materialization_brand_id: string | null;
  materialization_claim_owner: string | null;
  materialization_claim_expires_at: Date | null;
  converted_media_asset_id: string | null;
  converted_content_item_id: string | null;
  converted_draft_id: string | null;
  converted_workspace_id: string | null;
  converted_brand_id: string | null;
  converted_at: Date | null;
  failure_code: string | null;
};

const iso = (value: Date) => value.toISOString();
function receipt(row: ReceiptRow): ShareCaptureReceipt {
  return {
    id: row.id,
    createdWorkspaceId: row.created_workspace_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    version: row.version,
    status: row.status,
    dedupeSha256: row.dedupe_sha256,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    ...(row.title ? { title: row.title } : {}),
    ...(row.shared_text ? { sharedText: row.shared_text } : {}),
    ...(row.original_url ? { originalUrl: row.original_url } : {}),
    ...(row.normalized_url ? { normalizedUrl: row.normalized_url } : {}),
    ...(row.media ? { media: row.media } : {}),
    ...(row.materialization_sha256 ? { materializationSha256: row.materialization_sha256 } : {}),
    ...(row.materialization_workspace_id ? { materializationWorkspaceId: row.materialization_workspace_id } : {}),
    ...(row.materialization_brand_id ? { materializationBrandId: row.materialization_brand_id } : {}),
    ...(row.materialization_claim_owner ? { materializationClaimOwner: row.materialization_claim_owner } : {}),
    ...(row.materialization_claim_expires_at ? { materializationClaimExpiresAt: iso(row.materialization_claim_expires_at) } : {}),
    ...(row.converted_media_asset_id ? { convertedMediaAssetId: row.converted_media_asset_id } : {}),
    ...(row.converted_content_item_id ? { convertedContentItemId: row.converted_content_item_id } : {}),
    ...(row.converted_draft_id ? { convertedDraftId: row.converted_draft_id } : {}),
    ...(row.converted_workspace_id ? { convertedWorkspaceId: row.converted_workspace_id } : {}),
    ...(row.converted_brand_id ? { convertedBrandId: row.converted_brand_id } : {}),
    ...(row.converted_at ? { convertedAt: iso(row.converted_at) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
  };
}

export class PostgresShareCaptureRepository implements ShareCaptureRepository {
  constructor(private readonly sql: Sql) {}

  async create(value: ShareCaptureReceipt): Promise<void> {
    await this.sql`
      insert into mobile_share_capture_receipts (
        id,created_workspace_id,user_id,token_hash,version,status,title,shared_text,original_url,normalized_url,
        dedupe_sha256,media,created_at,updated_at,expires_at,materialization_sha256,materialization_workspace_id,
        materialization_brand_id,materialization_claim_owner,materialization_claim_expires_at,converted_media_asset_id,
        converted_content_item_id,converted_draft_id,converted_workspace_id,converted_brand_id,converted_at,failure_code
      ) values (
        ${value.id},${value.createdWorkspaceId},${value.userId},${value.tokenHash},${value.version},${value.status},${value.title ?? null},
        ${value.sharedText ?? null},${value.originalUrl ?? null},${value.normalizedUrl ?? null},${value.dedupeSha256},
        ${value.media ? this.sql.json(value.media as never) : null},${value.createdAt},${value.updatedAt},${value.expiresAt},
        ${value.materializationSha256 ?? null},${value.materializationWorkspaceId ?? null},${value.materializationBrandId ?? null},
        ${value.materializationClaimOwner ?? null},${value.materializationClaimExpiresAt ?? null},${value.convertedMediaAssetId ?? null},
        ${value.convertedContentItemId ?? null},${value.convertedDraftId ?? null},${value.convertedWorkspaceId ?? null},
        ${value.convertedBrandId ?? null},${value.convertedAt ?? null},${value.failureCode ?? null}
      )`;
  }

  async getByTokenHash(userId: string, tokenHash: string, now: string): Promise<ShareCaptureReceipt | null> {
    return this.sql.begin(async (sql) => {
      await sql`
        update mobile_share_capture_receipts
        set status='expired',version=version+1,title=null,shared_text=null,original_url=null,normalized_url=null,
            materialization_claim_owner=null,materialization_claim_expires_at=null,updated_at=${now}
        where user_id=${userId} and token_hash=${tokenHash} and expires_at<=${now}
          and status not in ('converted','expired')
          and not (status='materializing' and materialization_claim_expires_at>clock_timestamp())`;
      const rows = await sql<ReceiptRow[]>`select * from mobile_share_capture_receipts where user_id=${userId} and token_hash=${tokenHash} limit 1`;
      return rows[0] ? receipt(rows[0]) : null;
    });
  }

  async revise(input: { id: string; userId: string; expectedVersion: number; prepared: { title: string; sharedText?: string; originalUrl?: string; normalizedUrl?: string; dedupeSha256: string }; at: string }): Promise<ShareCaptureReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      update mobile_share_capture_receipts
      set version=version+1,title=${input.prepared.title},shared_text=${input.prepared.sharedText ?? null},
          original_url=${input.prepared.originalUrl ?? null},normalized_url=${input.prepared.normalizedUrl ?? null},
          dedupe_sha256=${input.prepared.dedupeSha256},updated_at=${input.at}
      where id=${input.id} and user_id=${input.userId} and version=${input.expectedVersion}
        and status in ('pending','pending_review') and expires_at>${input.at}
      returning *`;
    return rows[0] ? receipt(rows[0]) : null;
  }

  async updateMedia(input: { id: string; userId: string; expectedVersion: number; from: "receiving" | "inspecting"; to: "inspecting" | "pending_review" | "rejected"; media: ShareCaptureMedia; failureCode?: string; at: string }): Promise<ShareCaptureReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      update mobile_share_capture_receipts
      set version=version+1,status=${input.to},media=${this.sql.json(input.media as never)},failure_code=${input.failureCode?.slice(0,100) ?? null},updated_at=${input.at}
      where id=${input.id} and user_id=${input.userId} and version=${input.expectedVersion} and status=${input.from} and expires_at>${input.at}
      returning *`;
    return rows[0] ? receipt(rows[0]) : null;
  }

  async claimMaterialization(input: { id: string; userId: string; expectedVersion: number; intentSha256: string; workspaceId: string; brandId: string; claimOwner: string; leaseSeconds: number }): Promise<ShareCaptureReceipt | null> {
    const leaseSeconds = Math.max(30, Math.min(input.leaseSeconds, 900));
    const rows = await this.sql<ReceiptRow[]>`
      update mobile_share_capture_receipts
      set version=version+1,status='materializing',materialization_sha256=coalesce(materialization_sha256,${input.intentSha256}),
          materialization_workspace_id=${input.workspaceId},materialization_brand_id=${input.brandId},
          materialization_claim_owner=${input.claimOwner},materialization_claim_expires_at=clock_timestamp()+make_interval(secs=>${leaseSeconds}),
          updated_at=clock_timestamp()
      where id=${input.id} and user_id=${input.userId} and version=${input.expectedVersion}
        and expires_at>clock_timestamp()
        and (materialization_sha256 is null or materialization_sha256=${input.intentSha256})
        and (status in ('pending','pending_review') or (status='materializing' and materialization_claim_expires_at<=clock_timestamp()))
      returning *`;
    return rows[0] ? receipt(rows[0]) : null;
  }

  async markConverted(input: { id: string; userId: string; expectedVersion: number; workspaceId: string; brandId: string; contentItemId?: string; draftId?: string; mediaAssetId?: string; convertedAt: string; claimOwner?: string }): Promise<ShareCaptureReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      update mobile_share_capture_receipts
      set version=version+1,status='converted',title=null,shared_text=null,original_url=null,normalized_url=null,
          converted_media_asset_id=${input.mediaAssetId ?? null},converted_content_item_id=${input.contentItemId ?? null},
          converted_draft_id=${input.draftId ?? null},converted_workspace_id=${input.workspaceId},converted_brand_id=${input.brandId},
          converted_at=${input.convertedAt},updated_at=${input.convertedAt},failure_code=null,
          materialization_claim_owner=null,materialization_claim_expires_at=null
      where id=${input.id} and user_id=${input.userId} and version=${input.expectedVersion} and expires_at>clock_timestamp()
        and (
          (media is null and status='pending' and ${input.claimOwner ?? null}::text is null)
          or
          (media is not null and status='materializing' and materialization_claim_owner=${input.claimOwner ?? null}
            and materialization_claim_expires_at>clock_timestamp())
        )
      returning *`;
    return rows[0] ? receipt(rows[0]) : null;
  }

  async markFailed(id: string, userId: string, expectedVersion: number, failureCode: string, at: string): Promise<ShareCaptureReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      update mobile_share_capture_receipts
      set version=version+1,status=case when media is null then 'failed' else 'rejected' end,
          failure_code=${failureCode.slice(0,100)},materialization_claim_owner=null,materialization_claim_expires_at=null,updated_at=${at}
      where id=${id} and user_id=${userId} and version=${expectedVersion}
        and status in ('pending','receiving','inspecting','pending_review','materializing')
      returning *`;
    return rows[0] ? receipt(rows[0]) : null;
  }

  async expireDue(now: string, limit = 100): Promise<number> {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const rows = await this.sql<{ id: string }[]>`
      with due as (
        select id from mobile_share_capture_receipts
        where status not in ('converted','expired') and expires_at<=${now}
          and not (status='materializing' and materialization_claim_expires_at>clock_timestamp())
        order by expires_at asc limit ${bounded} for update skip locked
      )
      update mobile_share_capture_receipts receipt
      set status='expired',version=receipt.version+1,title=null,shared_text=null,original_url=null,normalized_url=null,
          materialization_claim_owner=null,materialization_claim_expires_at=null,updated_at=${now}
      from due where receipt.id=due.id returning receipt.id`;
    return rows.length;
  }

  async listQuarantineCleanup(limit = 100): Promise<ShareCaptureCleanupCandidate[]> {
    const rows = await this.sql<{ id: string; user_id: string; quarantine_object_key: string }[]>`
      select id,user_id,media->>'quarantineObjectKey' as quarantine_object_key
      from mobile_share_capture_receipts
      where status in ('converted','expired','rejected','failed')
        and coalesce(media->>'quarantineObjectKey','')<>''
      order by updated_at asc limit ${Math.max(1,Math.min(limit,1000))}`;
    return rows.map((row) => ({ id: row.id, userId: row.user_id, quarantineObjectKey: row.quarantine_object_key }));
  }

  async clearQuarantine(id: string, userId: string, quarantineObjectKey: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update mobile_share_capture_receipts
      set version=version+1,media=jsonb_set(media,'{quarantineObjectKey}',to_jsonb(''::text),false),updated_at=clock_timestamp()
      where id=${id} and user_id=${userId} and status in ('converted','expired','rejected','failed')
        and media->>'quarantineObjectKey'=${quarantineObjectKey}
      returning id`;
    return rows.length === 1;
  }
}
