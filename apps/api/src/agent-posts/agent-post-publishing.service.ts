import { hasLiveAgentResearch } from "@originpost/domain";
import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { can, DomainError, type Actor } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { ContentService } from "../content/content.service.js";
import type {
  AgentPostPublishDto,
  AgentPostPublishPreviewDto,
} from "./agent-posts.dto.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A bounded publishing command over Content's approvals, targets and outbox. */
@Injectable()
export class AgentPostPublishingService {
  constructor(
    @Inject(INFRASTRUCTURE)
    private readonly infrastructure: OriginPostInfrastructure,
    private readonly content: ContentService,
  ) {}

  private async context(w: string, b: string, id: string, actor: Actor) {
    if (!can(actor.role, "content:read"))
      throw new DomainError(
        "You cannot read this post.",
        "permission_denied",
        403,
      );
    const brand = await this.infrastructure.organizationRepository.getBrand(
      w,
      b,
    );
    const run = await this.infrastructure.agentPostRepository.get(w, id);
    if (!brand || brand.status !== "active" || !run || run.brandId !== b)
      throw new DomainError(
        "Post not found in this active brand.",
        "post_not_found",
        404,
      );
    if (run.status !== "ready" || !run.draftId || !run.outputMediaId)
      throw new DomainError(
        "Finish creating the post before preparing publication.",
        "post_not_ready",
        409,
      );
    const item = await this.content.get(w, run.contentItemId);
    if (item.brandId !== b)
      throw new DomainError("Content scope changed.", "scope_mismatch", 409);
    const research = item.researchRuns.find((r) => r.id === run.researchRunId);
    if (
      !research ||
      research.status !== "completed" ||
      !hasLiveAgentResearch(item, run.researchRunId)
    )
      throw new DomainError(
        "A completed live research receipt is required before publishing this agent post. Test research does not verify news.",
        "research_not_live",
        409,
      );
    const draft = item.drafts.find((d) => d.id === run.draftId);
    if (
      !draft ||
      draft.mediaIds.length !== 1 ||
      draft.mediaIds[0] !== run.outputMediaId ||
      draft.title !== run.copy?.headline ||
      draft.caption !== run.copy?.caption
    )
      throw new DomainError(
        "This draft no longer matches the saved agent post.",
        "post_draft_changed",
        409,
      );
    return { run, item, draft };
  }

  async detail(w: string, b: string, id: string, actor: Actor) {
    const { run, item, draft } = await this.context(w, b, id, actor);
    const accounts = await this.infrastructure.connectedAccountRepository.list(
      w,
      b,
    );
    return {
      recipient: { id: "originpost.publisher", label: "Publisher" },
      item,
      draftId: draft.id,
      accounts: accounts
        .filter((a) => a.platform === draft.platform)
        .map((a) => ({
          id: a.id,
          displayName: a.displayName,
          platform: a.platform,
          status: a.status,
          mode: this.infrastructure.connectors.get(a.platform).manifest.apiMode,
        })),
      instagramCandidates:
        draft.platform === "instagram"
          ? (
              await this.infrastructure.instagramCollaboratorRepository.listCandidates(
                w,
                item.id,
              )
            ).filter((c) => c.draftId === draft.id)
          : [],
      targets: item.targets.filter((t) => t.draftId === run.draftId),
      canSchedule:
        can(actor.role, "content:schedule") &&
        (!actor.actorType || actor.actorType === "human"),
    };
  }

  private targetId(runId: string, draftId: string, accountId: string) {
    return `target_agent_${hash([runId, draftId, accountId]).slice(0, 40)}`;
  }

  async preview(
    w: string,
    id: string,
    dto: AgentPostPublishPreviewDto,
    actor: Actor,
  ) {
    const { run, item, draft } = await this.context(w, dto.brandId, id, actor);
    if (dto.recipientId !== "originpost.publisher")
      throw new DomainError(
        "Unknown publishing recipient.",
        "recipient_invalid",
        400,
      );
    if (run.evidenceHash !== hash([item.claims, item.sources]))
      throw new DomainError(
        "The sources changed after creation. Review a new post version before publishing from chat.",
        "evidence_changed",
        409,
      );
    const account = await this.infrastructure.connectedAccountRepository.get(
      w,
      dto.accountId,
    );
    if (
      !account ||
      account.brandId !== dto.brandId ||
      account.platform !== draft.platform
    )
      throw new DomainError(
        "Choose a connected account for this draft and brand.",
        "connected_account_required",
        409,
      );
    if (!["healthy", "expiring"].includes(account.status))
      throw new DomainError(
        "Check or reconnect this account before publishing.",
        "connected_account_not_ready",
        409,
      );
    const mode = this.infrastructure.connectors.get(account.platform).manifest
      .apiMode;
    if (mode === "mock")
      throw new DomainError(
        "This is a test connection. Connect a live account before publishing.",
        "test_connection",
        409,
      );
    const approval = item.approvals.findLast(
      (a) => a.draftId === draft.id && a.draftSha256 === draft.contentSha256,
    );
    if (
      approval?.decision !== "approved" ||
      !["approved", "scheduled"].includes(item.status)
    )
      throw new DomainError(
        "Approve this exact draft in Review before preparing publication.",
        "draft_approval_required",
        409,
      );
    if (Date.parse(dto.scheduledFor) <= Date.now())
      throw new DomainError(
        "Choose a future publishing time.",
        "scheduled_time_in_past",
        409,
      );
    if (
      account.expiresAt &&
      Date.parse(dto.scheduledFor) >= Date.parse(account.expiresAt)
    )
      throw new DomainError(
        "This account access expires before publication. Reconnect it first.",
        "connected_account_expires_before_publish",
        409,
      );
    const targetId = this.targetId(run.id, draft.id, account.id);
    if (item.targets.some((t) => t.id === targetId))
      throw new DomainError(
        "This version already has a publishing request for that account. Follow its receipt below.",
        "publication_exists",
        409,
      );
    // The original generated package currently contains an Instagram image/Story.
    // Any future platform draft must use its own exact approval and settings contract.
    if (draft.platform !== "instagram" && draft.platform !== "facebook")
      throw new DomainError(
        "Use the video publishing review for this platform.",
        "platform_review_required",
        409,
      );
    const candidates =
      draft.platform === "instagram"
        ? (
            await this.infrastructure.instagramCollaboratorRepository.listCandidates(
              w,
              item.id,
            )
          )
            .filter((c) => c.accountId === account.id && c.draftId === draft.id)
            .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        : [];
    const candidate = candidates[0];
    if (
      candidate &&
      (candidate.status !== "approved" ||
        !candidate.approvalId ||
        candidate.draftSha256 !== draft.contentSha256)
    )
      throw new DomainError(
        "Approve the latest Instagram publishing options for this exact account and draft.",
        "instagram_publish_approval_required",
        409,
      );
    if (
      draft.platform === "instagram" &&
      draft.containsSyntheticMedia &&
      candidate?.settings.isAiGenerated !== true
    )
      throw new DomainError(
        "Approve Instagram’s native AI info label for this generated image in Review.",
        "instagram_ai_disclosure_required",
        409,
      );
    const asset = await this.infrastructure.mediaRepository.get(
      w,
      run.outputMediaId!,
    );
    if (!asset || asset.brandId !== dto.brandId)
      throw new DomainError(
        "The post image is not available in this brand.",
        "media_scope_mismatch",
        409,
      );
    if (
      run.imageReview &&
      (run.imageReview.status !== "passed" ||
        run.imageReview.image.mediaId !== asset.id ||
        run.imageReview.image.sha256 !== asset.sha256 ||
        run.imageReview.copyHash !== hash(run.copy) ||
        run.imageReview.evidenceHash !== run.evidenceHash)
    )
      throw new DomainError(
        "The image review no longer matches this post. Create and review a corrected version.",
        "image_review_changed",
        409,
      );
    const settings = candidate?.settings;
    const media = await this.content.validatePlatformDraft(
      w,
      item,
      draft,
      draft.platform,
      account.id,
      settings ?? {},
    );
    const schedule = {
      platform: draft.platform,
      accountId: account.id,
      draftId: draft.id,
      scheduledFor: dto.scheduledFor,
      deliveryMode: "auto_publish" as const,
      targetId,
      ...(candidate?.approvalId
        ? { instagramPublishApprovalId: candidate.approvalId }
        : {}),
    };
    const conflicts = await this.content.schedulePreflight(
      w,
      item.id,
      schedule,
      item.version,
    );
    const previewHash = hash({
      recipientId: dto.recipientId,
      runId: run.id,
      runVersion: run.version,
      itemVersion: item.version,
      draftSha256: draft.contentSha256,
      schedule,
      account: [
        account.id,
        account.externalAccountId,
        account.updatedAt,
        account.status,
        hash(account.credentialRef ?? ""),
      ],
      media,
      settings,
      mode,
      conflicts: conflicts.acknowledgementSha256,
    });
    return {
      previewHash,
      contentVersion: item.version,
      schedule,
      mode,
      account: {
        id: account.id,
        displayName: account.displayName,
        platform: account.platform,
      },
      draft: {
        id: draft.id,
        title: draft.title,
        caption: draft.caption,
        format: draft.format,
      },
      nativeAiLabel: settings?.isAiGenerated === true,
      conflicts,
    };
  }

  async publish(w: string, id: string, dto: AgentPostPublishDto, actor: Actor) {
    if (
      !can(actor.role, "content:schedule") ||
      (actor.actorType && actor.actorType !== "human")
    )
      throw new DomainError(
        "A permitted editor must confirm publication.",
        "permission_denied",
        403,
      );
    if (dto.recipientId !== "originpost.publisher")
      throw new DomainError(
        "Unknown publishing recipient.",
        "recipient_invalid",
        400,
      );
    const context = await this.context(w, dto.brandId, id, actor);
    const targetId = this.targetId(id, context.draft.id, dto.accountId);
    const existing = context.item.targets.find((t) => t.id === targetId);
    if (existing) {
      if (existing.scheduledFor !== dto.scheduledFor)
        throw new DomainError(
          "This version already has a different publishing request. Open its existing receipt.",
          "publication_exists",
          409,
        );
      return {
        target: existing,
        contentItemId: context.item.id,
        replayed: true,
      };
    }
    const preview = await this.preview(w, id, dto, actor);
    if (
      preview.previewHash !== dto.previewHash ||
      preview.contentVersion !== dto.contentVersion
    )
      throw new DomainError(
        "The post, account or schedule changed. Prepare and check a fresh preview.",
        "publication_preview_changed",
        409,
      );
    const item = await this.content.schedule(
      w,
      context.item.id,
      {
        ...preview.schedule,
        ...(dto.conflictAcknowledgementSha256
          ? { conflictAcknowledgementSha256: dto.conflictAcknowledgementSha256 }
          : {}),
      },
      actor,
      dto.contentVersion,
    );
    return {
      target: item.targets.find((t) => t.id === targetId)!,
      contentItemId: item.id,
      replayed: false,
    };
  }
}
