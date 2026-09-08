import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { assertScheduleConflictAcknowledgement, createAccountPostingQueueProfile, DomainError, postingQueueRequestSha256, scheduleSchema, type Actor, type ScheduleTargetInput } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { ContentService } from "../content/content.service.js";
import type { PostingQueueDraftPreviewDto, PostingQueueProfileDto, ScheduleNextDto } from "./posting-queue.dto.js";

@Injectable()
export class PostingQueueService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, private readonly content: ContentService, private readonly config: ConfigService) {}

  async list(workspaceId: string, brandId: string) {
    const [accounts, profiles] = await Promise.all([this.infrastructure.connectedAccountRepository.list(workspaceId, brandId), this.infrastructure.postingQueueRepository.list(workspaceId, brandId)]);
    return accounts.map(({ credentialRef: _credentialRef, ...account }) => ({ account, profile: profiles.find((profile) => profile.connectedAccountId === account.id) ?? null }));
  }
  async save(workspaceId: string, accountId: string, dto: PostingQueueProfileDto, actor: Actor) {
    if (actor.role !== "owner" && actor.role !== "manager") throw new ForbiddenException("Only owners and managers can change posting queues.");
    const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId);
    if (!account || account.brandId !== dto.brandId) throw new DomainError("Connected account not found for this brand.", "connected_account_not_found", 404);
    const current = await this.infrastructure.postingQueueRepository.get(workspaceId, dto.brandId, accountId);
    const result = createAccountPostingQueueProfile({ workspaceId, brandId: dto.brandId, account, enabled: dto.enabled, timezone: dto.timezone, weeklySlots: dto.weeklySlots, ...(dto.expectedVersion !== undefined ? { expectedVersion: dto.expectedVersion } : {}), actor }, current ?? undefined);
    return this.infrastructure.postingQueueRepository.saveProfile(result.profile, result.event, current?.version ?? 0);
  }
  preview(workspaceId: string, brandId: string, accountId: string, count: number) { return this.infrastructure.postingQueueRepository.preview(workspaceId, brandId, accountId, count); }
  async previewDraft(workspaceId: string, accountId: string, dto: PostingQueueDraftPreviewDto, actor: Actor) {
    if (actor.role !== "owner" && actor.role !== "manager") throw new ForbiddenException("Only owners and managers can preview unsaved posting queue changes.");
    const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId);
    if (!account || account.brandId !== dto.brandId) throw new DomainError("Connected account not found for this brand.", "connected_account_not_found", 404);
    const current = await this.infrastructure.postingQueueRepository.get(workspaceId, dto.brandId, accountId);
    const proposed = createAccountPostingQueueProfile({ workspaceId, brandId: dto.brandId, account, enabled: dto.enabled, timezone: dto.timezone, weeklySlots: dto.weeklySlots, ...(dto.expectedVersion !== undefined ? { expectedVersion: dto.expectedVersion } : {}), actor }, current ?? undefined).profile;
    return this.infrastructure.postingQueueRepository.previewProfile(proposed, dto.count);
  }

  async scheduleNext(workspaceId: string, contentItemId: string, dto: ScheduleNextDto, actor: Actor, expectedContentVersion: number | undefined, idempotencyKey: string) {
    if (!expectedContentVersion) throw new DomainError("Schedule-next requires the current Content Item version in If-Match.", "content_version_required", 428);
    const item = await this.content.get(workspaceId, contentItemId);
    if (item.brandId !== dto.brandId) throw new DomainError("This content belongs to another brand.", "content_brand_mismatch", 409);
    const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, dto.connectedAccountId);
    if (!account || account.brandId !== dto.brandId) throw new DomainError("Connected account not found for this brand.", "connected_account_not_found", 404);
    if (!["healthy", "expiring"].includes(account.status) && dto.deliveryMode === "auto_publish") throw new DomainError("Run Connection Doctor and fix this account before using its queue.", "connected_account_not_ready", 409);
    const preview = await this.infrastructure.postingQueueRepository.preview(workspaceId, dto.brandId, account.id, 1);
    if (preview.profile.version !== dto.expectedProfileVersion) throw new DomainError("This posting queue changed. Refresh and try again.", "posting_queue_version_conflict", 409);
    let settings: ScheduleTargetInput["settings"];
    if (account.platform === "instagram" && dto.instagramPublishApprovalId) {
      const candidate = await this.infrastructure.instagramCollaboratorRepository.getApprovedCandidate(workspaceId, contentItemId, dto.instagramPublishApprovalId);
      if (!candidate || candidate.accountId !== account.id || candidate.draftId !== dto.draftId) throw new DomainError("The approved Instagram publishing options do not match this target.", "instagram_collaborator_approval_required", 409);
      settings = candidate.settings;
    } else if (account.platform === "youtube") {
      if (!dto.settings) throw new DomainError("YouTube publishing settings are required.", "youtube_settings_required");
      const parsed = scheduleSchema.parse({ platform: "youtube", accountId: account.id, draftId: dto.draftId, scheduledFor: preview.occurrences[0]!.scheduledFor, timezone: preview.profile.timezone, deliveryMode: dto.deliveryMode, settings: dto.settings });
      settings = parsed.settings;
      const draft = item.drafts.find((entry) => entry.id === dto.draftId);
      if (!draft || dto.settings.title !== draft.title || dto.settings.description !== draft.caption) throw new DomainError("YouTube title and description must match the approved draft.", "youtube_settings_not_approved", 409);
      const allow = this.config.get<string | boolean>("YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING");
      const audited = this.config.get<string | boolean>("YOUTUBE_API_COMPLIANCE_AUDITED");
      if (dto.settings.privacyStatus !== "private" && (allow !== true && allow !== "true" || audited !== true && audited !== "true")) throw new DomainError("YouTube publishing is private by default.", "youtube_non_private_gate_required", 409);
    }
    const schedule = { platform: account.platform, accountId: account.id, draftId: dto.draftId, deliveryMode: dto.deliveryMode, ...(dto.notifyDestinationId ? { notifyDestinationId: dto.notifyDestinationId } : {}), ...(settings ? { settings } : {}) } as Omit<ScheduleTargetInput, "scheduledFor" | "timezone" | "targetId">;
    const draft = item.drafts.find((entry) => entry.id === dto.draftId);
    if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
    await this.content.validatePlatformDraft(workspaceId, item, draft, account.platform, account.id, (settings ?? {}) as Record<string, unknown>, dto.deliveryMode === "manual_handoff");
    const refreshableYouTube = account.platform === "youtube" && account.credentialRef?.startsWith("secret:");
    const latestAllowedAt = dto.deliveryMode === "auto_publish" && !refreshableYouTube ? account.expiresAt : undefined;
    const requestSha256 = postingQueueRequestSha256({ contentItemId, brandId: dto.brandId, draftId: dto.draftId, accountId: account.id, deliveryMode: dto.deliveryMode, notifyDestinationId: dto.notifyDestinationId ?? null, expectedProfileVersion: dto.expectedProfileVersion, instagramPublishApprovalId: dto.instagramPublishApprovalId ?? null, settings: settings ?? null });
    const replay = await this.infrastructure.postingQueueRepository.getReservationByIdempotency(workspaceId, idempotencyKey);
    if (replay) {
      if (replay.requestSha256 !== requestSha256) throw new DomainError("This idempotency key was already used for a different queue request.", "idempotency_conflict", 409);
      const replayItem = await this.content.get(workspaceId, replay.contentItemId);
      const replayTarget = replayItem.targets.find((entry) => entry.id === replay.targetId);
      if (!replayTarget) throw new DomainError("The original queue reservation is unavailable.", "posting_queue_replay_unavailable", 409);
      return { item: replayItem, target: replayTarget, reservation: replay, replayed: true };
    }
    const conflictPreflight = await this.content.schedulePreflight(workspaceId, contentItemId, { platform: account.platform, accountId: account.id, draftId: dto.draftId, scheduledFor: preview.occurrences[0]!.scheduledFor, timezone: preview.profile.timezone, deliveryMode: dto.deliveryMode }, expectedContentVersion);
    assertScheduleConflictAcknowledgement(conflictPreflight, dto.conflictAcknowledgementSha256);
    return this.infrastructure.postingQueueRepository.scheduleNext({ workspaceId, brandId: dto.brandId, contentItemId, expectedContentVersion, expectedProfileVersion: dto.expectedProfileVersion, idempotencyKey, requestSha256, actor, schedule, ...(latestAllowedAt ? { latestAllowedAt } : {}), ...(dto.conflictAcknowledgementSha256 ? { conflictAcknowledgementSha256: dto.conflictAcknowledgementSha256 } : {}) });
  }
}
