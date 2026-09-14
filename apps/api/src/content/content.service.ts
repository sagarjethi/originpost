import { ForbiddenException, Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InstagramOfficialConnector, type ConnectorMedia } from "@originpost/connectors";
import {
  acknowledgeManualHandoff, addDraft, addDraftSchema, addExternalReviewComment, addReviewComment, addSource, addSourceSchema, approvalSchema, calendarScheduleCsv, can, collaboratorInviteProof, confirmManualPublication, confirmProviderPublication,
  assertScheduleConflictAcknowledgement, cancelTarget, createContentItem, createContentItemSchema, createNotification, createOutboxMessage, createReviewLink as createDomainReviewLink, DomainError, inspectScheduleConflicts, recordApproval, rescheduleTarget, rescheduleTargetSchema, revokeReviewLink as revokeDomainReviewLink, scheduleSchema, scheduleTarget, startResearch, startResearchSchema, transition, transitionSchema, validateMeasuredMedia,
  type SourceEvidence, type Actor, type ContentItem, type InstagramPublishSettings, type OutboxMessageInput, type PlatformDraft, type ProviderPublishOperation, type ScheduleConflictPreflight,
} from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import { resolveActiveBrand } from "../common/brand-context.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { AddDraftDto, AddSourceDto, AgentDraftDto, ApprovalDto, CreateContentDto, CreateReviewLinkDto, ExternalReviewCommentDto, ManualPublishConfirmationDto, ResearchDto, RescheduleTargetDto, ReviewCommentDto, ScheduleDto, ScheduleExportQueryDto, SchedulePreflightDto, TransitionDto } from "./dto/content.dto.js";
import { ReviewTokenService, type ReviewTokenPayload } from "./review-token.service.js";
import { AgentRuntimeService } from "../agent-runtimes/agent-runtime.service.js";
import { assertInstagramProviderUrl } from "./instagram-provider-url.js";

@Injectable()
export class ContentService implements OnModuleInit {
  private readonly logger = new Logger(ContentService.name);
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly reviewTokens: ReviewTokenService,
    private readonly config: ConfigService,
    private readonly agentRuntimes: AgentRuntimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.infrastructure.repository.list("default");
    if (existing.length) return;
    const actor: Actor = { id: "originpost-agent", name: "OriginPost Agent", role: "owner" };
    const created = createContentItem({ workspaceId: "default", title: "Local climate update needs review", summary: "A monitored suggestion is waiting for a source and editor decision.", actor, researchDepth: "standard", riskLevel: "medium" });
    await this.infrastructure.repository.commit(created.item, { ...created.event, actorType: "agent" });
  }

  list(workspaceId: string, brandId?: string) { return this.infrastructure.repository.list(workspaceId, brandId) }
  audit(workspaceId: string, id: string) { return this.infrastructure.repository.listAudit(workspaceId, id) }

  async exportSchedule(workspaceId: string, query: ScheduleExportQueryDto, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot export this publishing schedule.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, query.brandId);
    const [items, accounts] = await Promise.all([
      this.infrastructure.repository.list(workspaceId, brandId),
      this.infrastructure.connectedAccountRepository.list(workspaceId, brandId),
    ]);
    const accountDisplayNames = new Map(accounts.map((account) => [account.id, account.displayName]));
    return {
      fileName: `originpost-calendar-${query.month}.csv`,
      csv: calendarScheduleCsv(items, accountDisplayNames, {
        workspaceId,
        brandId,
        month: query.month,
        timeZone: query.timeZone,
        platform: query.platform,
        status: query.status,
      }),
    };
  }

  async get(workspaceId: string, id: string): Promise<ContentItem> {
    const item = await this.infrastructure.repository.get(workspaceId, id);
    if (!item) throw new DomainError("Content item not found.", "not_found", 404);
    return item;
  }

  private async getForUpdate(workspaceId: string, id: string, expectedVersion?: number): Promise<ContentItem> {
    const item = await this.get(workspaceId, id);
    if (expectedVersion !== undefined && item.version !== expectedVersion) {
      throw new DomainError("This content changed while you were working. Refresh it and try again.", "content_version_conflict", 409);
    }
    return item;
  }

  private async save(result: { item: ContentItem; event: Parameters<OriginPostInfrastructure["repository"]["commit"]>[1] }, outbox: OutboxMessageInput[] = [], providerOperations: ProviderPublishOperation[] = []) {
    await this.infrastructure.repository.commit(result.item, result.event, outbox, providerOperations);
    return result.item;
  }

  private async inspectConflicts(item: ContentItem, input: { platform: "instagram" | "facebook" | "youtube"; accountId: string; draftId: string; scheduledFor: string }, excludeTargetId?: string): Promise<ScheduleConflictPreflight> {
    const draft = item.drafts.find((entry) => entry.id === input.draftId);
    if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
    if (draft.platform !== input.platform) throw new DomainError("The publish target platform must match the draft platform.", "draft_platform_mismatch", 409);
    const items = await this.infrastructure.repository.list(item.workspaceId, item.brandId);
    return inspectScheduleConflicts(items, {
      workspaceId: item.workspaceId,
      brandId: item.brandId,
      contentItemId: item.id,
      draftId: draft.id,
      draftSha256: draft.contentSha256,
      platform: input.platform,
      accountId: input.accountId,
      scheduledFor: input.scheduledFor,
      ...(excludeTargetId ? { excludeTargetId } : {}),
    });
  }

  async schedulePreflight(workspaceId: string, id: string, dto: SchedulePreflightDto, expectedVersion?: number) {
    const item = await this.getForUpdate(workspaceId, id, expectedVersion);
    return this.inspectConflicts(item, dto, dto.excludeTargetId);
  }

  private async queueInitialAnalytics(item: ContentItem): Promise<void> {
    const proof = item.proofs.at(-1);
    if (!proof) return;
    if (proof.platform === "instagram" && proof.collaboratorInviteProof?.requestState === "requested_unverified") {
      await this.infrastructure.instagramCollaboratorRepository.createPollFromStoredProof(item.workspaceId, item.id, proof.id, {
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        maxAttempts: 20,
      });
    }
    if (!this.infrastructure.analyticsQueue) return;
    if (proof.platform !== "instagram" && proof.platform !== "facebook" && proof.platform !== "youtube") return;
    await this.infrastructure.analyticsQueue.add("capture-proof", { workspaceId: item.workspaceId, contentItemId: item.id, proofId: proof.id }, {
      jobId: `analytics-${proof.id}-initial`,
      delay: proof.platform === "facebook" ? 24 * 60 * 60_000 : 30_000,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async create(dto: CreateContentDto, actor: Actor) {
    const parsed = createContentItemSchema.parse(dto);
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, parsed.workspaceId, parsed.brandId);
    return this.save(createContentItem({ ...parsed, brandId, actor }));
  }

  /** Internal source-desk handoff. Discovery is a lead, never verified copy or media permission. */
  async createWithDiscoveredSources(dto: CreateContentDto, sources: SourceEvidence[], actor: Actor) {
    const parsed = createContentItemSchema.parse(dto);
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, parsed.workspaceId, parsed.brandId);
    const result = createContentItem({ ...parsed, brandId, actor });
    result.item.sources = structuredClone(sources).map(source => ({ ...source, rights: "reference-only" as const, confidence: 0 }));
    result.event.detail = { ...result.event.detail, discoveredSourceIds: sources.map(source => source.id) };
    return this.save(result);
  }

  async addSource(workspaceId: string, id: string, dto: AddSourceDto, actor: Actor, expectedVersion?: number) {
    return this.save(addSource(await this.getForUpdate(workspaceId, id, expectedVersion), addSourceSchema.parse(dto), actor));
  }

  async startResearch(workspaceId: string, id: string, dto: ResearchDto, actor: Actor, expectedVersion?: number) {
    if (!this.infrastructure.researchQueue) throw new ServiceUnavailableException("Redis is required to run source research.");
    const result = startResearch(await this.getForUpdate(workspaceId, id, expectedVersion), startResearchSchema.parse(dto), actor);
    const saved = await this.save(result);
    await this.infrastructure.researchQueue.add("research-content-item", { workspaceId, contentItemId: id, researchRunId: result.run.id }, {
      jobId: result.run.id, attempts: 3, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000,
    });
    return saved;
  }

  async addDraft(workspaceId: string, id: string, dto: AddDraftDto, actor: Actor, expectedVersion?: number) {
    const item = await this.getForUpdate(workspaceId, id, expectedVersion);
    const parsed = addDraftSchema.parse(dto);
    const assets = await Promise.all(parsed.mediaIds.map((mediaId) => this.infrastructure.mediaRepository.get(workspaceId, mediaId)));
    const containsSyntheticMedia = assets.some((asset) => asset?.syntheticLineage?.kind === "ai-generation");
    return this.save(addDraft(item, { ...parsed, ...(containsSyntheticMedia ? { containsSyntheticMedia: true } : {}) }, actor));
  }

  async agentDraft(workspaceId: string, id: string, dto: AgentDraftDto, actor: Actor, expectedVersion?: number) {
    const item = await this.getForUpdate(workspaceId, id, expectedVersion);
    const sources = item.sources.length ? item.sources.map((source, index) => `${index + 1}. ${source.title}${source.publisher ? ` — ${source.publisher}` : ""}${source.url ? ` (${source.url})` : ""}`).join("\n") : "No verified sources are attached. Do not invent facts.";
    const result = await this.agentRuntimes.runDraft({workspaceId,brandId:item.brandId,contentItemId:id,actor,
      messages: [
        { role: "system", content: "You are the OriginPost content assistant. Use only supplied facts and sources. Write simple language. Return only the finished caption, with a short hook and neutral question." },
        { role: "user", content: `Create a ${dto.platform} ${dto.format} caption in ${dto.language}.\nTitle: ${item.title}\nSummary: ${item.summary}\nSources:\n${sources}${dto.instruction ? `\nInstruction: ${dto.instruction}` : ""}` },
      ],
    });
    return this.save(addDraft(item, { platform: dto.platform, format: dto.format, title: item.title, caption: result.text, mediaIds: [] }, actor));
  }

  async transition(workspaceId: string, id: string, dto: TransitionDto, actor: Actor, expectedVersion?: number) {
    const input = transitionSchema.parse(dto);
    const saved = await this.save(transition(await this.getForUpdate(workspaceId, id, expectedVersion), input.to, actor, input.reason));
    if (input.to === "review") {
      const draft = saved.drafts.at(-1);
      if (draft) await this.infrastructure.notificationRepository.create(createNotification({
        workspaceId,
        kind: "approval_needed",
        severity: "warning",
        title: "Draft is ready for review",
        body: `“${saved.title}” has a new ${draft.platform} revision waiting for a human decision.`,
        dedupeKey: `content:${saved.id}:draft:${draft.id}:approval-needed`,
        contentItemId: saved.id,
        actionUrl: `/?module=Content&item=${encodeURIComponent(saved.id)}`,
      })).catch((error) => this.logger.error("Could not create approval notification", error));
    }
    return saved;
  }

  async approve(workspaceId: string, id: string, dto: ApprovalDto, actor: Actor, expectedVersion?: number) {
    const input = approvalSchema.parse(dto);
    const saved = await this.save(recordApproval(await this.getForUpdate(workspaceId, id, expectedVersion), actor, input.decision, input.note, input.draftId));
    if (input.decision !== "approved") {
      const draftId = input.draftId ?? saved.drafts.at(-1)?.id;
      if (draftId) await this.infrastructure.notificationRepository.create(createNotification({
        workspaceId,
        kind: "action_required",
        severity: "warning",
        title: input.decision === "rejected" ? "Draft was rejected" : "Draft needs changes",
        body: input.note?.trim() || `“${saved.title}” needs an update before it can be approved and scheduled.`,
        dedupeKey: `content:${saved.id}:draft:${draftId}:decision:${input.decision}`,
        contentItemId: saved.id,
        actionUrl: `/?module=Content&item=${encodeURIComponent(saved.id)}`,
      })).catch((error) => this.logger.error("Could not create review notification", error));
    }
    return saved;
  }

  async comment(workspaceId: string, id: string, dto: ReviewCommentDto, actor: Actor, expectedVersion?: number) {
    return this.save(addReviewComment(await this.getForUpdate(workspaceId, id, expectedVersion), actor, dto));
  }

  async createReviewLink(workspaceId: string, id: string, dto: CreateReviewLinkDto, actor: Actor, expectedVersion?: number) {
    const expiresAt = new Date(Date.now() + dto.expiresInHours * 60 * 60 * 1000).toISOString();
    const result = createDomainReviewLink(await this.getForUpdate(workspaceId, id, expectedVersion), actor, { draftId: dto.draftId, expiresAt, allowComment: dto.allowComment });
    await this.save(result);
    const token = this.reviewTokens.sign({
      version: 1,
      linkId: result.link.id,
      workspaceId,
      contentItemId: id,
      draftId: result.link.draftId,
      draftSha256: result.link.draftSha256,
      expiresAt: result.link.expiresAt,
    });
    const webUrl = (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, "");
    return { link: result.link, url: `${webUrl}/review/${token}` };
  }

  async revokeReviewLink(workspaceId: string, id: string, linkId: string, actor: Actor, expectedVersion?: number) {
    return this.save(revokeDomainReviewLink(await this.getForUpdate(workspaceId, id, expectedVersion), actor, linkId));
  }

  async externalReview(token: string) {
    const { item, draft, link } = await this.resolveReviewToken(token);
    const media = [];
    for (const mediaId of draft.mediaIds) {
      const asset = await this.infrastructure.mediaRepository.get(item.workspaceId, mediaId);
      if (!asset || asset.status !== "ready") continue;
      const download = await this.infrastructure.mediaObjectStore.createDownload(asset.objectKey, asset.fileName);
      media.push({ id: asset.id, kind: asset.kind, contentType: asset.contentType, fileName: asset.fileName, altText: asset.altText, url: download.url, expiresAt: download.expiresAt });
    }
    return {
      review: { id: link.id, expiresAt: link.expiresAt, allowComment: link.allowComment },
      content: { title: item.title, summary: item.summary },
      draft,
      media,
      sources: item.sources.map(({ id, title, url, publisher, publishedAt, confidence }) => ({ id, title, url, publisher, publishedAt, confidence })),
      comments: item.reviewComments.filter((comment) => comment.draftId === draft.id && comment.draftSha256 === draft.contentSha256 && comment.audience !== "internal")
        .map(({ id, authorName, body, createdAt }) => ({ id, authorName, body, createdAt })),
    };
  }

  async externalReviewComment(token: string, dto: ExternalReviewCommentDto) {
    const resolved = await this.resolveReviewToken(token);
    if (!resolved.link.allowComment) throw new DomainError("Comments are disabled for this review link.", "review_comments_disabled", 403);
    const actor: Actor = { id: `external:${resolved.link.id}`, name: dto.name, role: "viewer" };
    await this.save(addExternalReviewComment(resolved.item, actor, { draftId: resolved.draft.id, draftSha256: resolved.draft.contentSha256, body: dto.body }));
    return this.externalReview(token);
  }

  private async resolveReviewToken(token: string) {
    const payload: ReviewTokenPayload = this.reviewTokens.verify(token);
    const item = await this.get(payload.workspaceId, payload.contentItemId);
    const link = item.reviewLinks.find((entry) => entry.id === payload.linkId);
    const matches = link && link.draftId === payload.draftId && link.draftSha256 === payload.draftSha256 && link.expiresAt === payload.expiresAt;
    if (!matches || link.revokedAt || new Date(link.expiresAt).getTime() <= Date.now()) {
      throw new DomainError("This review link has expired or was revoked.", "review_link_unavailable", 410);
    }
    const draft = item.drafts.find((entry) => entry.id === link.draftId && entry.contentSha256 === link.draftSha256);
    if (!draft) throw new DomainError("This draft revision is no longer available.", "draft_revision_not_found", 404);
    return { item, draft, link };
  }

  async schedule(workspaceId: string, id: string, dto: ScheduleDto, actor: Actor, expectedVersion?: number) {
    const { instagramCollaboratorApprovalId, instagramPublishApprovalId, conflictAcknowledgementSha256, ...scheduleDto } = dto;
    if(instagramCollaboratorApprovalId&&instagramPublishApprovalId&&instagramCollaboratorApprovalId!==instagramPublishApprovalId)throw new DomainError("Use one exact Instagram publishing approval.","instagram_publish_approval_conflict",409);
    const instagramApprovalId=instagramPublishApprovalId??instagramCollaboratorApprovalId;
    const collaboratorCandidate = dto.platform === "instagram" && instagramApprovalId
      ? await this.infrastructure.instagramCollaboratorRepository.getApprovedCandidate(workspaceId, id, instagramApprovalId)
      : null;
    if (dto.platform === "instagram" && instagramApprovalId && (!collaboratorCandidate || collaboratorCandidate.accountId !== dto.accountId || collaboratorCandidate.draftId !== dto.draftId)) {
      throw new DomainError("The approved Instagram publishing options do not match this target.", "instagram_collaborator_approval_required", 409);
    }
    const parsedInput = scheduleSchema.parse({
      ...scheduleDto,
      ...(collaboratorCandidate ? { settings: { collaborators: collaboratorCandidate.settings.collaborators, shareToFeed:collaboratorCandidate.settings.shareToFeed??true, isAiGenerated:collaboratorCandidate.settings.isAiGenerated===true, ...(collaboratorCandidate.settings.reelCover?{reelCover:collaboratorCandidate.settings.reelCover}:{}) } } : {}),
      timezone: dto.timezone ?? dto.settings?.timezone,
    });
    const input = collaboratorCandidate&&parsedInput.platform==="instagram"?{...parsedInput,settings:collaboratorCandidate.settings}:parsedInput;
    const item = await this.getForUpdate(workspaceId, id, expectedVersion);
    const conflictPreflight = await this.inspectConflicts(item, input);
    if (input.platform === "youtube") {
      const draft = item.drafts.find((entry) => entry.id === input.draftId);
      if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
      if (input.settings.title !== draft.title || input.settings.description !== draft.caption) {
        throw new DomainError("YouTube title and description must match the approved draft. Update and approve the draft before scheduling.", "youtube_settings_not_approved", 409);
      }
      const nonPrivateGate = this.config.get<string | boolean>("YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING");
      const complianceAudited = this.config.get<string | boolean>("YOUTUBE_API_COMPLIANCE_AUDITED");
      if (input.settings.privacyStatus !== "private" && (nonPrivateGate !== true && nonPrivateGate !== "true" || complianceAudited !== true && complianceAudited !== "true")) {
        throw new DomainError("YouTube publishing is private by default. An administrator must enable the reviewed non-private publishing gate.", "youtube_non_private_gate_required", 409);
      }
    }
    if (input.deliveryMode === "auto_publish") {
      const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, input.accountId);
      if (!account) throw new DomainError("Connect and check this publishing account before scheduling.", "connected_account_required", 409);
      if (account.brandId !== item.brandId) throw new DomainError("This publishing account belongs to another brand.", "connected_account_brand_mismatch", 409);
      if (account.platform !== input.platform) throw new DomainError("The connected account belongs to another platform.", "connected_account_platform_mismatch", 409);
      if (account.status !== "healthy" && account.status !== "expiring") throw new DomainError("Run Connection Doctor and fix this account before scheduling.", "connected_account_not_ready", 409);
      const facebookMode = this.config.get<string>("FACEBOOK_CONNECTOR_MODE") ?? "mock";
      if (account.platform === "facebook" && facebookMode === "official" && !account.credentialRef?.startsWith("secret:")) {
        throw new DomainError("Reconnect this Facebook Page before scheduling. Official publishing requires its encrypted Page credential.", "facebook_managed_credential_required", 409);
      }
      const refreshableYouTube = account.platform === "youtube" && account.credentialRef?.startsWith("secret:");
      if (!refreshableYouTube && account.expiresAt && new Date(input.scheduledFor).getTime() >= new Date(account.expiresAt).getTime()) {
        throw new DomainError("This account access expires before the scheduled time. Reconnect it first.", "connected_account_expires_before_publish", 409);
      }
    }
    const scheduled = scheduleTarget(item, actor, input);
    const result = conflictPreflight.requiresConfirmation ? { ...scheduled, event: { ...scheduled.event, detail: { ...scheduled.event.detail, scheduleConflictAcknowledgementSha256: conflictPreflight.acknowledgementSha256, scheduleConflictCount: conflictPreflight.conflicts.length } } } : scheduled;
    const target = result.item.targets.at(-1);
    if (!target) throw new DomainError("Scheduled target was not created.", "target_not_created", 500);
    const draft = result.item.drafts.find((entry) => entry.id === target.draftId);
    if (!draft) throw new DomainError("Platform draft not found.", "draft_not_found", 404);
    await this.validatePlatformDraft(workspaceId, result.item, draft, target.platform, target.accountId, target.settings ?? {}, target.deliveryMode === "manual_handoff");
    assertScheduleConflictAcknowledgement(conflictPreflight, conflictAcknowledgementSha256);
    await this.infrastructure.repository.commit(result.item, result.event, [createOutboxMessage({
      workspaceId,
      topic: "publish.target.requested",
      dedupeKey: `publish-target:${target.id}`,
      payload: { workspaceId, contentItemId: id, targetId: target.id },
      availableAt: target.scheduledFor,
    })], [], [], { request: conflictPreflight.request, ...(conflictAcknowledgementSha256 ? { acknowledgementSha256: conflictAcknowledgementSha256 } : {}) });
    return result.item;
  }

  async reschedule(workspaceId: string, id: string, targetId: string, dto: RescheduleTargetDto, actor: Actor, expectedVersion?: number) {
    const { conflictAcknowledgementSha256, ...rescheduleDto } = dto;
    const input = rescheduleTargetSchema.parse(rescheduleDto);
    const current = await this.getForUpdate(workspaceId, id, expectedVersion);
    const currentTarget = current.targets.find((entry) => entry.id === targetId);
    if (!currentTarget) throw new DomainError("Publish target not found.", "target_not_found", 404);
    const conflictPreflight = await this.inspectConflicts(current, { platform: currentTarget.platform, accountId: currentTarget.accountId, draftId: currentTarget.draftId, scheduledFor: input.scheduledFor }, targetId);
    assertScheduleConflictAcknowledgement(conflictPreflight, conflictAcknowledgementSha256);
    const queueAssigned = current.targets.find((entry) => entry.id === targetId)?.queueAssignment;
    const moved = rescheduleTarget(current, targetId, input, actor);
    const result = conflictPreflight.requiresConfirmation ? { ...moved, event: { ...moved.event, detail: { ...moved.event.detail, scheduleConflictAcknowledgementSha256: conflictPreflight.acknowledgementSha256, scheduleConflictCount: conflictPreflight.conflicts.length } } } : moved;
    const scheduleConflict = { request: conflictPreflight.request, ...(conflictAcknowledgementSha256 ? { acknowledgementSha256: conflictAcknowledgementSha256 } : {}) };
    if (queueAssigned && await this.infrastructure.postingQueueRepository.commitReschedule(result.item, result.event, targetId, result.target, actor.id, scheduleConflict)) return result.item;
    await this.infrastructure.repository.commit(result.item, result.event, [createOutboxMessage({
      workspaceId,
      topic: "publish.target.requested",
      dedupeKey: `publish-target:${result.target.id}`,
      payload: { workspaceId, contentItemId: id, targetId: result.target.id },
      availableAt: result.target.scheduledFor,
    })], [], [], scheduleConflict);
    return result.item;
  }

  async cancel(workspaceId: string, id: string, targetId: string, actor: Actor, expectedVersion?: number) {
    const result = cancelTarget(await this.getForUpdate(workspaceId, id, expectedVersion), targetId, actor);
    const target = result.item.targets.find((entry) => entry.id === targetId);
    if (target?.queueAssignment && await this.infrastructure.postingQueueRepository.commitCancellation(result.item, result.event, targetId, actor.id)) return result.item;
    return this.save(result);
  }

  async acknowledgeHandoff(workspaceId: string, id: string, targetId: string, actor: Actor, expectedVersion?: number) {
    return this.save(acknowledgeManualHandoff(await this.getForUpdate(workspaceId, id, expectedVersion), targetId, actor));
  }

  async confirmManual(workspaceId: string, id: string, targetId: string, dto: ManualPublishConfirmationDto, actor: Actor, expectedVersion?: number) {
    const item = await this.getForUpdate(workspaceId, id, expectedVersion);
    const target = item.targets.find((entry) => entry.id === targetId);
    if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
    const draft = item.drafts.find((entry) => entry.id === target.draftId);
    if (!draft) throw new DomainError("Platform draft not found.", "draft_not_found", 404);
    if (target.platform === "instagram") {
      const requested = (target.settings as InstagramPublishSettings | undefined)?.isAiGenerated === true;
      const attested = dto.disclosure === "ai-assisted";
      if (requested !== attested) {
        throw new DomainError(
          requested
            ? "Confirm that Instagram shows its native AI info label before saving this manual publish proof."
            : "This approved Instagram target did not request the native AI info label.",
          "instagram_ai_disclosure_attestation_mismatch",
          409,
        );
      }
    } else if (draft.containsSyntheticMedia === true && dto.disclosure !== "synthetic-media") {
      throw new DomainError(
        `Confirm that this ${target.platform} post discloses its generated visual before saving manual publish proof.`,
        "synthetic_media_disclosure_attestation_required",
        409,
      );
    }
    const media = await this.validatePlatformDraft(workspaceId, item, draft, target.platform, target.accountId, target.settings ?? {}, true);
    const mediaSha256 = media.map((entry) => entry.sha256);
    const saved = await this.save(confirmManualPublication(item, targetId, { ...dto, mediaSha256, ...(target.platform === "instagram" ? { collaboratorInviteProof: collaboratorInviteProof(undefined, "instagram_login") } : {}) }, actor));
    await this.queueInitialAnalytics(saved);
    return saved;
  }

  async confirmProvider(workspaceId: string, id: string, targetId: string, dto: ManualPublishConfirmationDto, actor: Actor, expectedVersion?: number) {
    const item = await this.getForUpdate(workspaceId, id, expectedVersion);
    const target = item.targets.find((entry) => entry.id === targetId);
    if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
    const operation = await this.infrastructure.providerPublishOperationRepository.get(workspaceId, targetId);
    if (!operation || operation.contentItemId !== id || operation.status !== "uncertain") throw new DomainError("This provider result is not waiting for proof recovery.", "provider_reconciliation_not_ready", 409);
    const draft = item.drafts.find((entry) => entry.id === target.draftId);
    if (!draft) throw new DomainError("Platform draft not found.", "draft_not_found", 404);
    let liveUrl: URL;
    try { liveUrl = new URL(dto.liveUrl); }
    catch { throw new DomainError(`Enter a valid ${target.platform} post link.`, "invalid_provider_url"); }
    if (target.platform === "instagram") {
      liveUrl = assertInstagramProviderUrl(dto.liveUrl, draft.format, dto.externalPostId);
    } else if (target.platform === "facebook") {
      const host = liveUrl.hostname.toLowerCase();
      if (liveUrl.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) throw new DomainError("Use the real HTTPS Facebook post link.", "invalid_provider_url");
    } else if (target.platform === "youtube") {
      const host = liveUrl.hostname.toLowerCase();
      const pathParts = liveUrl.pathname.split("/").filter(Boolean);
      const linkedVideoId = host === "youtu.be" ? pathParts[0] : pathParts[0] === "shorts" ? pathParts[1] : liveUrl.searchParams.get("v") ?? undefined;
      if (liveUrl.protocol !== "https:" || !["youtube.com", "www.youtube.com", "youtu.be"].includes(host) || !linkedVideoId || linkedVideoId !== dto.externalPostId) throw new DomainError("Use the real HTTPS YouTube link for this video ID.", "invalid_provider_url");
    }
    const media = await this.validatePlatformDraft(workspaceId, item, draft, target.platform, target.accountId, target.settings ?? {});
    const instagramSettings = target.platform === "instagram" ? target.settings as InstagramPublishSettings | undefined : undefined;
    let aiDisclosureVerified = operation.instagramAiDisclosureVerified === true;
    if (instagramSettings?.isAiGenerated === true && !aiDisclosureVerified) {
      const connector = this.infrastructure.connectors.get("instagram");
      if (connector.manifest.apiMode === "official") {
        if (!(connector instanceof InstagramOfficialConnector)) throw new DomainError("Instagram AI disclosure verification is unavailable.", "instagram_ai_disclosure_unverified", 409);
        let verified;
        try {
          verified = await connector.inspectAiDisclosure({ workspaceId, accountId: target.accountId, externalMediaId: dto.externalPostId });
        } catch {
          throw new DomainError("Instagram did not verify the native AI info label on this exact media item.", "instagram_ai_disclosure_unverified", 409);
        }
        if (verified.liveUrl !== dto.liveUrl) throw new DomainError("The Instagram AI disclosure check returned a different live link.", "provider_reconciliation_post_mismatch", 409);
      }
      aiDisclosureVerified = true;
    }
    if (instagramSettings && Array.isArray(instagramSettings.collaborators) && instagramSettings.collaborators.length > 0) {
      const expectedInvite = collaboratorInviteProof(instagramSettings, "facebook_login");
      const binding = instagramSettings.approvalBinding;
      const operationMatchesApproval = operation.collaboratorInviteProof?.requestState === "requested_unverified"
        && operation.collaboratorInviteProof.requestedUsernamesSha256 === expectedInvite.requestedUsernamesSha256
        && operation.accountId === target.accountId
        && operation.draftSha256 === draft.contentSha256
        && typeof instagramSettings.approvedSettingsSha256 === "string"
        && operation.approvedSettingsSha256 === instagramSettings.approvedSettingsSha256
        && binding?.accountId === target.accountId
        && binding.draftSha256 === draft.contentSha256
        && binding.approvedSettingsSha256 === instagramSettings.approvedSettingsSha256;
      if (!operationMatchesApproval) {
        throw new DomainError("The recovered Instagram operation does not match the exact approved collaborator settings.", "instagram_collaborator_proof_missing", 409);
      }
    }
    if (operation.externalPostId && operation.externalPostId !== dto.externalPostId) {
      throw new DomainError("The provider post ID does not match the saved publishing operation.", "provider_reconciliation_post_mismatch", 409);
    }
    const result = confirmProviderPublication(item, targetId, { ...dto, disclosure: target.platform !== "instagram" && draft.containsSyntheticMedia === true ? "synthetic-media" : dto.disclosure, providerOperationId: operation.id, mediaSha256: media.map((entry) => entry.sha256), ...(target.platform === "instagram" ? { instagramAiDisclosureObserved: aiDisclosureVerified } : {}), ...(target.platform === "instagram" && operation.collaboratorInviteProof ? { collaboratorInviteProof: operation.collaboratorInviteProof } : {}) }, actor);
    const updatedOperation: ProviderPublishOperation = { ...operation, status: "published", externalPostId: dto.externalPostId, liveUrl: dto.liveUrl, ...(instagramSettings?.isAiGenerated === true ? { instagramAiDisclosureRequested:true, instagramAiDisclosureVerified:aiDisclosureVerified } : {}), lastError: undefined, updatedAt: new Date().toISOString() };
    const saved = await this.save(result, [], [updatedOperation]);
    await this.queueInitialAnalytics(saved);
    return saved;
  }

  async validatePlatformDraft(workspaceId: string, item: ContentItem, draft: PlatformDraft, platform: PlatformDraft["platform"], accountId: string, settings: Record<string, unknown> = {}, manualHandoff = false): Promise<ConnectorMedia[]> {
    const media: ConnectorMedia[] = [];
    let attachedSyntheticMedia = false;
    for (const mediaId of draft.mediaIds) {
      const asset = await this.infrastructure.mediaRepository.get(workspaceId, mediaId);
      if (!asset || asset.status !== "ready") throw new DomainError("Every attached media file must be ready before scheduling.", "media_not_ready", 409);
      if (asset.malwareScanStatus !== undefined && asset.malwareScanStatus !== "clean" && asset.malwareScanStatus !== "disabled") throw new DomainError("Every attached media file must pass malware scanning before scheduling.", "media_malware_scan_required", 409);
      if (asset.rights !== "owned" && asset.rights !== "cleared") throw new DomainError("Publishing media must be owned or cleared for reuse.", "media_rights_not_cleared", 409);
      if (asset.kind !== "image" && asset.kind !== "video") throw new DomainError("Only image and video files can be sent to a social connector.", "media_kind_not_publishable", 409);
      if (asset.syntheticLineage?.kind === "ai-generation") attachedSyntheticMedia = true;
      media.push({
        id: asset.id, type: asset.kind, url: `https://media.invalid/${encodeURIComponent(asset.id)}`, mimeType: asset.detectedContentType ?? asset.contentType,
        sha256: asset.sha256, sizeBytes: asset.sizeBytes, inspectionStatus: asset.inspectionStatus, malwareScanStatus: asset.malwareScanStatus, rights: asset.rights,
        ...(asset.widthPixels !== undefined ? { widthPixels: asset.widthPixels } : {}),
        ...(asset.heightPixels !== undefined ? { heightPixels: asset.heightPixels } : {}),
        ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
        ...(asset.altText ? { altText: asset.altText } : {}),
      });
    }
    if (attachedSyntheticMedia !== (draft.containsSyntheticMedia === true)) {
      throw new DomainError("The draft's generated-media disclosure no longer matches its immutable Library assets. Create a new draft revision.", "draft_synthetic_media_lineage_mismatch", 409);
    }
    let containsSyntheticMedia = attachedSyntheticMedia;
    let coverMedia:ConnectorMedia|undefined;
    const reelCover=platform==="instagram"&&settings&&typeof settings==="object"&&"reelCover" in settings?settings.reelCover as {mode?:unknown;mediaId?:unknown;mediaSha256?:unknown}|undefined:undefined;
    if(reelCover?.mode==="custom_image"){
      if(typeof reelCover.mediaId!=="string"||typeof reelCover.mediaSha256!=="string")throw new DomainError("The approved Reel cover is invalid.","instagram_reel_cover_invalid",409);
      const asset=await this.infrastructure.mediaRepository.get(workspaceId,reelCover.mediaId);
      if(!asset||asset.brandId!==item.brandId||asset.status!=="ready"||asset.kind!=="image"||asset.inspectionStatus!=="ready"||(asset.malwareScanStatus!==undefined&&asset.malwareScanStatus!=="clean"&&asset.malwareScanStatus!=="disabled")||(asset.rights!=="owned"&&asset.rights!=="cleared")||asset.sha256!==reelCover.mediaSha256)throw new DomainError("The approved Reel cover image is unavailable or changed.","instagram_reel_cover_stale",409);
      if(asset.syntheticLineage?.kind==="ai-generation")containsSyntheticMedia=true;
      coverMedia={id:asset.id,type:"image",url:`https://media.invalid/${encodeURIComponent(asset.id)}`,mimeType:asset.contentType,sha256:asset.sha256,sizeBytes:asset.sizeBytes,inspectionStatus:asset.inspectionStatus,malwareScanStatus:asset.malwareScanStatus,...(asset.widthPixels!==undefined?{widthPixels:asset.widthPixels}:{}),...(asset.heightPixels!==undefined?{heightPixels:asset.heightPixels}:{})};
    }
    if(containsSyntheticMedia&&platform==="instagram"&&settings.isAiGenerated!==true)throw new DomainError("Generated visuals require Instagram's native AI info label in the approved publish settings.","instagram_ai_disclosure_required",409);
    if(containsSyntheticMedia&&platform==="youtube"&&settings.containsSyntheticMedia!==true)throw new DomainError("Generated visuals must be marked as altered or synthetic in the approved YouTube settings.","youtube_synthetic_media_disclosure_required",409);
    // A manual Story is posted by a person in Instagram, so it must retain the
    // trusted media/rights/shape contract without requiring an official API
    // credential or Business-account eligibility. All automatic Stories still
    // run the official connector preflight and fail closed.
    if (manualHandoff && platform === "instagram" && draft.format === "story") {
      const errors = validateMeasuredMedia({ platform, format: draft.format, media });
      if (errors.length) throw new DomainError(errors.map((issue) => issue.message).join(" "), "platform_preflight_failed", 409);
      return media;
    }
    const connector = this.infrastructure.connectors.get(platform);
    const issues = await connector.validate({ workspaceId, contentItemId: item.id, targetId: "preflight", accountId, platform, format: draft.format, caption: draft.caption, media, ...(coverMedia?{coverMedia}:{}), idempotencyKey: `preflight:${draft.id}:${draft.contentSha256}`, settings });
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length) throw new DomainError(errors.map((issue) => issue.message).join(" "), "platform_preflight_failed", 409);
    return media;
  }
}
