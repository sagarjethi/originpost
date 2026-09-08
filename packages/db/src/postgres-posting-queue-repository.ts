import { assertScheduleConflictAcknowledgement, DomainError, inspectScheduleConflicts, queueOutboxMessage, resolvePostingQueue, scheduleTargetFromQueue, type AccountPostingQueueProfile, type AuditEvent, type ContentItem, type PostingQueuePreview, type PostingQueueRepository, type PostingQueueReservation, type PublishTarget, type ScheduleConflictCommit, type ScheduleNextQueueInput, type ScheduleTargetInput } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type ProfileRow = { payload: AccountPostingQueueProfile };
type ReservationRow = { payload: PostingQueueReservation };
type ContentRow = { payload: ContentItem; version: number; brand_id: string };

export class PostgresPostingQueueRepository implements PostingQueueRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, brandId: string): Promise<AccountPostingQueueProfile[]> {
    const rows = await this.sql<ProfileRow[]>`select payload from account_posting_queue_profiles where workspace_id=${workspaceId} and brand_id=${brandId} order by connected_account_id`;
    return rows.map((row) => row.payload);
  }
  async get(workspaceId: string, brandId: string, connectedAccountId: string): Promise<AccountPostingQueueProfile | null> {
    const rows = await this.sql<ProfileRow[]>`select payload from account_posting_queue_profiles where workspace_id=${workspaceId} and brand_id=${brandId} and connected_account_id=${connectedAccountId} limit 1`;
    return rows[0]?.payload ?? null;
  }
  async saveProfile(profile: AccountPostingQueueProfile, event: AuditEvent, expectedVersion = 0): Promise<AccountPostingQueueProfile> {
    await this.sql.begin(async (sql) => {
      const saved = expectedVersion === 0
        ? await sql<{ id: string }[]>`insert into account_posting_queue_profiles(id,workspace_id,brand_id,connected_account_id,platform,enabled,timezone,weekly_slots,version,payload,created_by,updated_by,created_at,updated_at) values(${profile.id},${profile.workspaceId},${profile.brandId},${profile.connectedAccountId},${profile.platform},${profile.enabled},${profile.timezone},${sql.json(profile.weeklySlots as never)},${profile.version},${sql.json(profile as never)},${profile.createdBy},${profile.updatedBy},${profile.createdAt},${profile.updatedAt}) on conflict(workspace_id,brand_id,connected_account_id) do nothing returning id`
        : await sql<{ id: string }[]>`update account_posting_queue_profiles set enabled=${profile.enabled},timezone=${profile.timezone},weekly_slots=${sql.json(profile.weeklySlots as never)},version=${profile.version},payload=${sql.json(profile as never)},updated_by=${profile.updatedBy},updated_at=${profile.updatedAt} where workspace_id=${profile.workspaceId} and brand_id=${profile.brandId} and connected_account_id=${profile.connectedAccountId} and version=${expectedVersion} returning id`;
      if (saved.length !== 1) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
      await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${event.workspaceId},null,${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt})`;
    });
    return profile;
  }
  private async previewWith(sql: Sql | TransactionSql, profile: AccountPostingQueueProfile, count: number, now?: string): Promise<PostingQueuePreview> {
    const clock = now ?? (await sql<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now.toISOString();
    const occupiedRows = await sql<{ scheduled_for: Date }[]>`select scheduled_for from publish_targets where workspace_id=${profile.workspaceId} and account_id=${profile.connectedAccountId} and status in ('pending','queued','action_required','acknowledged','publishing')`;
    return resolvePostingQueue(profile, clock, new Set(occupiedRows.map((row) => row.scheduled_for.toISOString())), count);
  }
  async preview(workspaceId: string, brandId: string, connectedAccountId: string, count = 7): Promise<PostingQueuePreview> {
    const profile = await this.get(workspaceId, brandId, connectedAccountId);
    if (!profile) throw new DomainError("Set up a posting queue for this account first.", "posting_queue_profile_not_found", 404);
    return this.previewWith(this.sql, profile, count);
  }
  async previewProfile(profile: AccountPostingQueueProfile, count = 7): Promise<PostingQueuePreview> {
    return this.previewWith(this.sql, profile, count);
  }
  async getReservationByIdempotency(workspaceId: string, idempotencyKey: string): Promise<PostingQueueReservation | null> {
    const rows = await this.sql<ReservationRow[]>`select payload from posting_queue_reservations where workspace_id=${workspaceId} and idempotency_key=${idempotencyKey} limit 1`;
    return rows[0]?.payload ?? null;
  }
  async scheduleNext(input: ScheduleNextQueueInput): Promise<{ item: ContentItem; target: PublishTarget; reservation: PostingQueueReservation; replayed: boolean }> {
    return this.sql.begin(async (sql) => {
      const replayRows = await sql<ReservationRow[]>`select payload from posting_queue_reservations where workspace_id=${input.workspaceId} and idempotency_key=${input.idempotencyKey} limit 1`;
      const replay = replayRows[0]?.payload;
      if (replay) {
        if (replay.requestSha256 !== input.requestSha256) throw new DomainError("This idempotency key was already used for a different queue request.", "idempotency_conflict", 409);
        const contentRows = await sql<ContentRow[]>`select payload,version,brand_id from content_items where workspace_id=${input.workspaceId} and id=${replay.contentItemId} limit 1`;
        const item = contentRows[0]?.payload;
        const target = item?.targets.find((entry) => entry.id === replay.targetId);
        if (!item || !target) throw new DomainError("The original queue reservation is unavailable.", "posting_queue_replay_unavailable", 409);
        return { item, target, reservation: replay, replayed: true };
      }
      await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.workspaceId, input.schedule.accountId])},0))`;
      const profileRows = await sql<ProfileRow[]>`select payload from account_posting_queue_profiles where workspace_id=${input.workspaceId} and brand_id=${input.brandId} and connected_account_id=${input.schedule.accountId} for update`;
      const profile = profileRows[0]?.payload;
      if (!profile) throw new DomainError("Set up a posting queue for this account first.", "posting_queue_profile_not_found", 404);
      if (profile.version !== input.expectedProfileVersion) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
      const contentRows = await sql<ContentRow[]>`select payload,version,brand_id from content_items where workspace_id=${input.workspaceId} and id=${input.contentItemId} and brand_id=${input.brandId} for update`;
      const row = contentRows[0];
      if (!row) throw new DomainError("Content item not found.", "not_found", 404);
      if (row.version !== input.expectedContentVersion) throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
      const now = (await sql<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now.toISOString();
      const preview = await this.previewWith(sql, profile, 1, now);
      const occurrence = preview.occurrences[0]!;
      if (input.latestAllowedAt && Date.parse(occurrence.scheduledFor) >= Date.parse(input.latestAllowedAt)) throw new DomainError("This account access expires before the next queue slot. Reconnect it first.", "connected_account_expires_before_publish", 409);
      const draft = row.payload.drafts.find((entry) => entry.id === input.schedule.draftId);
      if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
      const conflictRequest = {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        contentItemId: input.contentItemId,
        draftId: draft.id,
        draftSha256: draft.contentSha256,
        platform: input.schedule.platform,
        accountId: input.schedule.accountId,
        scheduledFor: occurrence.scheduledFor,
      } as const;
      const conflictRows = await sql<{ payload: ContentItem }[]>`select payload from content_items where workspace_id=${input.workspaceId} and brand_id=${input.brandId}`;
      const conflictPreflight = inspectScheduleConflicts(conflictRows.map((entry) => entry.payload), conflictRequest);
      assertScheduleConflictAcknowledgement(conflictPreflight, input.conflictAcknowledgementSha256);
      const reservationId = `queue_reservation_${crypto.randomUUID()}`;
      const targetId = `target_${crypto.randomUUID()}`;
      const scheduled = scheduleTargetFromQueue(row.payload, input.actor, { ...input.schedule, targetId, scheduledFor: occurrence.scheduledFor, timezone: profile.timezone } as ScheduleTargetInput, now);
      const target = scheduled.item.targets.find((entry) => entry.id === targetId)!;
      target.queueAssignment = { origin: "queue_assigned", reservationId, profileId: profile.id, profileVersion: profile.version, localDate: occurrence.localDate, localTime: occurrence.localTime, timezone: profile.timezone, utcOffset: occurrence.utcOffset };
      scheduled.event.detail = { ...scheduled.event.detail, queueReservationId: reservationId, queueProfileId: profile.id, queueProfileVersion: profile.version, localDate: occurrence.localDate, localTime: occurrence.localTime, timezone: profile.timezone, utcOffset: occurrence.utcOffset, ...(conflictPreflight.requiresConfirmation ? { scheduleConflictAcknowledgementSha256: conflictPreflight.acknowledgementSha256, scheduleConflictCount: conflictPreflight.conflicts.length } : {}) };
      const reservation: PostingQueueReservation = { id: reservationId, workspaceId: input.workspaceId, brandId: input.brandId, profileId: profile.id, profileVersion: profile.version, connectedAccountId: input.schedule.accountId, contentItemId: input.contentItemId, targetId, idempotencyKey: input.idempotencyKey, requestSha256: input.requestSha256, scheduledFor: occurrence.scheduledFor, localDate: occurrence.localDate, localTime: occurrence.localTime, timezone: profile.timezone, utcOffset: occurrence.utcOffset, createdBy: input.actor.id, createdAt: now };
      const committed = await sql<{ id: string }[]>`update content_items set version=${scheduled.item.version},status=${scheduled.item.status},payload=${sql.json(scheduled.item as never)},updated_at=${scheduled.item.updatedAt} where workspace_id=${input.workspaceId} and id=${input.contentItemId} and brand_id=${input.brandId} and version=${input.expectedContentVersion} returning id`;
      if (committed.length !== 1) throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
      await sql`insert into publish_targets(id,workspace_id,content_item_id,platform,account_id,scheduled_for,delivery_mode,notification_destination_id,action_required_at,acknowledged_at,acknowledged_by,status,payload) values(${target.id},${input.workspaceId},${input.contentItemId},${target.platform},${target.accountId},${target.scheduledFor},${target.deliveryMode},${target.notifyDestinationId ?? null},null,null,null,${target.status},${sql.json(target as never)})`;
      await sql`insert into posting_queue_reservations(id,workspace_id,brand_id,profile_id,profile_version,connected_account_id,content_item_id,target_id,idempotency_key,request_sha256,scheduled_for,local_date,local_time,timezone,utc_offset,created_by,created_at,payload) values(${reservation.id},${reservation.workspaceId},${reservation.brandId},${reservation.profileId},${reservation.profileVersion},${reservation.connectedAccountId},${reservation.contentItemId},${reservation.targetId},${reservation.idempotencyKey},${reservation.requestSha256},${reservation.scheduledFor},${reservation.localDate},${reservation.localTime},${reservation.timezone},${reservation.utcOffset},${reservation.createdBy},${reservation.createdAt},${sql.json(reservation as never)})`;
      await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${scheduled.event.id},${scheduled.event.workspaceId},${input.contentItemId},${scheduled.event.actorId},${scheduled.event.actorType},${scheduled.event.action},${sql.json({ ...scheduled.event.detail, contentVersion: scheduled.item.version } as never)},${scheduled.event.createdAt})`;
      const message = queueOutboxMessage(scheduled.item, target, now);
      await sql`insert into outbox_events(id,workspace_id,topic,dedupe_key,payload,available_at,created_at) values(${message.id},${message.workspaceId},${message.topic},${message.dedupeKey},${sql.json(message.payload as never)},${message.availableAt},${message.createdAt}) on conflict(workspace_id,dedupe_key) do nothing`;
      return { item: scheduled.item, target, reservation, replayed: false };
    });
  }
  async commitCancellation(item: ContentItem, event: AuditEvent, targetId: string, actorId: string): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const rows = await sql<{ id: string }[]>`select id from posting_queue_reservations where workspace_id=${item.workspaceId} and target_id=${targetId} and released_at is null for update`;
      if (!rows.length) return false;
      const committed = await sql<{ id: string }[]>`update content_items set version=${item.version},status=${item.status},payload=${sql.json(item as never)},updated_at=${item.updatedAt} where workspace_id=${item.workspaceId} and id=${item.id} and brand_id=${item.brandId} and version=${item.version - 1} returning id`;
      if (committed.length !== 1) throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
      const target = item.targets.find((entry) => entry.id === targetId);
      if (!target || target.status !== "cancelled") throw new DomainError("Queue target cancellation is invalid.", "target_not_cancellable", 409);
      await sql`update publish_targets set status='cancelled',payload=${sql.json(target as never)} where workspace_id=${item.workspaceId} and content_item_id=${item.id} and id=${targetId}`;
      await sql`update posting_queue_reservations set released_at=${item.updatedAt},released_by=${actorId},payload=jsonb_set(jsonb_set(payload,'{releasedAt}',to_jsonb(${item.updatedAt}::text),true),'{releasedBy}',to_jsonb(${actorId}::text),true) where workspace_id=${item.workspaceId} and target_id=${targetId} and released_at is null`;
      await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${event.workspaceId},${item.id},${event.actorId},${event.actorType},${event.action},${sql.json({ ...event.detail, contentVersion: item.version, queueReservationReleased: true } as never)},${event.createdAt})`;
      return true;
    });
  }
  async commitReschedule(item: ContentItem, event: AuditEvent, previousTargetId: string, replacement: PublishTarget, actorId: string, scheduleConflict: ScheduleConflictCommit): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([item.workspaceId, scheduleConflict.request.accountId])},0))`;
      const rows = await sql<{ id: string }[]>`select id from posting_queue_reservations where workspace_id=${item.workspaceId} and target_id=${previousTargetId} and released_at is null for update`;
      if (!rows.length) return false;
      const previous = item.targets.find((entry) => entry.id === previousTargetId);
      if (previous?.status !== "cancelled" || replacement.queueAssignment) throw new DomainError("Queue target reschedule is invalid.", "target_not_reschedulable", 409);
      const conflictRows = await sql<{ payload: ContentItem }[]>`select payload from content_items where workspace_id=${item.workspaceId} and brand_id=${item.brandId}`;
      const preflight = inspectScheduleConflicts(conflictRows.map((entry) => entry.payload), scheduleConflict.request);
      assertScheduleConflictAcknowledgement(preflight, scheduleConflict.acknowledgementSha256);
      const committed = await sql<{ id: string }[]>`update content_items set version=${item.version},status=${item.status},payload=${sql.json(item as never)},updated_at=${item.updatedAt} where workspace_id=${item.workspaceId} and id=${item.id} and brand_id=${item.brandId} and version=${item.version - 1} returning id`;
      if (committed.length !== 1) throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
      await sql`update publish_targets set status='cancelled',payload=${sql.json(previous as never)} where workspace_id=${item.workspaceId} and content_item_id=${item.id} and id=${previousTargetId}`;
      await sql`insert into publish_targets(id,workspace_id,content_item_id,platform,account_id,scheduled_for,delivery_mode,notification_destination_id,action_required_at,acknowledged_at,acknowledged_by,status,payload) values(${replacement.id},${item.workspaceId},${item.id},${replacement.platform},${replacement.accountId},${replacement.scheduledFor},${replacement.deliveryMode},${replacement.notifyDestinationId ?? null},null,null,null,${replacement.status},${sql.json(replacement as never)})`;
      await sql`update posting_queue_reservations set released_at=${item.updatedAt},released_by=${actorId},payload=jsonb_set(jsonb_set(payload,'{releasedAt}',to_jsonb(${item.updatedAt}::text),true),'{releasedBy}',to_jsonb(${actorId}::text),true) where workspace_id=${item.workspaceId} and target_id=${previousTargetId} and released_at is null`;
      await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${event.workspaceId},${item.id},${event.actorId},${event.actorType},${event.action},${sql.json({ ...event.detail, contentVersion: item.version, queueReservationReleased: true } as never)},${event.createdAt})`;
      const message = queueOutboxMessage(item, replacement, item.updatedAt);
      await sql`insert into outbox_events(id,workspace_id,topic,dedupe_key,payload,available_at,created_at) values(${message.id},${message.workspaceId},${message.topic},${message.dedupeKey},${sql.json(message.payload as never)},${message.availableAt},${message.createdAt}) on conflict(workspace_id,dedupe_key) do nothing`;
      return true;
    });
  }
}
