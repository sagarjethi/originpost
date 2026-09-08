import {
  DomainError,
  transitionEngagementAction,
  type ActionTransition,
  type AuditEvent,
  type BrandScope,
  type CommentIngestBatch,
  type EngagementAction,
  type EngagementActionStatus,
  type EngagementComment,
  type EngagementCommentDirection,
  type EngagementCommentSource,
  type EngagementCommentVisibility,
  type EngagementPlatform,
  type EngagementRepository,
  type EngagementThread,
  type EngagementThreadState,
  type EngagementThreadUpdate,
  type EngagementThreadView,
  type EngagementWebhookReceipt,
  type EngagementWebhookReceiptStatus,
  type InboxPage,
  type InboxQuery,
  type IngestResult,
  type ReadMarker,
} from "@originpost/domain";
import type { Sql } from "postgres";

type ThreadRow = {
  id: string;
  workspace_id: string;
  brand_id: string;
  content_item_id: string;
  proof_id: string;
  account_id: string;
  platform: EngagementPlatform;
  external_media_id: string;
  state: EngagementThreadState;
  assigned_to: string | null;
  last_activity_at: Date | string;
  last_synced_at: Date | string | null;
  resolved_at: Date | string | null;
  version: number;
};

type CommentRow = {
  id: string;
  workspace_id: string;
  brand_id: string;
  thread_id: string;
  account_id: string;
  external_media_id: string;
  platform: EngagementPlatform;
  external_comment_id: string;
  parent_external_comment_id: string | null;
  author_scoped_id: string | null;
  author_username: string | null;
  body: string;
  body_sha256: string;
  direction: EngagementCommentDirection;
  visibility: EngagementCommentVisibility;
  provider_created_at: Date | string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  source: EngagementCommentSource;
  raw_payload_sha256: string | null;
};

type ActionRow = {
  id: string;
  workspace_id: string;
  brand_id: string;
  thread_id: string;
  comment_id: string;
  platform: EngagementPlatform;
  type: "reply";
  body: string;
  body_sha256: string;
  status: EngagementActionStatus;
  idempotency_key: string;
  requested_by: string;
  approved_by: string | null;
  provider_reply_id: string | null;
  provider_response_sha256: string | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  version: number;
};

type InboxRow = ThreadRow & {
  latest_comment: CommentRow | null;
  unread_count: number;
  needs_reply: boolean;
};

type ReceiptRow = {
  id: string;
  provider: EngagementPlatform;
  workspace_id: string;
  brand_id: string;
  account_id: string;
  payload_sha256: string;
  normalized_event: Record<string, unknown>;
  status: EngagementWebhookReceiptStatus;
  attempts: number;
  available_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  error_summary: string | null;
  received_at: Date | string;
  processed_at: Date | string | null;
};

type Cursor = { lastActivityAt: string; id: string };

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapThread(row: ThreadRow): EngagementThread {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    brandId: row.brand_id,
    contentItemId: row.content_item_id,
    proofId: row.proof_id,
    accountId: row.account_id,
    platform: row.platform,
    externalMediaId: row.external_media_id,
    state: row.state,
    lastActivityAt: iso(row.last_activity_at),
    version: row.version,
    ...(row.assigned_to ? { assignedTo: row.assigned_to } : {}),
    ...(row.last_synced_at ? { lastSyncedAt: iso(row.last_synced_at) } : {}),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
  };
}

function mapComment(row: CommentRow): EngagementComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    brandId: row.brand_id,
    threadId: row.thread_id,
    accountId: row.account_id,
    externalMediaId: row.external_media_id,
    externalCommentId: row.external_comment_id,
    body: row.body,
    bodySha256: row.body_sha256,
    direction: row.direction,
    visibility: row.visibility,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    source: row.source,
    ...(row.parent_external_comment_id ? { parentExternalCommentId: row.parent_external_comment_id } : {}),
    ...(row.author_scoped_id ? { authorScopedId: row.author_scoped_id } : {}),
    ...(row.author_username ? { authorUsername: row.author_username } : {}),
    ...(row.provider_created_at ? { providerCreatedAt: iso(row.provider_created_at) } : {}),
    ...(row.raw_payload_sha256 ? { rawPayloadSha256: row.raw_payload_sha256 } : {}),
  };
}

function mapAction(row: ActionRow): EngagementAction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    brandId: row.brand_id,
    threadId: row.thread_id,
    commentId: row.comment_id,
    type: row.type,
    body: row.body,
    bodySha256: row.body_sha256,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestedBy: row.requested_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.provider_reply_id ? { providerReplyId: row.provider_reply_id } : {}),
    ...(row.provider_response_sha256 ? { providerResponseSha256: row.provider_response_sha256 } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

function mapReceipt(row: ReceiptRow): EngagementWebhookReceipt {
  return {
    id: row.id,
    provider: row.provider,
    workspaceId: row.workspace_id,
    brandId: row.brand_id,
    accountId: row.account_id,
    payloadSha256: row.payload_sha256,
    normalizedEvent: row.normalized_event,
    status: row.status,
    attempts: row.attempts,
    availableAt: iso(row.available_at),
    createdAt: iso(row.received_at),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.error_summary ? { lastError: row.error_summary } : {}),
    ...(row.processed_at ? { processedAt: iso(row.processed_at) } : {}),
  };
}

function encodeCursor(thread: EngagementThread): string {
  return Buffer.from(JSON.stringify({ lastActivityAt: thread.lastActivityAt, id: thread.id } satisfies Cursor)).toString("base64url");
}

function decodeCursor(value?: string): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.lastActivityAt !== "string" || Number.isNaN(Date.parse(parsed.lastActivityAt)) || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("invalid cursor fields");
    }
    return { lastActivityAt: parsed.lastActivityAt, id: parsed.id };
  } catch {
    throw new DomainError("The inbox cursor is invalid. Refresh the inbox and try again.", "engagement_cursor_invalid", 400);
  }
}

function assertScope(scope: BrandScope, value: { workspaceId: string; brandId: string }, label: string): void {
  if (value.workspaceId !== scope.workspaceId || value.brandId !== scope.brandId) {
    throw new Error(`${label} must belong to the requested workspace and brand.`);
  }
}

function assertAudit(scope: BrandScope, event: AuditEvent, contentItemId: string): void {
  if (event.workspaceId !== scope.workspaceId || (event.contentItemId !== undefined && event.contentItemId !== contentItemId)) {
    throw new Error("Engagement data and audit event must belong to the same content item.");
  }
}

export class PostgresEngagementRepository implements EngagementRepository {
  constructor(private readonly sql: Sql) {}

  async listThreads(scope: BrandScope, query: InboxQuery): Promise<InboxPage> {
    const limit = Math.max(1, Math.min(query.limit ?? 30, 100));
    const cursor = decodeCursor(query.cursor);
    const search = query.query?.normalize("NFC").trim() || null;
    const rows = await this.sql<InboxRow[]>`
      select
        thread.*,
        case when latest.id is null then null else to_jsonb(latest) end as latest_comment,
        coalesce(unread.unread_count, 0)::int as unread_count,
        coalesce(latest.direction = 'incoming' and latest.visibility = 'visible', false) as needs_reply
      from engagement_threads thread
      left join lateral (
        select comment.*
        from engagement_comments comment
        where comment.workspace_id = thread.workspace_id
          and comment.brand_id = thread.brand_id
          and comment.thread_id = thread.id
        order by coalesce(comment.provider_created_at, comment.first_seen_at) desc, comment.id desc
        limit 1
      ) latest on true
      left join engagement_thread_reads read_marker
        on read_marker.workspace_id = thread.workspace_id
        and read_marker.brand_id = thread.brand_id
        and read_marker.thread_id = thread.id
        and read_marker.user_id = ${query.viewerId}
      left join lateral (
        select count(*)::int as unread_count
        from engagement_comments unread_comment
        where unread_comment.workspace_id = thread.workspace_id
          and unread_comment.brand_id = thread.brand_id
          and unread_comment.thread_id = thread.id
          and unread_comment.direction = 'incoming'
          and unread_comment.visibility = 'visible'
          and (
            read_marker.last_read_at is null
            or coalesce(unread_comment.provider_created_at, unread_comment.first_seen_at) > read_marker.last_read_at
          )
      ) unread on true
      where thread.workspace_id = ${scope.workspaceId}
        and thread.brand_id = ${scope.brandId}
        and (${query.state ?? null}::text is null or thread.state = ${query.state ?? null})
        and (${query.assignedTo ?? null}::text is null or thread.assigned_to = ${query.assignedTo ?? null})
        and (${query.accountId ?? null}::text is null or thread.account_id = ${query.accountId ?? null})
        and (
          ${search}::text is null
          or latest.author_username ilike ('%' || ${search} || '%')
          or latest.body ilike ('%' || ${search} || '%')
        )
        and (
          ${cursor?.lastActivityAt ?? null}::timestamptz is null
          or (thread.last_activity_at, thread.id) < (${cursor?.lastActivityAt ?? null}::timestamptz, ${cursor?.id ?? null}::text)
        )
      order by thread.last_activity_at desc, thread.id desc
      limit ${limit + 1}
    `;
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => ({
      thread: mapThread(row),
      ...(row.latest_comment ? { latestComment: mapComment(row.latest_comment) } : {}),
      unreadCount: row.unread_count,
      needsReply: row.needs_reply,
    }));
    const last = items.at(-1)?.thread;
    return { items, ...(hasNext && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async getThread(scope: BrandScope, id: string): Promise<EngagementThreadView | null> {
    const threadRows = await this.sql<ThreadRow[]>`
      select * from engagement_threads
      where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id}
      limit 1
    `;
    const threadRow = threadRows[0];
    if (!threadRow) return null;
    const [comments, actions] = await Promise.all([
      this.sql<CommentRow[]>`
        select * from engagement_comments
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and thread_id = ${id}
        order by coalesce(provider_created_at, first_seen_at) asc, id asc
      `,
      this.sql<ActionRow[]>`
        select * from engagement_actions
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and thread_id = ${id}
        order by created_at asc, id asc
      `,
    ]);
    return { thread: mapThread(threadRow), comments: comments.map(mapComment), actions: actions.map(mapAction) };
  }

  async getComment(scope: BrandScope, id: string): Promise<EngagementComment | null> {
    const rows = await this.sql<CommentRow[]>`
      select * from engagement_comments
      where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id}
      limit 1
    `;
    return rows[0] ? mapComment(rows[0]) : null;
  }

  async getAction(scope: BrandScope, id: string): Promise<EngagementAction | null> {
    const rows = await this.sql<ActionRow[]>`
      select * from engagement_actions
      where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id}
      limit 1
    `;
    return rows[0] ? mapAction(rows[0]) : null;
  }

  async updateThread(scope: BrandScope, id: string, command: EngagementThreadUpdate, event: AuditEvent): Promise<EngagementThread | null> {
    if (event.workspaceId !== scope.workspaceId || event.actorId !== command.actorId) {
      throw new Error("Engagement thread update and audit event must have the same workspace and actor.");
    }
    return this.sql.begin(async (sql) => {
      const currentRows = await sql<ThreadRow[]>`
        select * from engagement_threads
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id}
        for update
      `;
      const current = currentRows[0];
      if (!current) return null;
      if (event.contentItemId !== undefined && event.contentItemId !== current.content_item_id) throw new Error("Engagement thread update and audit event must belong to the same content item.");
      if (current.version !== command.expectedVersion) {
        throw new DomainError("This conversation changed while you were working. Refresh it and try again.", "engagement_thread_version_conflict", 409);
      }
      const changesAssignment = Object.hasOwn(command, "assignedTo");
      const nextState = command.state ?? current.state;
      const updated = await sql<ThreadRow[]>`
        update engagement_threads set
          state = ${nextState},
          assigned_to = case when ${changesAssignment} then ${command.assignedTo ?? null} else assigned_to end,
          resolved_at = case when ${nextState} = 'resolved' then coalesce(resolved_at, ${command.at}) else null end,
          version = version + 1,
          updated_at = ${command.at}
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${id}
          and version = ${command.expectedVersion}
        returning *
      `;
      const saved = updated[0];
      if (!saved) throw new DomainError("This conversation changed while you were working. Refresh it and try again.", "engagement_thread_version_conflict", 409);
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, ${current.content_item_id}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
      return mapThread(saved);
    });
  }

  async ingest(scope: BrandScope, batch: CommentIngestBatch, event: AuditEvent): Promise<IngestResult> {
    assertScope(scope, batch.thread, "Engagement thread");
    assertAudit(scope, event, batch.thread.contentItemId);
    for (const comment of batch.comments) {
      assertScope(scope, comment, "Engagement comment");
      if (comment.threadId !== batch.thread.id || comment.accountId !== batch.thread.accountId || comment.externalMediaId !== batch.thread.externalMediaId) {
        throw new Error("Engagement comments must belong to the ingested thread, account, and media.");
      }
    }

    return this.sql.begin(async (sql) => {
      const existingRows = await sql<ThreadRow[]>`
        select * from engagement_threads
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and proof_id = ${batch.thread.proofId}
        for update
      `;
      const existing = existingRows[0];
      if (existing && (
        existing.id !== batch.thread.id
        || existing.content_item_id !== batch.thread.contentItemId
        || existing.account_id !== batch.thread.accountId
        || existing.platform !== batch.thread.platform
        || existing.external_media_id !== batch.thread.externalMediaId
      )) {
        throw new Error("The publish proof is already linked to a different engagement thread lineage.");
      }

      if (!existing) {
        await sql`
          insert into engagement_threads (
            id, workspace_id, brand_id, content_item_id, proof_id, account_id, platform,
            external_media_id, state, assigned_to, last_activity_at, last_synced_at,
            resolved_at, version, created_at, updated_at
          ) values (
            ${batch.thread.id}, ${scope.workspaceId}, ${scope.brandId}, ${batch.thread.contentItemId},
            ${batch.thread.proofId}, ${batch.thread.accountId}, ${batch.thread.platform}, ${batch.thread.externalMediaId},
            ${batch.thread.state}, ${batch.thread.assignedTo ?? null}, ${batch.thread.lastActivityAt}, ${batch.syncedAt},
            ${batch.thread.resolvedAt ?? null}, ${batch.thread.version}, ${batch.syncedAt}, ${batch.syncedAt}
          )
        `;
      }

      let inserted = 0;
      let updated = 0;
      let hasNewIncoming = false;
      for (const comment of batch.comments) {
        const prior = await sql<{ id: string }[]>`
          select id from engagement_comments
          where account_id = ${comment.accountId} and external_comment_id = ${comment.externalCommentId}
          for update
        `;
        if (prior[0] && prior[0].id !== comment.id) {
          const owned = await sql<{ id: string }[]>`
            select id from engagement_comments
            where id = ${prior[0].id} and workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId}
              and thread_id = ${batch.thread.id}
          `;
          if (!owned[0]) throw new Error("The provider comment is already linked outside this engagement scope.");
        }
        const result = await sql<{ id: string }[]>`
          insert into engagement_comments (
            id, workspace_id, brand_id, thread_id, account_id, external_media_id, platform,
            external_comment_id, parent_external_comment_id, author_scoped_id, author_username,
            body, body_sha256, direction, visibility, provider_created_at, first_seen_at,
            last_seen_at, source, raw_payload_sha256, updated_at
          ) values (
            ${prior[0]?.id ?? comment.id}, ${scope.workspaceId}, ${scope.brandId}, ${batch.thread.id}, ${comment.accountId},
            ${comment.externalMediaId}, ${batch.thread.platform}, ${comment.externalCommentId}, ${comment.parentExternalCommentId ?? null},
            ${comment.authorScopedId ?? null}, ${comment.authorUsername ?? null}, ${comment.body}, ${comment.bodySha256},
            ${comment.direction}, ${comment.visibility}, ${comment.providerCreatedAt ?? null}, ${comment.firstSeenAt},
            ${comment.lastSeenAt}, ${comment.source}, ${comment.rawPayloadSha256 ?? null}, ${batch.syncedAt}
          )
          on conflict (account_id, external_comment_id) do update set
            parent_external_comment_id = excluded.parent_external_comment_id,
            author_scoped_id = excluded.author_scoped_id,
            author_username = excluded.author_username,
            body = excluded.body,
            body_sha256 = excluded.body_sha256,
            direction = excluded.direction,
            visibility = excluded.visibility,
            provider_created_at = coalesce(excluded.provider_created_at, engagement_comments.provider_created_at),
            first_seen_at = least(engagement_comments.first_seen_at, excluded.first_seen_at),
            last_seen_at = greatest(engagement_comments.last_seen_at, excluded.last_seen_at),
            source = excluded.source,
            raw_payload_sha256 = coalesce(excluded.raw_payload_sha256, engagement_comments.raw_payload_sha256),
            updated_at = excluded.updated_at
          where engagement_comments.workspace_id = excluded.workspace_id
            and engagement_comments.brand_id = excluded.brand_id
            and engagement_comments.thread_id = excluded.thread_id
            and engagement_comments.platform = excluded.platform
          returning id
        `;
        if (!result[0]) throw new Error("The provider comment could not be safely written in this engagement scope.");
        if (prior[0]) updated += 1;
        else {
          inserted += 1;
          if (comment.direction === "incoming") hasNewIncoming = true;
        }
      }

      const activityAt = batch.comments.reduce((latest, comment) => {
        const value = comment.providerCreatedAt ?? comment.firstSeenAt;
        return value > latest ? value : latest;
      }, batch.thread.lastActivityAt);
      const reopened = Boolean(existing && existing.state === "resolved" && hasNewIncoming);
      const threadRows = await sql<ThreadRow[]>`
        update engagement_threads set
          state = case when ${reopened} then 'open' else state end,
          resolved_at = case when ${reopened} then null else resolved_at end,
          last_activity_at = greatest(last_activity_at, ${activityAt}),
          last_synced_at = ${batch.syncedAt},
          version = version + case when ${reopened} then 1 else 0 end,
          updated_at = ${batch.syncedAt}
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${batch.thread.id}
        returning *
      `;
      const savedThread = threadRows[0];
      if (!savedThread) throw new Error("The engagement thread could not be updated in this scope.");

      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, ${batch.thread.contentItemId}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
      return { thread: mapThread(savedThread), inserted, updated, reopened };
    });
  }

  async markRead(scope: BrandScope, threadId: string, userId: string, marker: ReadMarker): Promise<void> {
    const rows = await this.sql<{ thread_id: string }[]>`
      insert into engagement_thread_reads (
        workspace_id, brand_id, thread_id, user_id, last_read_comment_id, last_read_at, updated_at
      )
      select ${scope.workspaceId}, ${scope.brandId}, thread.id, ${userId}, ${marker.lastReadCommentId ?? null}, ${marker.lastReadAt}, ${marker.lastReadAt}
      from engagement_threads thread
      join workspace_members member
        on member.workspace_id = thread.workspace_id and member.user_id = ${userId}
      where thread.workspace_id = ${scope.workspaceId} and thread.brand_id = ${scope.brandId} and thread.id = ${threadId}
        and (
          ${marker.lastReadCommentId ?? null}::text is null
          or exists (
            select 1 from engagement_comments comment
            where comment.workspace_id = thread.workspace_id and comment.brand_id = thread.brand_id
              and comment.thread_id = thread.id and comment.id = ${marker.lastReadCommentId ?? null}
          )
        )
      on conflict (workspace_id, thread_id, user_id) do update set
        last_read_comment_id = case
          when excluded.last_read_at >= engagement_thread_reads.last_read_at then excluded.last_read_comment_id
          else engagement_thread_reads.last_read_comment_id
        end,
        last_read_at = greatest(engagement_thread_reads.last_read_at, excluded.last_read_at),
        updated_at = greatest(engagement_thread_reads.updated_at, excluded.updated_at)
      returning thread_id
    `;
    if (!rows[0]) throw new DomainError("Engagement thread not found.", "engagement_thread_not_found", 404);
  }

  async saveAction(action: EngagementAction, event: AuditEvent): Promise<void> {
    const scope = { workspaceId: action.workspaceId, brandId: action.brandId };
    if (event.workspaceId !== scope.workspaceId || event.actorId !== action.requestedBy) {
      throw new Error("Engagement action and audit event must have the same workspace and actor.");
    }
    await this.sql.begin(async (sql) => {
      const threadRows = await sql<{ content_item_id: string; platform: EngagementPlatform }[]>`
        select content_item_id, platform from engagement_threads
        where workspace_id = ${action.workspaceId} and brand_id = ${action.brandId} and id = ${action.threadId}
        for update
      `;
      const thread = threadRows[0];
      if (!thread || (event.contentItemId !== undefined && thread.content_item_id !== event.contentItemId)) throw new Error("Engagement action and audit event must belong to the same content item.");
      const currentRows = await sql<ActionRow[]>`
        select * from engagement_actions
        where workspace_id = ${action.workspaceId} and brand_id = ${action.brandId} and id = ${action.id}
        for update
      `;
      const current = currentRows[0];
      if (current && action.version !== current.version + 1) {
        const same = action.version === current.version && action.bodySha256 === current.body_sha256 && action.status === current.status;
        if (same) return;
        throw new DomainError("This reply changed while you were working. Refresh it and try again.", "engagement_action_version_conflict", 409);
      }
      const rows = await sql<{ id: string }[]>`
        insert into engagement_actions (
          id, workspace_id, brand_id, thread_id, comment_id, platform, type, body, body_sha256,
          status, idempotency_key, requested_by, approved_by, provider_reply_id,
          provider_response_sha256, error_code, error_summary, created_at, updated_at,
          completed_at, version
        ) values (
          ${action.id}, ${action.workspaceId}, ${action.brandId}, ${action.threadId}, ${action.commentId}, ${thread.platform}, ${action.type},
          ${action.body}, ${action.bodySha256}, ${action.status}, ${action.idempotencyKey}, ${action.requestedBy},
          ${action.approvedBy ?? null}, ${action.providerReplyId ?? null}, ${action.providerResponseSha256 ?? null},
          ${action.errorCode ?? null}, ${action.errorSummary?.slice(0, 500) ?? null}, ${action.createdAt}, ${action.updatedAt},
          ${action.completedAt ?? null}, ${action.version}
        )
        on conflict (id) do update set
          body = excluded.body,
          body_sha256 = excluded.body_sha256,
          status = excluded.status,
          idempotency_key = excluded.idempotency_key,
          requested_by = excluded.requested_by,
          approved_by = excluded.approved_by,
          provider_reply_id = excluded.provider_reply_id,
          provider_response_sha256 = excluded.provider_response_sha256,
          error_code = excluded.error_code,
          error_summary = excluded.error_summary,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          version = excluded.version
        where engagement_actions.workspace_id = excluded.workspace_id
          and engagement_actions.brand_id = excluded.brand_id
          and engagement_actions.thread_id = excluded.thread_id
          and engagement_actions.platform = excluded.platform
          and engagement_actions.version + 1 = excluded.version
        returning id
      `;
      if (!rows[0]) throw new Error("The engagement action could not be safely written in this scope.");
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, ${thread.content_item_id}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
    });
  }

  async transitionAction(scope: BrandScope, command: ActionTransition, event: AuditEvent): Promise<EngagementAction | null> {
    if (event.workspaceId !== scope.workspaceId || event.actorId !== command.actorId) {
      throw new Error("Engagement action transition and audit event must have the same workspace and actor.");
    }
    return this.sql.begin(async (sql) => {
      const rows = await sql<(ActionRow & { content_item_id: string })[]>`
        select action.*, thread.content_item_id
        from engagement_actions action
        join engagement_threads thread
          on thread.workspace_id = action.workspace_id and thread.brand_id = action.brand_id and thread.id = action.thread_id
        where action.workspace_id = ${scope.workspaceId} and action.brand_id = ${scope.brandId} and action.id = ${command.actionId}
        for update of action
      `;
      const currentRow = rows[0];
      if (!currentRow) return null;
      assertAudit(scope, event, currentRow.content_item_id);
      const next = transitionEngagementAction(mapAction(currentRow), command);
      const terminal = next.status === "succeeded" || next.status === "failed" || next.status === "cancelled";
      const updated = await sql<ActionRow[]>`
        update engagement_actions set
          status = ${next.status},
          approved_by = ${next.approvedBy ?? null},
          provider_reply_id = ${next.providerReplyId ?? null},
          provider_response_sha256 = ${next.providerResponseSha256 ?? null},
          error_code = ${next.errorCode ?? null},
          error_summary = ${next.errorSummary?.slice(0, 500) ?? null},
          updated_at = ${next.updatedAt},
          completed_at = ${terminal ? next.completedAt ?? next.updatedAt : null},
          version = ${next.version}
        where workspace_id = ${scope.workspaceId} and brand_id = ${scope.brandId} and id = ${next.id}
          and version = ${command.expectedVersion}
        returning *
      `;
      const saved = updated[0];
      if (!saved) throw new DomainError("This reply changed while you were working. Refresh it and try again.", "engagement_action_version_conflict", 409);
      await sql`
        insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
        values (${event.id}, ${event.workspaceId}, ${currentRow.content_item_id}, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
        on conflict (id) do nothing
      `;
      return mapAction(saved);
    });
  }

  async listActionsForRecovery(statuses: EngagementActionStatus[] = ["queued", "processing", "uncertain"], limit = 100): Promise<EngagementAction[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    if (!statuses.length) return [];
    const rows = await this.sql<ActionRow[]>`
      select * from engagement_actions
      where status in ${this.sql(statuses)}
      order by updated_at asc, id asc
      limit ${boundedLimit}
    `;
    return rows.map(mapAction);
  }

  async listThreadsNeedingSync(before: string, limit = 100): Promise<EngagementThread[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = await this.sql<ThreadRow[]>`
      select * from engagement_threads
      where state = 'open' and (last_synced_at is null or last_synced_at < ${before})
      order by last_synced_at asc nulls first, last_activity_at desc, id asc
      limit ${boundedLimit}
    `;
    return rows.map(mapThread);
  }

  async recordWebhookReceipt(receipt: EngagementWebhookReceipt): Promise<{ receipt: EngagementWebhookReceipt; created: boolean }> {
    const inserted = await this.sql<ReceiptRow[]>`
      insert into provider_webhook_receipts (
        id, provider, workspace_id, brand_id, account_id, payload_sha256, normalized_event,
        status, attempts, available_at, lease_owner, lease_expires_at, error_summary,
        received_at, updated_at, processed_at
      ) values (
        ${receipt.id}, ${receipt.provider}, ${receipt.workspaceId}, ${receipt.brandId}, ${receipt.accountId},
        ${receipt.payloadSha256}, ${this.sql.json(receipt.normalizedEvent as never)}, ${receipt.status}, ${receipt.attempts},
        ${receipt.availableAt}, ${receipt.leaseOwner ?? null}, ${receipt.leaseExpiresAt ?? null},
        ${receipt.lastError?.slice(0, 500) ?? null}, ${receipt.createdAt}, ${receipt.createdAt}, ${receipt.processedAt ?? null}
      )
      on conflict (provider, payload_sha256) do nothing
      returning *
    `;
    if (inserted[0]) return { receipt: mapReceipt(inserted[0]), created: true };
    const existing = await this.sql<ReceiptRow[]>`
      select * from provider_webhook_receipts
      where provider = ${receipt.provider} and payload_sha256 = ${receipt.payloadSha256}
      limit 1
    `;
    if (!existing[0]) throw new Error("The webhook receipt could not be safely recorded.");
    return { receipt: mapReceipt(existing[0]), created: false };
  }

  async claimWebhookReceipts(owner: string, limit = 25, leaseSeconds = 60): Promise<EngagementWebhookReceipt[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const boundedLeaseSeconds = Math.max(10, Math.min(leaseSeconds, 600));
    const rows = await this.sql<ReceiptRow[]>`
      with candidates as (
        select id
        from provider_webhook_receipts
        where available_at <= now()
          and (
            status = 'pending'
            or (status = 'processing' and lease_expires_at < now())
          )
        order by available_at asc, received_at asc, id asc
        for update skip locked
        limit ${boundedLimit}
      )
      update provider_webhook_receipts receipt set
        status = 'processing',
        attempts = receipt.attempts + 1,
        lease_owner = ${owner},
        lease_expires_at = now() + (${boundedLeaseSeconds} * interval '1 second'),
        updated_at = now(),
        error_code = null,
        error_summary = null
      from candidates
      where receipt.id = candidates.id
      returning receipt.*
    `;
    return rows.map(mapReceipt);
  }

  async completeWebhookReceipt(id: string, leaseOwner: string, processedAt: string): Promise<void> {
    await this.sql`
      update provider_webhook_receipts set
        status = 'processed',
        processed_at = ${processedAt},
        updated_at = ${processedAt},
        lease_owner = null,
        lease_expires_at = null,
        error_code = null,
        error_summary = null
      where id = ${id} and status = 'processing' and lease_owner = ${leaseOwner}
    `;
  }

  async failWebhookReceipt(id: string, leaseOwner: string, error: string, retryAt: string, maxAttempts = 10): Promise<void> {
    const boundedMaxAttempts = Math.max(1, Math.min(maxAttempts, 100));
    await this.sql`
      update provider_webhook_receipts set
        status = case when attempts >= ${boundedMaxAttempts} then 'failed' else 'pending' end,
        available_at = ${retryAt},
        updated_at = now(),
        lease_owner = null,
        lease_expires_at = null,
        error_code = 'processing_failed',
        error_summary = ${error.slice(0, 500)},
        processed_at = null
      where id = ${id} and status = 'processing' and lease_owner = ${leaseOwner}
    `;
  }
}
