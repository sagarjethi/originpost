import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { ContentItem, Platform, PublishTarget } from "./types.js";

export type ScheduleConflictKind = "exact_content_duplicate" | "account_time_overlap";

export interface ScheduleConflictRequest {
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  draftId: string;
  draftSha256: string;
  platform: Platform;
  accountId: string;
  scheduledFor: string;
  excludeTargetId?: string | undefined;
}

export interface ScheduleConflict {
  contentItemId: string;
  contentTitle: string;
  targetId: string;
  draftId: string;
  draftSha256: string;
  platform: Platform;
  accountId: string;
  scheduledFor: string;
  status: PublishTarget["status"];
  kinds: ScheduleConflictKind[];
  minutesApart: number;
}

export interface ScheduleConflictPreflight {
  request: ScheduleConflictRequest;
  windowMinutes: number;
  conflicts: ScheduleConflict[];
  acknowledgementSha256: string;
  requiresConfirmation: boolean;
}

export interface ScheduleConflictCommit {
  request: ScheduleConflictRequest;
  acknowledgementSha256?: string | undefined;
}

const activeStatuses = new Set<PublishTarget["status"]>(["pending", "queued", "action_required", "acknowledged", "publishing"]);

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedRequest(input: ScheduleConflictRequest): ScheduleConflictRequest {
  const at = new Date(input.scheduledFor);
  if (!Number.isFinite(at.getTime())) throw new DomainError("Choose a valid publishing time.", "scheduled_time_invalid", 400);
  return {
    workspaceId: input.workspaceId.trim(),
    brandId: input.brandId.trim(),
    contentItemId: input.contentItemId.trim(),
    draftId: input.draftId.trim(),
    draftSha256: input.draftSha256.trim().toLowerCase(),
    platform: input.platform,
    accountId: input.accountId.trim(),
    scheduledFor: at.toISOString(),
    ...(input.excludeTargetId ? { excludeTargetId: input.excludeTargetId.trim() } : {}),
  };
}

export function inspectScheduleConflicts(
  items: readonly ContentItem[],
  rawRequest: ScheduleConflictRequest,
  windowMinutes = 60,
): ScheduleConflictPreflight {
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 24 * 60) {
    throw new DomainError("The scheduling conflict window is invalid.", "schedule_conflict_window_invalid", 400);
  }
  const request = normalizedRequest(rawRequest);
  const requestedAt = new Date(request.scheduledFor).getTime();
  const conflicts: ScheduleConflict[] = [];

  for (const item of items) {
    if (item.workspaceId !== request.workspaceId || item.brandId !== request.brandId) continue;
    for (const target of item.targets) {
      if (target.id === request.excludeTargetId || target.accountId !== request.accountId || target.platform !== request.platform || !activeStatuses.has(target.status)) continue;
      const candidateAt = new Date(target.scheduledFor).getTime();
      if (!Number.isFinite(candidateAt)) continue;
      const draft = item.drafts.find((entry) => entry.id === target.draftId);
      if (!draft) continue;
      const kinds: ScheduleConflictKind[] = [];
      if (draft.contentSha256 === request.draftSha256) kinds.push("exact_content_duplicate");
      const minutesApart = Math.floor(Math.abs(candidateAt - requestedAt) / 60_000);
      if (Math.abs(candidateAt - requestedAt) < windowMinutes * 60_000) kinds.push("account_time_overlap");
      if (!kinds.length) continue;
      conflicts.push({
        contentItemId: item.id,
        contentTitle: item.title,
        targetId: target.id,
        draftId: draft.id,
        draftSha256: draft.contentSha256,
        platform: target.platform,
        accountId: target.accountId,
        scheduledFor: new Date(candidateAt).toISOString(),
        status: target.status,
        kinds,
        minutesApart,
      });
    }
  }

  conflicts.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor) || left.targetId.localeCompare(right.targetId));
  const acknowledgementSha256 = sha256({
    schema: "originpost.schedule-conflict-preflight.v1",
    request,
    windowMinutes,
    conflicts: conflicts.map((entry) => ({
      contentItemId: entry.contentItemId,
      targetId: entry.targetId,
      draftSha256: entry.draftSha256,
      scheduledFor: entry.scheduledFor,
      status: entry.status,
      kinds: entry.kinds,
    })),
  });
  return { request, windowMinutes, conflicts, acknowledgementSha256, requiresConfirmation: conflicts.length > 0 };
}

export function assertScheduleConflictAcknowledgement(preflight: ScheduleConflictPreflight, acknowledgementSha256?: string): void {
  if (!preflight.requiresConfirmation) return;
  if (acknowledgementSha256?.trim().toLowerCase() !== preflight.acknowledgementSha256) {
    throw new DomainError(
      "Review the current duplicate and timing warnings before scheduling.",
      "schedule_conflict_confirmation_required",
      409,
    );
  }
}
