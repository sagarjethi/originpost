import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { Actor, AuditEvent, ConnectedAccount, ContentItem, ContentItemRepository, OutboxMessageInput, Platform, PublishTarget, ScheduleTargetInput } from "./types.js";
import { assertScheduleConflictAcknowledgement, inspectScheduleConflicts, type ScheduleConflictCommit } from "./schedule-conflicts.js";
import { scheduleTargetFromQueue } from "./workflow.js";

export const postingQueueWeekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type PostingQueueWeekday = typeof postingQueueWeekdays[number];
export type PostingQueueSlots = Record<PostingQueueWeekday, readonly string[]>;

export interface AccountPostingQueueProfile {
  id: string;
  workspaceId: string;
  brandId: string;
  connectedAccountId: string;
  platform: Platform;
  enabled: boolean;
  timezone: string;
  weeklySlots: PostingQueueSlots;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostingQueueOccurrence {
  localDate: string;
  localTime: string;
  timezone: string;
  scheduledFor: string;
  utcOffset: string;
  profileVersion: number;
  occupied: boolean;
  notes: readonly ("occupied" | "dst_gap_skipped" | "dst_ambiguous_earlier_offset")[];
}

export interface PostingQueuePreview {
  profile: AccountPostingQueueProfile;
  occurrences: PostingQueueOccurrence[];
  skipped: Array<{ localDate: string; localTime: string; reason: "occupied" | "dst_gap_skipped" }>;
  generatedAt: string;
}

export interface PostingQueueReservation {
  id: string;
  workspaceId: string;
  brandId: string;
  profileId: string;
  profileVersion: number;
  connectedAccountId: string;
  contentItemId: string;
  targetId: string;
  idempotencyKey: string;
  requestSha256: string;
  scheduledFor: string;
  localDate: string;
  localTime: string;
  timezone: string;
  utcOffset: string;
  createdBy: string;
  createdAt: string;
  releasedAt?: string;
  releasedBy?: string;
}

export interface SavePostingQueueProfileInput {
  workspaceId: string;
  brandId: string;
  account: ConnectedAccount;
  enabled: boolean;
  timezone: string;
  weeklySlots: Record<string, readonly string[]>;
  expectedVersion?: number;
  actor: Actor;
  now?: string;
}

export interface ScheduleNextQueueInput {
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  expectedContentVersion: number;
  expectedProfileVersion: number;
  idempotencyKey: string;
  requestSha256: string;
  actor: Actor;
  schedule: Omit<ScheduleTargetInput, "scheduledFor" | "timezone" | "targetId">;
  latestAllowedAt?: string;
  conflictAcknowledgementSha256?: string;
}

export interface PostingQueueRepository {
  list(workspaceId: string, brandId: string): Promise<AccountPostingQueueProfile[]>;
  get(workspaceId: string, brandId: string, connectedAccountId: string): Promise<AccountPostingQueueProfile | null>;
  saveProfile(profile: AccountPostingQueueProfile, event: AuditEvent, expectedVersion?: number): Promise<AccountPostingQueueProfile>;
  preview(workspaceId: string, brandId: string, connectedAccountId: string, count?: number): Promise<PostingQueuePreview>;
  previewProfile(profile: AccountPostingQueueProfile, count?: number): Promise<PostingQueuePreview>;
  getReservationByIdempotency(workspaceId: string, idempotencyKey: string): Promise<PostingQueueReservation | null>;
  scheduleNext(input: ScheduleNextQueueInput): Promise<{ item: ContentItem; target: PublishTarget; reservation: PostingQueueReservation; replayed: boolean }>;
  commitCancellation(item: ContentItem, event: AuditEvent, targetId: string, actorId: string): Promise<boolean>;
  commitReschedule(item: ContentItem, event: AuditEvent, previousTargetId: string, replacement: PublishTarget, actorId: string, scheduleConflict: ScheduleConflictCommit): Promise<boolean>;
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

const wallTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function normalizePostingQueueSlots(input: Record<string, readonly string[]>): PostingQueueSlots {
  const unknown = Object.keys(input).filter((key) => !postingQueueWeekdays.includes(key as PostingQueueWeekday));
  if (unknown.length) throw new DomainError(`Unsupported queue weekday: ${unknown[0]}.`, "posting_queue_weekday_invalid");
  return Object.fromEntries(postingQueueWeekdays.map((day) => {
    const values = input[day] ?? [];
    if (!Array.isArray(values) || values.length > 24) throw new DomainError(`Use no more than 24 posting times on ${day}.`, "posting_queue_slots_invalid");
    const normalized = [...new Set(values.map((value) => String(value).trim()))].sort();
    if (normalized.some((value) => !wallTimePattern.test(value))) throw new DomainError(`Use 24-hour HH:mm posting times on ${day}.`, "posting_queue_time_invalid");
    return [day, normalized];
  })) as unknown as PostingQueueSlots;
}

export function createAccountPostingQueueProfile(input: SavePostingQueueProfileInput, current?: AccountPostingQueueProfile): { profile: AccountPostingQueueProfile; event: AuditEvent } {
  if (input.actor.role !== "owner" && input.actor.role !== "manager") throw new DomainError("Only owners and managers can change posting queues.", "permission_denied", 403);
  if (input.account.workspaceId !== input.workspaceId || input.account.brandId !== input.brandId) throw new DomainError("This account belongs to another workspace or brand.", "posting_queue_account_scope_mismatch", 409);
  const timezone = input.timezone.trim();
  if (!validTimezone(timezone)) throw new DomainError("Use a valid IANA time zone, such as Asia/Kolkata.", "posting_queue_timezone_invalid");
  const weeklySlots = normalizePostingQueueSlots(input.weeklySlots);
  if (input.enabled && !Object.values(weeklySlots).some((slots) => slots.length)) throw new DomainError("An enabled posting queue needs at least one weekly time.", "posting_queue_slots_required");
  if (current && (current.workspaceId !== input.workspaceId || current.brandId !== input.brandId || current.connectedAccountId !== input.account.id)) throw new DomainError("Posting queue lineage does not match this account.", "posting_queue_account_scope_mismatch", 409);
  if (current && input.expectedVersion !== current.version) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
  if (!current && input.expectedVersion !== undefined && input.expectedVersion !== 0) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
  const now = input.now ?? new Date().toISOString();
  const profile: AccountPostingQueueProfile = {
    id: current?.id ?? `queue_profile_${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    connectedAccountId: input.account.id,
    platform: input.account.platform,
    enabled: input.enabled,
    timezone,
    weeklySlots,
    version: (current?.version ?? 0) + 1,
    createdBy: current?.createdBy ?? input.actor.id,
    updatedBy: input.actor.id,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  return { profile, event: { id: `audit_${crypto.randomUUID()}`, workspaceId: input.workspaceId, actorId: input.actor.id, actorType: "human", action: current ? "posting-queue.profile-updated" : "posting-queue.profile-created", detail: { profileId: profile.id, connectedAccountId: profile.connectedAccountId, platform: profile.platform, version: profile.version, enabled: profile.enabled, timezone: profile.timezone, weeklySlots: profile.weeklySlots }, createdAt: now } };
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number };
function zonedParts(value: number | string, timezone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}
function offsetMinutes(instant: number, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(instant / 60000) * 60000) / 60000);
}
function wallCandidates(localDate: string, localTime: string, timezone: string): number[] {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const offsets = new Set([offsetMinutes(desired - 12 * 3600000, timezone), offsetMinutes(desired, timezone), offsetMinutes(desired + 12 * 3600000, timezone)]);
  return [...offsets].map((offset) => desired - offset * 60000).filter((instant) => {
    const actual = zonedParts(instant, timezone);
    return actual.year === year && actual.month === month && actual.day === day && actual.hour === hour && actual.minute === minute;
  }).sort((left, right) => left - right);
}
function offsetLabel(instant: number, timezone: string): string {
  const minutes = offsetMinutes(instant, timezone);
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
function localDateAt(value: number, timezone: string): string {
  const parts = zonedParts(value, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function resolvePostingQueue(profile: AccountPostingQueueProfile, now: string, occupiedInstants: ReadonlySet<string>, count = 7, maxDays = 366): PostingQueuePreview {
  if (!profile.enabled) throw new DomainError("This posting queue is disabled.", "posting_queue_disabled", 409);
  const wanted = Math.min(Math.max(Math.trunc(count), 1), 30);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new DomainError("Queue clock is invalid.", "posting_queue_clock_invalid", 500);
  const start = localDateAt(nowMs, profile.timezone);
  const startParts = start.split("-").map(Number);
  const cursor = new Date(Date.UTC(startParts[0]!, startParts[1]! - 1, startParts[2]!));
  const occurrences: PostingQueueOccurrence[] = [];
  const skipped: PostingQueuePreview["skipped"] = [];
  for (let dayOffset = 0; dayOffset < maxDays && occurrences.length < wanted; dayOffset += 1) {
    const localDate = cursor.toISOString().slice(0, 10);
    const weekday = postingQueueWeekdays[(cursor.getUTCDay() + 6) % 7]!;
    for (const localTime of profile.weeklySlots[weekday]) {
      const candidates = wallCandidates(localDate, localTime, profile.timezone);
      if (!candidates.length) { skipped.push({ localDate, localTime, reason: "dst_gap_skipped" }); continue; }
      const instant = candidates[0]!;
      if (instant <= nowMs) continue;
      const scheduledFor = new Date(instant).toISOString();
      const occupied = occupiedInstants.has(scheduledFor);
      if (occupied) { skipped.push({ localDate, localTime, reason: "occupied" }); continue; }
      occurrences.push({ localDate, localTime, timezone: profile.timezone, scheduledFor, utcOffset: offsetLabel(instant, profile.timezone), profileVersion: profile.version, occupied: false, notes: candidates.length > 1 ? ["dst_ambiguous_earlier_offset"] : [] });
      if (occurrences.length >= wanted) break;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (!occurrences.length) throw new DomainError("No free posting time was found within the 12-month queue horizon.", "posting_queue_horizon_exhausted", 409);
  return { profile, occurrences, skipped, generatedAt: new Date(nowMs).toISOString() };
}

export function postingQueueRequestSha256(input: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

export function queueOutboxMessage(item: ContentItem, target: PublishTarget, now: string): OutboxMessageInput {
  return { id: `outbox_${crypto.randomUUID()}`, workspaceId: item.workspaceId, topic: "publish.target.requested", dedupeKey: `publish-target:${target.id}`, payload: { workspaceId: item.workspaceId, contentItemId: item.id, targetId: target.id }, availableAt: target.scheduledFor, createdAt: now };
}

export class InMemoryPostingQueueRepository implements PostingQueueRepository {
  private readonly profiles = new Map<string, AccountPostingQueueProfile>();
  private readonly reservations = new Map<string, PostingQueueReservation>();
  private readonly idempotency = new Map<string, PostingQueueReservation>();
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly content: ContentItemRepository, private readonly clock: () => Date = () => new Date()) {}

  private key(workspaceId: string, brandId: string, accountId: string) { return `${workspaceId}\u0000${brandId}\u0000${accountId}`; }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  async list(workspaceId: string, brandId: string): Promise<AccountPostingQueueProfile[]> {
    return [...this.profiles.values()].filter((profile) => profile.workspaceId === workspaceId && profile.brandId === brandId).sort((a, b) => a.connectedAccountId.localeCompare(b.connectedAccountId)).map((profile) => structuredClone(profile));
  }
  async get(workspaceId: string, brandId: string, connectedAccountId: string): Promise<AccountPostingQueueProfile | null> {
    const value = this.profiles.get(this.key(workspaceId, brandId, connectedAccountId));
    return value ? structuredClone(value) : null;
  }
  async saveProfile(profile: AccountPostingQueueProfile, _event: AuditEvent, expectedVersion?: number): Promise<AccountPostingQueueProfile> {
    return this.locked(async () => {
      const key = this.key(profile.workspaceId, profile.brandId, profile.connectedAccountId);
      const current = this.profiles.get(key);
      if ((current?.version ?? 0) !== (expectedVersion ?? 0) || profile.version !== (current?.version ?? 0) + 1) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
      this.profiles.set(key, structuredClone(profile));
      return structuredClone(profile);
    });
  }
  private async previewWith(profile: AccountPostingQueueProfile, count: number, now: string): Promise<PostingQueuePreview> {
    const items = await this.content.list(profile.workspaceId, profile.brandId);
    const active = new Set(items.flatMap((item) => item.targets.filter((target) => target.accountId === profile.connectedAccountId && ["pending", "queued", "action_required", "acknowledged", "publishing"].includes(target.status)).map((target) => target.scheduledFor)));
    for (const reservation of this.reservations.values()) if (reservation.profileId === profile.id && !reservation.releasedAt) active.add(reservation.scheduledFor);
    return resolvePostingQueue(profile, now, active, count);
  }
  async preview(workspaceId: string, brandId: string, connectedAccountId: string, count = 7): Promise<PostingQueuePreview> {
    const profile = await this.get(workspaceId, brandId, connectedAccountId);
    if (!profile) throw new DomainError("Set up a posting queue for this account first.", "posting_queue_profile_not_found", 404);
    return this.previewWith(profile, count, this.clock().toISOString());
  }
  async previewProfile(profile: AccountPostingQueueProfile, count = 7): Promise<PostingQueuePreview> {
    return this.previewWith(profile, count, this.clock().toISOString());
  }
  async getReservationByIdempotency(workspaceId: string, idempotencyKey: string): Promise<PostingQueueReservation | null> {
    const value = this.idempotency.get(`${workspaceId}\u0000${idempotencyKey}`);
    return value ? structuredClone(value) : null;
  }
  async scheduleNext(input: ScheduleNextQueueInput): Promise<{ item: ContentItem; target: PublishTarget; reservation: PostingQueueReservation; replayed: boolean }> {
    return this.locked(async () => {
      const replay = this.idempotency.get(`${input.workspaceId}\u0000${input.idempotencyKey}`);
      if (replay) {
        if (replay.requestSha256 !== input.requestSha256) throw new DomainError("This idempotency key was already used for a different queue request.", "idempotency_conflict", 409);
        const item = await this.content.get(input.workspaceId, replay.contentItemId);
        const target = item?.targets.find((entry) => entry.id === replay.targetId);
        if (!item || !target) throw new DomainError("The original queue reservation is unavailable.", "posting_queue_replay_unavailable", 409);
        return { item, target, reservation: structuredClone(replay), replayed: true };
      }
      const profile = await this.get(input.workspaceId, input.brandId, input.schedule.accountId);
      if (!profile) throw new DomainError("Set up a posting queue for this account first.", "posting_queue_profile_not_found", 404);
      if (profile.version !== input.expectedProfileVersion) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
      const now = this.clock().toISOString();
      const preview = await this.previewWith(profile, 1, now);
      const occurrence = preview.occurrences[0]!;
      if (input.latestAllowedAt && Date.parse(occurrence.scheduledFor) >= Date.parse(input.latestAllowedAt)) throw new DomainError("This account access expires before the next queue slot. Reconnect it first.", "connected_account_expires_before_publish", 409);
      const item = await this.content.get(input.workspaceId, input.contentItemId);
      if (!item || item.brandId !== input.brandId) throw new DomainError("Content item not found.", "not_found", 404);
      if (item.version !== input.expectedContentVersion) throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
      const draft = item.drafts.find((entry) => entry.id === input.schedule.draftId);
      if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
      const conflictRequest = {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        contentItemId: item.id,
        draftId: draft.id,
        draftSha256: draft.contentSha256,
        platform: input.schedule.platform,
        accountId: input.schedule.accountId,
        scheduledFor: occurrence.scheduledFor,
      } as const;
      const conflictPreflight = inspectScheduleConflicts(await this.content.list(input.workspaceId, input.brandId), conflictRequest);
      assertScheduleConflictAcknowledgement(conflictPreflight, input.conflictAcknowledgementSha256);
      const reservationId = `queue_reservation_${crypto.randomUUID()}`;
      const targetId = `target_${crypto.randomUUID()}`;
      const scheduled = scheduleTargetFromQueue(item, input.actor, { ...input.schedule, targetId, scheduledFor: occurrence.scheduledFor, timezone: profile.timezone } as ScheduleTargetInput, now);
      const target = scheduled.item.targets.find((entry) => entry.id === targetId)!;
      target.queueAssignment = { origin: "queue_assigned", reservationId, profileId: profile.id, profileVersion: profile.version, localDate: occurrence.localDate, localTime: occurrence.localTime, timezone: profile.timezone, utcOffset: occurrence.utcOffset };
      scheduled.event.detail = { ...scheduled.event.detail, queueReservationId: reservationId, queueProfileId: profile.id, queueProfileVersion: profile.version, localDate: occurrence.localDate, localTime: occurrence.localTime, timezone: profile.timezone, utcOffset: occurrence.utcOffset, ...(conflictPreflight.requiresConfirmation ? { scheduleConflictAcknowledgementSha256: conflictPreflight.acknowledgementSha256, scheduleConflictCount: conflictPreflight.conflicts.length } : {}) };
      const reservation: PostingQueueReservation = { id: reservationId, workspaceId: input.workspaceId, brandId: input.brandId, profileId: profile.id, profileVersion: profile.version, connectedAccountId: input.schedule.accountId, contentItemId: item.id, targetId, idempotencyKey: input.idempotencyKey, requestSha256: input.requestSha256, scheduledFor: occurrence.scheduledFor, localDate: occurrence.localDate, localTime: occurrence.localTime, timezone: profile.timezone, utcOffset: occurrence.utcOffset, createdBy: input.actor.id, createdAt: now };
      await this.content.commit(scheduled.item, scheduled.event, [queueOutboxMessage(scheduled.item, target, now)], [], [], { request: conflictRequest, ...(input.conflictAcknowledgementSha256 ? { acknowledgementSha256: input.conflictAcknowledgementSha256 } : {}) });
      this.reservations.set(reservation.id, structuredClone(reservation));
      this.idempotency.set(`${input.workspaceId}\u0000${input.idempotencyKey}`, structuredClone(reservation));
      return { item: scheduled.item, target, reservation, replayed: false };
    });
  }
  async commitCancellation(item: ContentItem, event: AuditEvent, targetId: string, actorId: string): Promise<boolean> {
    return this.locked(async () => {
      const reservation = [...this.reservations.values()].find((entry) => entry.workspaceId === item.workspaceId && entry.targetId === targetId && !entry.releasedAt);
      if (!reservation) return false;
      await this.content.commit(item, event);
      reservation.releasedAt = item.updatedAt;
      reservation.releasedBy = actorId;
      this.reservations.set(reservation.id, reservation);
      return true;
    });
  }
  async commitReschedule(item: ContentItem, event: AuditEvent, previousTargetId: string, replacement: PublishTarget, actorId: string, scheduleConflict: ScheduleConflictCommit): Promise<boolean> {
    return this.locked(async () => {
      const reservation = [...this.reservations.values()].find((entry) => entry.workspaceId === item.workspaceId && entry.targetId === previousTargetId && !entry.releasedAt);
      if (!reservation) return false;
      const previous = item.targets.find((entry) => entry.id === previousTargetId);
      if (previous?.status !== "cancelled" || replacement.queueAssignment) throw new DomainError("Queue target reschedule is invalid.", "target_not_reschedulable", 409);
      await this.content.commit(item, event, [queueOutboxMessage(item, replacement, item.updatedAt)], [], [], scheduleConflict);
      reservation.releasedAt = item.updatedAt;
      reservation.releasedBy = actorId;
      this.reservations.set(reservation.id, reservation);
      return true;
    });
  }
}
