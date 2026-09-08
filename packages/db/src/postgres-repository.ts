import { createHash } from "node:crypto";
import { assertScheduleConflictAcknowledgement, DomainError, inspectScheduleConflicts, type AuditEvent, type ContentItem, type ContentItemRepository, type OutboxMessageInput, type PlatformDraft, type ScheduleConflictCommit } from "@originpost/domain";
import postgres, { type Sql } from "postgres";

type ContentRow = { payload: ContentItem; version: number; brand_id: string };
type AuditRow = {
  id: string;
  workspace_id: string;
  content_item_id: string | null;
  actor_id: string;
  actor_type: AuditEvent["actorType"];
  action: string;
  detail: Record<string, unknown>;
  created_at: Date;
};

function hydrate(item: ContentItem, storedVersion = item.version ?? 1, brandId = item.brandId ?? "brand_default"): ContentItem {
  const drafts = (item.drafts ?? []).map((draft, index) => {
    const legacy = draft as PlatformDraft & { revision?: number; contentSha256?: string; createdBy?: string; createdAt?: string };
    const contentSha256 = legacy.contentSha256 ?? createHash("sha256").update(JSON.stringify({
      platform: draft.platform,
      format: draft.format,
      title: draft.title,
      caption: draft.caption,
      mediaIds: draft.mediaIds,
    })).digest("hex");
    return {
      ...draft,
      revision: legacy.revision ?? index + 1,
      contentSha256,
      createdBy: legacy.createdBy ?? item.createdBy,
      createdAt: legacy.createdAt ?? item.updatedAt,
    };
  });
  return {
    ...item,
    brandId,
    version: item.version ?? storedVersion,
    sources: item.sources ?? [],
    claims: item.claims ?? [],
    researchRuns: item.researchRuns ?? [],
    drafts,
    approvals: (item.approvals ?? []).map((approval) => ({
      ...approval,
      draftId: approval.draftId ?? drafts.at(-1)?.id ?? "legacy-missing-draft",
      draftSha256: approval.draftSha256 ?? drafts.at(-1)?.contentSha256 ?? "legacy-missing-hash",
    })),
    reviewComments: item.reviewComments ?? [],
    reviewLinks: item.reviewLinks ?? [],
    targets: (item.targets ?? []).map((target) => ({ ...target, deliveryMode: target.deliveryMode ?? "auto_publish" })),
    publishAttempts: item.publishAttempts ?? [],
    proofs: (item.proofs ?? []).map((proof) => {
      const legacy = proof as typeof proof & { draftId?: string; draftSha256?: string };
      const targetDraftId = (item.targets ?? []).find((target) => target.platform === proof.platform && target.accountId === proof.accountId)?.draftId;
      const draft = drafts.find((entry) => entry.id === (legacy.draftId ?? targetDraftId));
      return {
        ...proof,
        draftId: legacy.draftId ?? draft?.id ?? "legacy-missing-draft",
        draftSha256: legacy.draftSha256 ?? draft?.contentSha256 ?? "legacy-missing-hash",
      };
    }),
  };
}

export class PostgresContentItemRepository implements ContentItemRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, brandId?: string): Promise<ContentItem[]> {
    const rows = await this.sql<ContentRow[]>`
      select payload, version, brand_id
      from content_items
      where workspace_id = ${workspaceId} and (${brandId ?? null}::text is null or brand_id = ${brandId ?? null})
      order by updated_at desc
    `;
    return rows.map((row) => hydrate(row.payload, row.version, row.brand_id));
  }

  async get(workspaceId: string, id: string): Promise<ContentItem | null> {
    const rows = await this.sql<ContentRow[]>`
      select payload, version, brand_id
      from content_items
      where workspace_id = ${workspaceId} and id = ${id}
      limit 1
    `;
    return rows[0]?.payload ? hydrate(rows[0].payload, rows[0].version, rows[0].brand_id) : null;
  }

  async commit(item: ContentItem, event: AuditEvent, outbox: OutboxMessageInput[] = [], providerOperations: import("@originpost/domain").ProviderPublishOperation[] = [], monitorFingerprints: import("@originpost/domain").MonitorFingerprint[] = [], scheduleConflict?: ScheduleConflictCommit): Promise<void> {
    if (item.workspaceId !== event.workspaceId || item.id !== event.contentItemId) {
      throw new Error("Item and audit event must belong to the same workspace and content item.");
    }
    if (!Number.isInteger(item.version) || item.version < 1) {
      throw new Error("Content item version must be a positive integer.");
    }

    await this.sql.begin(async (sql) => {
      if (scheduleConflict) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([item.workspaceId, scheduleConflict.request.accountId])},0))`;
        const conflictRows = await sql<{ payload: ContentItem }[]>`select payload from content_items where workspace_id=${item.workspaceId} and brand_id=${item.brandId}`;
        const preflight = inspectScheduleConflicts(conflictRows.map((row) => row.payload), scheduleConflict.request);
        assertScheduleConflictAcknowledgement(preflight, scheduleConflict.acknowledgementSha256);
      }
      const committed = await sql<{ id: string }[]>`
        insert into content_items (
          id, workspace_id, brand_id, version, title, status, risk_level, payload, created_at, updated_at
        ) values (
          ${item.id}, ${item.workspaceId}, ${item.brandId}, ${item.version}, ${item.title}, ${item.status}, ${item.riskLevel},
          ${sql.json(item as never)}, ${item.createdAt}, ${item.updatedAt}
        )
        on conflict (id) do update set
          version = excluded.version,
          brand_id = excluded.brand_id,
          title = excluded.title,
          status = excluded.status,
          risk_level = excluded.risk_level,
          payload = excluded.payload,
          updated_at = excluded.updated_at
        where content_items.workspace_id = excluded.workspace_id
          and content_items.version = excluded.version - 1
        returning id
      `;
      if (committed.length !== 1) {
        throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
      }

      for (const operation of providerOperations) {
        if (operation.workspaceId !== item.workspaceId || operation.contentItemId !== item.id) throw new Error("Provider operation and content item must belong to the same workspace and item.");
        await sql`insert into provider_publish_operations (id, workspace_id, content_item_id, target_id, attempt_id, platform, status, container_id, external_post_id, live_url, last_error, created_at, updated_at, payload)
          values (${operation.id}, ${operation.workspaceId}, ${operation.contentItemId}, ${operation.targetId}, ${operation.attemptId}, ${operation.platform}, ${operation.status}, ${operation.containerId}, ${operation.externalPostId ?? null}, ${operation.liveUrl ?? null}, ${operation.lastError ?? null}, ${operation.createdAt}, ${operation.updatedAt}, ${sql.json(operation as never)})
          on conflict (workspace_id, target_id) do update set attempt_id = excluded.attempt_id, status = excluded.status, container_id = excluded.container_id, external_post_id = excluded.external_post_id, live_url = excluded.live_url, last_error = excluded.last_error, updated_at = excluded.updated_at, payload = excluded.payload`;
      }

      for (const fingerprint of monitorFingerprints) {
        if (fingerprint.workspaceId !== item.workspaceId || fingerprint.contentItemId !== item.id) throw new Error("Monitor fingerprint and content item must belong to the same workspace and item.");
        await sql`insert into monitor_fingerprints (workspace_id, monitor_id, fingerprint, source_url, content_item_id, first_seen_at)
          values (${fingerprint.workspaceId}, ${fingerprint.monitorId}, ${fingerprint.fingerprint}, ${fingerprint.sourceUrl}, ${fingerprint.contentItemId}, ${fingerprint.firstSeenAt}) on conflict do nothing`;
      }

      await sql`delete from source_evidence where workspace_id = ${item.workspaceId} and content_item_id = ${item.id}`;
      for (const source of item.sources) {
        await sql`
          insert into source_evidence (
            id, workspace_id, content_item_id, kind, title, source_url, publisher, published_at,
            captured_at, sha256, rights_state, confidence, payload
          ) values (
            ${source.id}, ${item.workspaceId}, ${item.id}, ${source.kind}, ${source.title}, ${source.url ?? null},
            ${source.publisher ?? null}, ${source.publishedAt ?? null}, ${source.capturedAt},
            ${source.sha256 ?? null}, ${source.rights}, ${source.confidence}, ${sql.json(source as never)}
          )
        `;
      }

      await sql`delete from content_claims where workspace_id = ${item.workspaceId} and content_item_id = ${item.id}`;
      for (const claim of item.claims) {
        await sql`
          insert into content_claims (id, workspace_id, content_item_id, status, claim_text, payload)
          values (
            ${claim.id}, ${item.workspaceId}, ${item.id}, ${claim.status}, ${claim.text}, ${sql.json(claim as never)}
          )
        `;
      }

      await sql`delete from research_runs where workspace_id = ${item.workspaceId} and content_item_id = ${item.id}`;
      for (const run of item.researchRuns) {
        await sql`
          insert into research_runs (
            id, workspace_id, content_item_id, status, query, provider, created_at, completed_at, payload
          ) values (
            ${run.id}, ${item.workspaceId}, ${item.id}, ${run.status}, ${run.query}, ${run.provider ?? null},
            ${run.createdAt}, ${run.completedAt ?? null}, ${sql.json(run as never)}
          )
        `;
      }

      for (const draft of item.drafts) {
        await sql`
          insert into content_draft_revisions (
            id, workspace_id, content_item_id, revision, platform, format,
            content_sha256, created_by, created_at, payload
          ) values (
            ${draft.id}, ${item.workspaceId}, ${item.id}, ${draft.revision}, ${draft.platform}, ${draft.format},
            ${draft.contentSha256}, ${draft.createdBy}, ${draft.createdAt}, ${sql.json(draft as never)}
          )
          on conflict (id) do nothing
        `;
      }

      await sql`delete from approvals where workspace_id = ${item.workspaceId} and content_item_id = ${item.id}`;
      for (const approval of item.approvals) {
        await sql`
          insert into approvals (id, workspace_id, content_item_id, actor_id, decision, note, draft_id, draft_sha256, created_at, payload)
          values (
            ${approval.id}, ${item.workspaceId}, ${item.id}, ${approval.actorId}, ${approval.decision},
            ${approval.note ?? null}, ${approval.draftId}, ${approval.draftSha256}, ${approval.createdAt}, ${sql.json(approval as never)}
          )
        `;
      }

      for (const comment of item.reviewComments) {
        await sql`
          insert into review_comments (
            id, workspace_id, content_item_id, draft_id, draft_sha256, author_id, audience, body, created_at, payload
          ) values (
            ${comment.id}, ${item.workspaceId}, ${item.id}, ${comment.draftId}, ${comment.draftSha256},
            ${comment.authorId}, ${comment.audience}, ${comment.body}, ${comment.createdAt}, ${sql.json(comment as never)}
          )
          on conflict (id) do nothing
        `;
      }

      await sql`delete from review_links where workspace_id = ${item.workspaceId} and content_item_id = ${item.id}`;
      for (const link of item.reviewLinks) {
        await sql`
          insert into review_links (
            id, workspace_id, content_item_id, draft_id, draft_sha256, allow_comment,
            expires_at, created_by, created_at, revoked_at, payload
          ) values (
            ${link.id}, ${item.workspaceId}, ${item.id}, ${link.draftId}, ${link.draftSha256},
            ${link.allowComment}, ${link.expiresAt}, ${link.createdBy}, ${link.createdAt},
            ${link.revokedAt ?? null}, ${sql.json(link as never)}
          )
        `;
      }

      for (const target of item.targets) {
        await sql`
          insert into publish_targets (
            id, workspace_id, content_item_id, platform, account_id, scheduled_for, delivery_mode,
            notification_destination_id, action_required_at, acknowledged_at, acknowledged_by, status, payload
          ) values (
            ${target.id}, ${item.workspaceId}, ${item.id}, ${target.platform}, ${target.accountId},
            ${target.scheduledFor}, ${target.deliveryMode}, ${target.notifyDestinationId ?? null},
            ${target.actionRequiredAt ?? null}, ${target.acknowledgedAt ?? null}, ${target.acknowledgedBy ?? null},
            ${target.status}, ${sql.json(target as never)}
          )
          on conflict (id, workspace_id, content_item_id) do update set
            platform = excluded.platform,
            account_id = excluded.account_id,
            scheduled_for = excluded.scheduled_for,
            delivery_mode = excluded.delivery_mode,
            notification_destination_id = excluded.notification_destination_id,
            action_required_at = excluded.action_required_at,
            acknowledged_at = excluded.acknowledged_at,
            acknowledged_by = excluded.acknowledged_by,
            status = excluded.status,
            payload = excluded.payload
        `;
      }

      for (const attempt of item.publishAttempts) {
        await sql`
          insert into publish_attempts (
            id, workspace_id, content_item_id, target_id, attempt_no, idempotency_key,
            status, started_at, completed_at, payload
          ) values (
            ${attempt.id}, ${item.workspaceId}, ${item.id}, ${attempt.targetId}, ${attempt.attemptNo},
            ${attempt.idempotencyKey}, ${attempt.status}, ${attempt.startedAt}, ${attempt.completedAt ?? null},
            ${sql.json(attempt as never)}
          )
          on conflict (id) do update set
            status = excluded.status,
            completed_at = excluded.completed_at,
            payload = excluded.payload
        `;
      }

      for (const proof of item.proofs) {
        await sql`
          insert into publish_proofs (
            id, workspace_id, content_item_id, platform, account_id, external_post_id,
            live_url, published_at, payload
          ) values (
            ${proof.id}, ${item.workspaceId}, ${item.id}, ${proof.platform}, ${proof.accountId},
            ${proof.externalPostId}, ${proof.liveUrl}, ${proof.publishedAt}, ${sql.json(proof as never)}
          )
          on conflict (platform, account_id, external_post_id) do nothing
        `;
      }

      await sql`
        insert into audit_events (
          id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at
        ) values (
          ${event.id}, ${event.workspaceId}, ${event.contentItemId ?? null}, ${event.actorId},
          ${event.actorType}, ${event.action}, ${sql.json({ ...event.detail, contentVersion: item.version } as never)}, ${event.createdAt}
        )
        on conflict (id) do nothing
      `;

      for (const message of outbox) {
        if (message.workspaceId !== item.workspaceId) throw new Error("Outbox messages must belong to the committed workspace.");
        await sql`
          insert into outbox_events (
            id, workspace_id, topic, dedupe_key, payload, available_at, created_at
          ) values (
            ${message.id}, ${message.workspaceId}, ${message.topic}, ${message.dedupeKey},
            ${sql.json(message.payload as never)}, ${message.availableAt}, ${message.createdAt}
          )
          on conflict (workspace_id, dedupe_key) do nothing
        `;
      }
    });
  }

  async listAudit(workspaceId: string, contentItemId: string): Promise<AuditEvent[]> {
    const rows = await this.sql<AuditRow[]>`
      select * from audit_events
      where workspace_id = ${workspaceId} and content_item_id = ${contentItemId}
      order by created_at asc
    `;
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      ...(row.content_item_id ? { contentItemId: row.content_item_id } : {}),
      actorId: row.actor_id,
      actorType: row.actor_type,
      action: row.action,
      detail: row.detail,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

export function createPostgresClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 10, idle_timeout: 20 });
}
