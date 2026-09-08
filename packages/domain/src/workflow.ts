import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { assertFacebookPageDraftContract } from "./facebook-page.js";
import { assertApprovedInstagramPublishSettings, assertInstagramCollaboratorFormat, assertInstagramPublishApprovalBinding, assertInstagramReelCoverForDraft, bindInstagramPublishApproval } from "./instagram-collaboration.js";
import { can } from "./permissions.js";
import type {
  Actor,
  Approval,
  AuditEvent,
  ContentItem,
  ContentStatus,
  PlatformDraft,
  PublishAttempt,
  PublishProof,
  PublishTarget,
  ScheduleTargetInput,
  ResearchRun,
  ReviewComment,
  ReviewLink,
  SourceEvidence,
} from "./types.js";

const transitions: Record<ContentStatus, readonly ContentStatus[]> = {
  inbox: ["researching", "drafting", "archived"],
  researching: ["drafting", "inbox", "archived"],
  drafting: ["review", "researching", "archived"],
  review: ["drafting", "approved", "archived"],
  approved: ["scheduled", "publishing", "drafting", "archived"],
  scheduled: ["publishing", "approved", "archived"],
  action_required: ["published", "failed", "scheduled", "archived"],
  publishing: ["published", "failed"],
  published: ["archived"],
  failed: ["approved", "scheduled", "publishing", "archived"],
  archived: ["inbox"],
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function draftHash(draft: Pick<PlatformDraft, "platform" | "format" | "title" | "caption" | "mediaIds">): string {
  return createHash("sha256").update(JSON.stringify({
    platform: draft.platform,
    format: draft.format,
    title: draft.title,
    caption: draft.caption,
    mediaIds: draft.mediaIds,
  })).digest("hex");
}

function event(
  item: ContentItem,
  actor: Actor,
  action: string,
  detail: Record<string, unknown>,
  now: string,
): AuditEvent {
  return {
    id: id("evt"),
    workspaceId: item.workspaceId,
    contentItemId: item.id,
    actorId: actor.id,
    actorType: actor.actorType ?? "human",
    action,
    detail,
    createdAt: now,
  };
}

export function createContentItem(input: {
  contentId?: string | undefined;
  workspaceId: string;
  brandId?: string | undefined;
  title: string;
  summary?: string | undefined;
  actor: Actor;
  researchDepth?: ContentItem["researchDepth"] | undefined;
  riskLevel?: ContentItem["riskLevel"] | undefined;
  now?: string | undefined;
}): { item: ContentItem; event: AuditEvent } {
  if (!can(input.actor.role, "content:create")) {
    throw new DomainError("This role cannot create content.", "permission_denied", 403);
  }

  const now = input.now ?? new Date().toISOString();
  const item: ContentItem = {
    id: input.contentId ?? id("content"),
    workspaceId: input.workspaceId,
    brandId: input.brandId ?? "brand_default",
    version: 1,
    title: input.title.trim(),
    summary: input.summary?.trim() ?? "",
    status: "inbox",
    researchDepth: input.researchDepth ?? "standard",
    riskLevel: input.riskLevel ?? "low",
    tags: [],
    sources: [],
    claims: [],
    researchRuns: [],
    drafts: [],
    approvals: [],
    reviewComments: [],
    reviewLinks: [],
    targets: [],
    publishAttempts: [],
    proofs: [],
    createdBy: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };

  if (!item.title) {
    throw new DomainError("A title is required.", "title_required");
  }

  return {
    item,
    event: event(item, input.actor, "content.created", { title: item.title, brandId: item.brandId }, now),
  };
}

export function startResearch(
  item: ContentItem,
  input: {
    query?: string | undefined;
    depth?: ContentItem["researchDepth"] | undefined;
    languages: string[];
    region?: string | undefined;
    sourceLimit: number;
    freshnessHours?: number | undefined;
  },
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent; run: ResearchRun } {
  if (!can(actor.role, "content:edit")) {
    throw new DomainError("This role cannot start research.", "permission_denied", 403);
  }
  if (item.status === "published" || item.status === "archived") {
    throw new DomainError("Published or archived content cannot start new research.", "research_not_allowed", 409);
  }
  if (item.researchRuns.some((run) => run.status === "queued" || run.status === "running")) {
    throw new DomainError("Research is already running for this content.", "research_already_running", 409);
  }
  const run: ResearchRun = {
    id: id("research"),
    query: input.query?.trim() || item.title,
    depth: input.depth ?? item.researchDepth,
    languages: [...new Set(input.languages.map((language) => language.trim()).filter(Boolean))],
    ...(input.region ? { region: input.region.trim() } : {}),
    sourceLimit: Math.max(2, Math.min(20, input.sourceLimit)),
    ...(input.freshnessHours ? { freshnessHours: input.freshnessHours } : {}),
    status: "queued",
    toolsUsed: [],
    sourceCount: 0,
    claimCount: 0,
    createdBy: actor.id,
    createdAt: now,
  };
  const next = {
    ...item,
    version: item.version + 1,
    status: "researching" as const,
    researchRuns: [...item.researchRuns, run],
    updatedAt: now,
  };
  return {
    item: next,
    run,
    event: event(next, actor, "research.queued", { researchRunId: run.id, query: run.query, depth: run.depth }, now),
  };
}

export function markResearchRunning(
  item: ContentItem,
  researchRunId: string,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  const run = item.researchRuns.find((entry) => entry.id === researchRunId);
  if (!run) throw new DomainError("Research run not found.", "research_not_found", 404);
  const researchRuns = item.researchRuns.map((entry) => entry.id === researchRunId
    ? { ...entry, status: "running" as const, startedAt: now }
    : entry);
  const next = { ...item, version: item.version + 1, status: "researching" as const, researchRuns, updatedAt: now };
  return {
    item: next,
    event: event(next, actor, "research.started", { researchRunId }, now),
  };
}

export function completeResearch(
  item: ContentItem,
  researchRunId: string,
  result: {
    summary: string;
    sources: Array<Omit<SourceEvidence, "id" | "capturedAt">>;
    claims: Array<{ text: string; status: "unverified" | "supported" | "disputed" | "rejected"; sourceUrls: string[] }>;
    provider: string;
    model: string;
    responseId?: string | undefined;
    toolsUsed: string[];
  },
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  const run = item.researchRuns.find((entry) => entry.id === researchRunId);
  if (!run) throw new DomainError("Research run not found.", "research_not_found", 404);
  const existingUrls = new Set(item.sources.map((source) => source.url).filter(Boolean));
  const newSources = result.sources
    .filter((source) => !source.url || !existingUrls.has(source.url))
    .map((source) => ({ ...source, id: id("source"), capturedAt: now }));
  const allSources = [...item.sources, ...newSources];
  const sourceByUrl = new Map(allSources.filter((source) => source.url).map((source) => [source.url!, source.id]));
  const claims = result.claims.map((claim) => ({
    id: id("claim"),
    text: claim.text,
    status: claim.status,
    sourceIds: claim.sourceUrls.map((url) => sourceByUrl.get(url)).filter((value): value is string => Boolean(value)),
  }));
  const researchRuns = item.researchRuns.map((entry) => entry.id === researchRunId
    ? {
        ...entry,
        status: "completed" as const,
        provider: result.provider,
        model: result.model,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        toolsUsed: [...new Set(result.toolsUsed)],
        sourceCount: newSources.length,
        claimCount: claims.length,
        completedAt: now,
      }
    : entry);
  const next = {
    ...item,
    version: item.version + 1,
    summary: result.summary.trim() || item.summary,
    status: "researching" as const,
    sources: allSources,
    claims: [...item.claims, ...claims],
    researchRuns,
    updatedAt: now,
  };
  return {
    item: next,
    event: event(next, actor, "research.completed", {
      researchRunId,
      provider: result.provider,
      model: result.model,
      sourceCount: newSources.length,
      claimCount: claims.length,
    }, now),
  };
}

export function failResearch(
  item: ContentItem,
  researchRunId: string,
  message: string,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  const run = item.researchRuns.find((entry) => entry.id === researchRunId);
  if (!run) throw new DomainError("Research run not found.", "research_not_found", 404);
  const researchRuns = item.researchRuns.map((entry) => entry.id === researchRunId
    ? { ...entry, status: "failed" as const, error: message.slice(0, 500), completedAt: now }
    : entry);
  const next = { ...item, version: item.version + 1, status: "inbox" as const, researchRuns, updatedAt: now };
  return {
    item: next,
    event: event(next, actor, "research.failed", { researchRunId, error: message.slice(0, 500) }, now),
  };
}

export function addSource(
  item: ContentItem,
  source: Omit<SourceEvidence, "id" | "capturedAt"> & { capturedAt?: string | undefined },
  actor: Actor,
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:edit")) {
    throw new DomainError("This role cannot add sources.", "permission_denied", 403);
  }
  const now = source.capturedAt ?? new Date().toISOString();
  const nextSource: SourceEvidence = {
    ...source,
    id: id("source"),
    capturedAt: now,
    confidence: Math.max(0, Math.min(100, source.confidence)),
  };
  const next = { ...item, version: item.version + 1, sources: [...item.sources, nextSource], updatedAt: now };
  return {
    item: next,
    event: event(next, actor, "source.added", { sourceId: nextSource.id, kind: nextSource.kind }, now),
  };
}

export function addDraft(
  item: ContentItem,
  draft: Omit<PlatformDraft, "id" | "revision" | "contentSha256" | "createdBy" | "createdAt">,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:edit")) {
    throw new DomainError("This role cannot edit drafts.", "permission_denied", 403);
  }
  assertFacebookPageDraftContract(draft);
  const nextDraft: PlatformDraft = {
    ...draft,
    id: id("draft"),
    revision: Math.max(0, ...item.drafts.map((entry) => entry.revision ?? 0)) + 1,
    contentSha256: draftHash(draft),
    createdBy: actor.id,
    createdAt: now,
  };
  const next = {
    ...item,
    version: item.version + 1,
    status: "drafting" as const,
    drafts: [...item.drafts, nextDraft],
    updatedAt: now,
  };
  return {
    item: next,
    event: event(next, actor, "draft.added", {
      draftId: nextDraft.id,
      platform: nextDraft.platform,
      format: nextDraft.format,
    }, now),
  };
}

export function transition(
  item: ContentItem,
  to: ContentStatus,
  actor: Actor,
  reason?: string,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!transitions[item.status].includes(to)) {
    throw new DomainError(
      `Cannot move content from ${item.status} to ${to}.`,
      "invalid_transition",
      409,
    );
  }

  if (to === "approved" && !can(actor.role, "content:approve")) {
    throw new DomainError("Only an approver can approve content.", "permission_denied", 403);
  }
  if ((to === "scheduled" || to === "publishing") && !can(actor.role, "content:schedule")) {
    throw new DomainError("Only an approver can schedule content.", "permission_denied", 403);
  }
  if (item.riskLevel === "sensitive" && to === "approved" && actor.role === "creator") {
    throw new DomainError("Sensitive content requires manager approval.", "sensitive_review_required", 403);
  }
  if (to === "approved" && item.sources.length === 0) {
    throw new DomainError("At least one source is required before approval.", "source_required", 409);
  }

  const from = item.status;
  const next = { ...item, version: item.version + 1, status: to, updatedAt: now };
  return {
    item: next,
    event: event(next, actor, "content.transitioned", { from, to, reason }, now),
  };
}

export function recordApproval(
  item: ContentItem,
  actor: Actor,
  decision: Approval["decision"],
  note?: string,
  draftId?: string,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:approve")) {
    throw new DomainError("This role cannot review content.", "permission_denied", 403);
  }
  if (decision === "approved" && item.sources.length === 0) {
    throw new DomainError("At least one source is required before approval.", "source_required", 409);
  }
  const draft = draftId
    ? item.drafts.find((entry) => entry.id === draftId)
    : item.drafts.at(-1);
  if (!draft) throw new DomainError("A saved draft is required before review.", "draft_required", 409);
  const approval: Approval = {
    id: id("approval"),
    draftId: draft.id,
    draftSha256: draft.contentSha256,
    actorId: actor.id,
    actorName: actor.name,
    decision,
    ...(note ? { note } : {}),
    createdAt: now,
  };
  const nextStatus: ContentStatus = decision === "approved" ? "approved" : "drafting";
  const next = {
    ...item,
    version: item.version + 1,
    status: nextStatus,
    approvals: [...item.approvals, approval],
    updatedAt: now,
  };
  return {
    item: next,
    event: event(next, actor, "approval.recorded", { decision, approvalId: approval.id, draftId: draft.id, draftSha256: draft.contentSha256 }, now),
  };
}

export function recordInstagramCollaboratorApproval(
  item: ContentItem,
  actor: Actor,
  input: { draftId: string; accountId: string; settings: unknown; note?: string | undefined },
  now = new Date().toISOString(),
): { item: ContentItem; approval: Approval; event: AuditEvent } {
  if (!can(actor.role, "content:approve")) throw new DomainError("This role cannot approve Instagram publishing settings.", "permission_denied", 403);
  const draft = item.drafts.find((entry) => entry.id === input.draftId);
  if (!draft || draft.platform !== "instagram") throw new DomainError("An Instagram draft is required for publishing-settings approval.", "draft_not_found", 404);
  const draftApproval = item.approvals.findLast((entry) => entry.decision === "approved" && entry.draftId === draft.id && entry.draftSha256 === draft.contentSha256);
  if (!draftApproval) throw new DomainError("Approve the exact draft before approving Instagram publishing settings.", "draft_approval_required", 409);
  const settings = assertApprovedInstagramPublishSettings(input.settings);
  assertInstagramCollaboratorFormat(draft.format, settings.collaborators.length > 0);
  assertInstagramReelCoverForDraft(settings.reelCover, draft.format);
  if (!settings.collaborators.length && !settings.reelCover && settings.shareToFeed !== false && settings.isAiGenerated === undefined) throw new DomainError("Choose collaborators, Reel options, or an explicit native AI-label decision before requesting Instagram settings approval.", "instagram_publish_options_required", 409);
  const binding = bindInstagramPublishApproval({ accountId: input.accountId, draftSha256: draft.contentSha256, approvedSettingsSha256: settings.approvedSettingsSha256 });
  const approval: Approval = {
    id: id("approval"), draftId: draft.id, draftSha256: draft.contentSha256, actorId: actor.id, actorName: actor.name,
    decision: "approved", ...(input.note ? {note:input.note} : {}), instagramPublishApprovalBinding: binding, createdAt: now,
  };
  const next = { ...item, version:item.version+1, approvals:[...item.approvals,approval], updatedAt:now };
  return { item:next, approval, event:event(next,actor,"approval.instagram-publish-settings-recorded",{approvalId:approval.id,draftId:draft.id,draftSha256:draft.contentSha256,accountId:input.accountId,isAiGenerated:settings.isAiGenerated===true,approvedSettingsSha256:settings.approvedSettingsSha256,bindingSha256:binding.canonicalSha256},now) };
}

export function addReviewComment(
  item: ContentItem,
  actor: Actor,
  input: { draftId: string; audience: ReviewComment["audience"]; body: string },
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:edit") && !can(actor.role, "content:approve")) {
    throw new DomainError("This role cannot comment on reviews.", "permission_denied", 403);
  }
  const draft = item.drafts.find((entry) => entry.id === input.draftId);
  if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
  const body = input.body.trim();
  if (!body) throw new DomainError("A review comment is required.", "comment_required");
  const comment: ReviewComment = {
    id: id("comment"), draftId: draft.id, draftSha256: draft.contentSha256,
    authorId: actor.id, authorName: actor.name, audience: input.audience, body, createdAt: now,
  };
  const next = { ...item, version: item.version + 1, reviewComments: [...item.reviewComments, comment], updatedAt: now };
  return { item: next, event: event(next, actor, "review.comment-added", { commentId: comment.id, draftId: draft.id, draftSha256: draft.contentSha256, audience: comment.audience }, now) };
}

export function createReviewLink(
  item: ContentItem,
  actor: Actor,
  input: { draftId: string; expiresAt: string; allowComment: boolean },
  now = new Date().toISOString(),
): { item: ContentItem; link: ReviewLink; event: AuditEvent } {
  if (!can(actor.role, "content:edit") && !can(actor.role, "content:approve")) {
    throw new DomainError("This role cannot create review links.", "permission_denied", 403);
  }
  const draft = item.drafts.find((entry) => entry.id === input.draftId);
  if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
  if (new Date(input.expiresAt).getTime() <= new Date(now).getTime()) {
    throw new DomainError("The review link expiry must be in the future.", "invalid_expiry");
  }
  const link: ReviewLink = {
    id: id("review"),
    draftId: draft.id,
    draftSha256: draft.contentSha256,
    allowComment: input.allowComment,
    expiresAt: input.expiresAt,
    createdBy: actor.id,
    createdAt: now,
  };
  const next = { ...item, version: item.version + 1, reviewLinks: [...item.reviewLinks, link], updatedAt: now };
  return {
    item: next,
    link,
    event: event(next, actor, "review.link-created", { linkId: link.id, draftId: draft.id, draftSha256: draft.contentSha256, expiresAt: link.expiresAt, allowComment: link.allowComment }, now),
  };
}

export function revokeReviewLink(
  item: ContentItem,
  actor: Actor,
  linkId: string,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:edit") && !can(actor.role, "content:approve")) {
    throw new DomainError("This role cannot revoke review links.", "permission_denied", 403);
  }
  const link = item.reviewLinks.find((entry) => entry.id === linkId);
  if (!link) throw new DomainError("Review link not found.", "review_link_not_found", 404);
  const links = item.reviewLinks.map((entry) => entry.id === linkId ? { ...entry, revokedAt: entry.revokedAt ?? now } : entry);
  const next = { ...item, version: item.version + 1, reviewLinks: links, updatedAt: now };
  return { item: next, event: event(next, actor, "review.link-revoked", { linkId, repeated: Boolean(link.revokedAt) }, now) };
}

export function addExternalReviewComment(
  item: ContentItem,
  actor: Actor,
  input: { draftId: string; draftSha256: string; body: string },
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  const draft = item.drafts.find((entry) => entry.id === input.draftId && entry.contentSha256 === input.draftSha256);
  if (!draft) throw new DomainError("This draft revision is no longer available.", "draft_revision_not_found", 404);
  const body = input.body.trim();
  if (!body) throw new DomainError("A review comment is required.", "comment_required");
  const comment: ReviewComment = {
    id: id("comment"), draftId: draft.id, draftSha256: draft.contentSha256,
    authorId: actor.id, authorName: actor.name.trim() || "External reviewer", audience: "reviewer", body, createdAt: now,
  };
  const next = { ...item, version: item.version + 1, reviewComments: [...item.reviewComments, comment], updatedAt: now };
  return { item: next, event: event(next, actor, "review.external-comment-added", { commentId: comment.id, draftId: draft.id, draftSha256: draft.contentSha256 }, now) };
}

export function scheduleTarget(
  item: ContentItem,
  actor: Actor,
  input: ScheduleTargetInput,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:schedule")) {
    throw new DomainError("This role cannot schedule posts.", "permission_denied", 403);
  }
  return scheduleTargetAuthorized(item, actor, input, now, "publish.scheduled");
}

export function scheduleTargetFromQueue(
  item: ContentItem,
  actor: Actor,
  input: ScheduleTargetInput,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:queue")) {
    throw new DomainError("This role cannot add approved content to a posting queue.", "permission_denied", 403);
  }
  return scheduleTargetAuthorized(item, actor, input, now, "publish.queue-scheduled");
}

function scheduleTargetAuthorized(
  item: ContentItem,
  actor: Actor,
  input: ScheduleTargetInput,
  now: string,
  auditAction: "publish.scheduled" | "publish.queue-scheduled",
): { item: ContentItem; event: AuditEvent } {
  const draft = item.drafts.find((entry) => entry.id === input.draftId);
  if (!draft) throw new DomainError("The selected draft does not exist.", "draft_not_found", 404);
  if (draft.platform !== input.platform) throw new DomainError("The publish target platform must match the draft platform.", "draft_platform_mismatch", 409);
  assertFacebookPageDraftContract(draft);
  const approval = item.approvals.findLast((entry) => entry.decision === "approved" && entry.draftId === draft.id && entry.draftSha256 === draft.contentSha256);
  if (!approval) throw new DomainError("The selected draft version must be approved before scheduling.", "draft_approval_required", 409);
  if (item.status !== "approved" && item.status !== "scheduled") {
    throw new DomainError("Content must be approved before scheduling.", "approval_required", 409);
  }
  if (new Date(input.scheduledFor).getTime() <= new Date(now).getTime()) {
    throw new DomainError("Choose a publishing time in the future.", "scheduled_time_in_past", 409);
  }
  const approvedInstagramSettings = input.platform === "instagram" && input.settings
    ? assertApprovedInstagramPublishSettings(input.settings)
    : undefined;
  let instagramSettings = approvedInstagramSettings;
  const instagramOptionsNeedApproval = Boolean(approvedInstagramSettings && (approvedInstagramSettings.collaborators.length || approvedInstagramSettings.reelCover || approvedInstagramSettings.shareToFeed === false || approvedInstagramSettings.isAiGenerated !== undefined));
  if(instagramOptionsNeedApproval && approvedInstagramSettings){
    assertInstagramCollaboratorFormat(draft.format, approvedInstagramSettings.collaborators.length > 0);
    const settingsApproval=item.approvals.findLast((entry)=>entry.decision==="approved"&&entry.draftId===draft.id&&entry.draftSha256===draft.contentSha256&&entry.instagramPublishApprovalBinding?.accountId===input.accountId&&entry.instagramPublishApprovalBinding.approvedSettingsSha256===approvedInstagramSettings.approvedSettingsSha256);
    if(!settingsApproval?.instagramPublishApprovalBinding)throw new DomainError("A human must approve the exact Instagram publishing settings and account before scheduling.","instagram_publish_settings_approval_required",409);
    const approvalBinding=assertInstagramPublishApprovalBinding(settingsApproval.instagramPublishApprovalBinding,{platform:"instagram",accountId:input.accountId,draftSha256:draft.contentSha256,approvedSettingsSha256:approvedInstagramSettings.approvedSettingsSha256});
    instagramSettings={...approvedInstagramSettings,approvalBinding};
  }
  if (instagramSettings) {
    assertInstagramCollaboratorFormat(draft.format, instagramSettings.collaborators.length > 0);
    assertInstagramReelCoverForDraft(instagramSettings.reelCover, draft.format);
    if (instagramSettings.collaborators.length > 0 && (input.deliveryMode ?? "auto_publish") !== "auto_publish") {
      throw new DomainError(
        "Automatic Instagram publishing is required to request collaborator invitations.",
        "instagram_collaborators_format_unsupported",
        409,
      );
    }
  }
  const { targetId, ...targetInput } = input;
  const target: PublishTarget = {
    ...targetInput,
    ...(instagramSettings ? { settings: instagramSettings } : {}),
    deliveryMode: targetInput.deliveryMode ?? "auto_publish",
    id: targetId ?? id("target"),
    status: "queued",
  };
  const next = {
    ...item,
    version: item.version + 1,
    status: "scheduled" as const,
    targets: [...item.targets, target],
    updatedAt: now,
  };
  return {
    item: next,
    event: event(next, actor, auditAction, {
      targetId: target.id,
      platform: target.platform,
      deliveryMode: target.deliveryMode,
      ...(target.platform === "youtube" && target.settings && "privacyStatus" in target.settings ? {
        privacyStatus: target.settings.privacyStatus,
        madeForKids: target.settings.madeForKids,
        containsSyntheticMedia: target.settings.containsSyntheticMedia,
        notifySubscribers: target.settings.notifySubscribers,
        ...(target.settings.timezone ? { timezone: target.settings.timezone } : {}),
      } : {}),
      ...(target.platform === "instagram" && instagramSettings ? {
        collaborators: instagramSettings.collaborators,
        shareToFeed: instagramSettings.shareToFeed !== false,
        isAiGenerated: instagramSettings.isAiGenerated === true,
        ...(instagramSettings.reelCover ? { reelCover: instagramSettings.reelCover } : {}),
        approvedSettingsSha256: instagramSettings.approvedSettingsSha256,
      } : {}),
    }, now),
  };
}

export function rescheduleTarget(
  item: ContentItem,
  targetId: string,
  input: { scheduledFor: string; timezone?: string | undefined },
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; target: PublishTarget; event: AuditEvent } {
  if (!can(actor.role, "content:schedule")) throw new DomainError("This role cannot reschedule posts.", "permission_denied", 403);
  const current = item.targets.find((entry) => entry.id === targetId);
  if (!current) throw new DomainError("Publish target not found.", "target_not_found", 404);
  if (current.status !== "queued" && current.status !== "pending") {
    throw new DomainError("Only a post that is still waiting can be rescheduled.", "target_not_reschedulable", 409);
  }
  if (new Date(input.scheduledFor).getTime() <= new Date(now).getTime()) {
    throw new DomainError("Choose a publishing time in the future.", "scheduled_time_in_past", 409);
  }
  const replacement: PublishTarget = {
    ...current,
    id: id("target"),
    scheduledFor: input.scheduledFor,
    ...(input.timezone ? { timezone: input.timezone } : current.timezone ? { timezone: current.timezone } : {}),
    status: "queued",
    actionRequiredAt: undefined,
    acknowledgedAt: undefined,
    acknowledgedBy: undefined,
    queueAssignment: undefined,
  };
  const targets = item.targets.map((entry) => entry.id === targetId ? { ...entry, status: "cancelled" as const } : entry);
  const next = { ...item, version: item.version + 1, status: "scheduled" as const, targets: [...targets, replacement], updatedAt: now };
  return {
    item: next,
    target: replacement,
    event: event(next, actor, "publish.rescheduled", {
      previousTargetId: targetId,
      targetId: replacement.id,
      previousScheduledFor: current.scheduledFor,
      scheduledFor: replacement.scheduledFor,
      ...(current.queueAssignment ? { releasedQueueReservationId: current.queueAssignment.reservationId } : {}),
      ...(replacement.timezone ? { timezone: replacement.timezone } : {}),
    }, now),
  };
}

export function cancelTarget(
  item: ContentItem,
  targetId: string,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:schedule")) throw new DomainError("This role cannot cancel scheduled posts.", "permission_denied", 403);
  const current = item.targets.find((entry) => entry.id === targetId);
  if (!current) throw new DomainError("Publish target not found.", "target_not_found", 404);
  if (current.status === "cancelled") {
    const repeated = { ...item, version: item.version + 1, updatedAt: now };
    return { item: repeated, event: event(repeated, actor, "publish.cancelled", { targetId, repeated: true }, now) };
  }
  if (current.status !== "queued" && current.status !== "pending") {
    throw new DomainError("Only a post that is still waiting can be cancelled.", "target_not_cancellable", 409);
  }
  const targets = item.targets.map((entry) => entry.id === targetId ? { ...entry, status: "cancelled" as const } : entry);
  const hasActiveTarget = targets.some((entry) => !["cancelled", "failed", "published"].includes(entry.status));
  const next = {
    ...item,
    version: item.version + 1,
    status: item.status === "scheduled" && !hasActiveTarget ? "approved" as const : item.status,
    targets,
    updatedAt: now,
  };
  return { item: next, event: event(next, actor, "publish.cancelled", { targetId, scheduledFor: current.scheduledFor }, now) };
}

export function markTargetStatus(
  item: ContentItem,
  targetId: string,
  status: PublishTarget["status"],
  actor: Actor,
  detail: Record<string, unknown> = {},
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
  const targets = item.targets.map((entry) => entry.id === targetId ? {
    ...entry,
    status,
    ...(status === "action_required" ? { actionRequiredAt: now } : {}),
    ...(status === "acknowledged" ? { acknowledgedAt: now, acknowledgedBy: actor.id } : {}),
  } : entry);
  const nextStatus: ContentStatus = status === "publishing"
    ? "publishing"
    : status === "action_required" || status === "acknowledged"
      ? "action_required"
    : status === "failed"
      ? "failed"
      : item.status;
  const next = { ...item, version: item.version + 1, status: nextStatus, targets, updatedAt: now };
  return {
    item: next,
    event: event(next, actor, "publish.target_status", { targetId, status, ...detail }, now),
  };
}

export function acknowledgeManualHandoff(
  item: ContentItem,
  targetId: string,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:publish")) throw new DomainError("This role cannot acknowledge publishing work.", "permission_denied", 403);
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
  if (target.deliveryMode !== "manual_handoff") throw new DomainError("This target does not use manual handoff.", "manual_handoff_required", 409);
  if (target.status !== "action_required" && target.status !== "acknowledged") throw new DomainError("This handoff is not waiting for acknowledgement.", "handoff_not_ready", 409);
  if (target.status === "acknowledged") {
    const repeated = { ...item, version: item.version + 1, updatedAt: now };
    return { item: repeated, event: event(repeated, actor, "publish.handoff_acknowledged", { targetId, repeated: true }, now) };
  }
  return markTargetStatus(item, targetId, "acknowledged", actor, { deliveryMode: target.deliveryMode }, now);
}

export function confirmManualPublication(
  item: ContentItem,
  targetId: string,
  input: {
    externalPostId: string;
    liveUrl: string;
    publishedAt: string;
    mediaSha256: string[];
    disclosure: PublishProof["disclosure"];
    screenshotUrl?: string | undefined;
    collaboratorInviteProof?: PublishProof["collaboratorInviteProof"] | undefined;
  },
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:publish")) throw new DomainError("This role cannot confirm publishing results.", "permission_denied", 403);
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
  if (target.deliveryMode !== "manual_handoff") throw new DomainError("This target does not use manual handoff.", "manual_handoff_required", 409);
  if (target.status !== "action_required" && target.status !== "acknowledged") throw new DomainError("This handoff is not ready to confirm.", "handoff_not_ready", 409);
  const draft = item.drafts.find((entry) => entry.id === target.draftId);
  if (!draft) throw new DomainError("Platform draft not found.", "draft_not_found", 404);
  const approval = item.approvals.findLast((entry) => entry.decision === "approved" && entry.draftId === draft.id && entry.draftSha256 === draft.contentSha256);
  if (!approval) throw new DomainError("The exact draft revision is no longer approved.", "draft_approval_required", 409);
  if (target.platform === "instagram") {
    const requested = target.settings?.isAiGenerated === true;
    const observed = input.disclosure === "ai-assisted";
    if (requested !== observed) throw new DomainError("The manual Instagram proof must match the exact approved native AI-label choice.", "instagram_ai_disclosure_attestation_mismatch", 409);
  }
  if (item.proofs.some((proof) => proof.platform === target.platform && proof.accountId === target.accountId && proof.externalPostId === input.externalPostId)) {
    throw new DomainError("This manual publication is already recorded.", "proof_exists", 409);
  }
  const attempt: PublishAttempt = {
    id: id("attempt"),
    targetId,
    attemptNo: item.publishAttempts.filter((entry) => entry.targetId === targetId).length + 1,
    idempotencyKey: `manual:${target.id}:v1`,
    status: "published",
    externalPostId: input.externalPostId,
    startedAt: now,
    completedAt: now,
  };
  const proof: PublishProof = {
    id: id("proof"),
    contentItemId: item.id,
    draftId: draft.id,
    draftSha256: draft.contentSha256,
    platform: target.platform,
    accountId: target.accountId,
    externalPostId: input.externalPostId,
    liveUrl: input.liveUrl,
    publishedAt: input.publishedAt,
    captionSha256: createHash("sha256").update(draft.caption).digest("hex"),
    mediaSha256: input.mediaSha256,
    connectorResponseSha256: createHash("sha256").update(JSON.stringify({ mode: "manual_handoff", liveUrl: input.liveUrl, externalPostId: input.externalPostId })).digest("hex"),
    approvedBy: approval.actorId,
    sourceIds: item.sources.map((source) => source.id),
    disclosure: target.platform === "instagram" ? target.settings?.isAiGenerated === true ? "ai-assisted" : "none" : input.disclosure,
    evidenceMode: "manual_attestation",
    ...(target.platform === "instagram" && (target.settings?.isAiGenerated === true || input.disclosure === "ai-assisted") ? {
      instagramAiDisclosure: { requested: target.settings?.isAiGenerated === true, observed: input.disclosure === "ai-assisted", label: "ai_info" as const },
    } : {}),
    ...(target.platform === "instagram" && target.settings && typeof target.settings.approvedSettingsSha256 === "string"
      ? { approvedSettingsSha256: target.settings.approvedSettingsSha256 }
      : {}),
    ...(target.platform === "instagram" && input.collaboratorInviteProof ? { collaboratorInviteProof: input.collaboratorInviteProof } : {}),
    ...(target.platform === "instagram" && target.settings?.reelCover ? { instagramReelCoverProof: target.settings.reelCover as PublishProof["instagramReelCoverProof"] } : {}),
    ...(input.screenshotUrl ? { screenshotUrl: input.screenshotUrl } : {}),
  };
  const targets = item.targets.map((entry) => entry.id === targetId ? { ...entry, status: "published" as const } : entry);
  const next = {
    ...item,
    version: item.version + 1,
    status: "published" as const,
    targets,
    publishAttempts: [...item.publishAttempts, attempt],
    proofs: [...item.proofs, proof],
    updatedAt: now,
  };
  return { item: next, event: event(next, actor, "publish.manual_confirmed", { targetId, attemptId: attempt.id, proofId: proof.id, liveUrl: proof.liveUrl }, now) };
}

export function confirmProviderPublication(
  item: ContentItem,
  targetId: string,
  input: {
    providerOperationId: string;
    externalPostId: string;
    liveUrl: string;
    publishedAt: string;
    mediaSha256: string[];
    disclosure: PublishProof["disclosure"];
    instagramAiDisclosureObserved?: boolean | undefined;
    screenshotUrl?: string | undefined;
    collaboratorInviteProof?: PublishProof["collaboratorInviteProof"] | undefined;
  },
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:publish")) throw new DomainError("This role cannot confirm publishing results.", "permission_denied", 403);
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
  if (target.deliveryMode !== "auto_publish") throw new DomainError("This target is not an automatic provider publication.", "auto_publish_required", 409);
  if (target.status !== "action_required") throw new DomainError("This provider result is not waiting for review.", "provider_reconciliation_not_ready", 409);
  const draft = item.drafts.find((entry) => entry.id === target.draftId);
  if (!draft) throw new DomainError("Platform draft not found.", "draft_not_found", 404);
  const approval = item.approvals.findLast((entry) => entry.decision === "approved" && entry.draftId === draft.id && entry.draftSha256 === draft.contentSha256);
  if (!approval) throw new DomainError("The exact draft revision is no longer approved.", "draft_approval_required", 409);
  if (target.platform === "instagram" && target.settings?.isAiGenerated === true && input.instagramAiDisclosureObserved !== true) {
    throw new DomainError("Provider reconciliation must verify Instagram's native AI info label before recording proof.", "instagram_ai_disclosure_unverified", 409);
  }
  if (item.proofs.some((proof) => proof.platform === target.platform && proof.accountId === target.accountId && proof.externalPostId === input.externalPostId)) throw new DomainError("This publication is already recorded.", "proof_exists", 409);

  let attemptId: string;
  const startedAttempt = item.publishAttempts.findLast((entry) => entry.targetId === targetId && entry.status === "started");
  const publishAttempts = startedAttempt
    ? item.publishAttempts.map((entry) => entry.id === startedAttempt.id ? { ...entry, status: "published" as const, externalPostId: input.externalPostId, completedAt: now } : entry)
    : [...item.publishAttempts, {
        id: id("attempt"), targetId, attemptNo: item.publishAttempts.filter((entry) => entry.targetId === targetId).length + 1,
        idempotencyKey: `reconcile:${target.id}:v1`, status: "published" as const, externalPostId: input.externalPostId, startedAt: now, completedAt: now,
      }];
  attemptId = startedAttempt?.id ?? publishAttempts.at(-1)!.id;
  const proof: PublishProof = {
    id: id("proof"), contentItemId: item.id, draftId: draft.id, draftSha256: draft.contentSha256, platform: target.platform, accountId: target.accountId,
    externalPostId: input.externalPostId, liveUrl: input.liveUrl, publishedAt: input.publishedAt,
    captionSha256: createHash("sha256").update(draft.caption).digest("hex"), mediaSha256: input.mediaSha256,
    connectorResponseSha256: createHash("sha256").update(JSON.stringify({ mode: "provider_reconciliation", providerOperationId: input.providerOperationId, liveUrl: input.liveUrl, externalPostId: input.externalPostId })).digest("hex"),
    approvedBy: approval.actorId,
    sourceIds: item.sources.map((source) => source.id),
    disclosure: target.platform === "youtube"
      ? target.settings && "containsSyntheticMedia" in target.settings && target.settings.containsSyntheticMedia === true ? "synthetic-media" : "none"
      : target.platform === "instagram" && target.settings?.isAiGenerated === true ? "ai-assisted" : input.disclosure,
    evidenceMode: "provider_reconciliation",
    ...(target.platform === "instagram" && (target.settings?.isAiGenerated === true || input.instagramAiDisclosureObserved === true) ? { instagramAiDisclosure: { requested: target.settings?.isAiGenerated === true, observed: input.instagramAiDisclosureObserved === true, label: "ai_info" as const } } : {}),
    ...(target.platform === "instagram" && target.settings && typeof target.settings.approvedSettingsSha256 === "string"
      ? { approvedSettingsSha256: target.settings.approvedSettingsSha256 }
      : {}),
    ...(target.platform === "instagram" && input.collaboratorInviteProof ? { collaboratorInviteProof: input.collaboratorInviteProof } : {}),
    ...(target.platform === "instagram" && target.settings?.reelCover ? { instagramReelCoverProof: target.settings.reelCover as PublishProof["instagramReelCoverProof"] } : {}),
    ...(input.screenshotUrl ? { screenshotUrl: input.screenshotUrl } : {}),
  };
  const targets = item.targets.map((entry) => entry.id === targetId ? { ...entry, status: "published" as const } : entry);
  const next = { ...item, version: item.version + 1, status: "published" as const, targets, publishAttempts, proofs: [...item.proofs, proof], updatedAt: now };
  return { item: next, event: event(next, actor, "publish.provider_reconciled", { targetId, providerOperationId: input.providerOperationId, attemptId, proofId: proof.id, liveUrl: proof.liveUrl }, now) };
}

export function startPublishAttempt(
  item: ContentItem,
  targetId: string,
  idempotencyKey: string,
  actor: Actor,
  jobId?: string,
  now = new Date().toISOString(),
): { item: ContentItem; attempt: PublishAttempt; event: AuditEvent } {
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
  const attempt: PublishAttempt = {
    id: id("attempt"),
    targetId,
    attemptNo: item.publishAttempts.filter((entry) => entry.targetId === targetId).length + 1,
    ...(jobId ? { jobId } : {}),
    idempotencyKey,
    status: "started",
    startedAt: now,
  };
  const next = { ...item, version: item.version + 1, publishAttempts: [...item.publishAttempts, attempt], updatedAt: now };
  return {
    item: next,
    attempt,
    event: event(next, actor, "publish.attempt_started", { attemptId: attempt.id, targetId, attemptNo: attempt.attemptNo, idempotencyKey }, now),
  };
}

export function finishPublishAttempt(
  item: ContentItem,
  attemptId: string,
  result: { status: "published"; externalPostId: string } | { status: "failed"; error: string },
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  const attempt = item.publishAttempts.find((entry) => entry.id === attemptId);
  if (!attempt) throw new DomainError("Publish attempt not found.", "attempt_not_found", 404);
  const publishAttempts = item.publishAttempts.map((entry) => entry.id === attemptId ? {
    ...entry,
    status: result.status,
    ...(result.status === "published" ? { externalPostId: result.externalPostId } : { error: result.error.slice(0, 500) }),
    completedAt: now,
  } : entry);
  const next = { ...item, version: item.version + 1, publishAttempts, updatedAt: now };
  return {
    item: next,
    event: event(next, actor, `publish.attempt_${result.status}`, { attemptId, targetId: attempt.targetId, attemptNo: attempt.attemptNo, ...result }, now),
  };
}

/**
 * Commits the provider result as one content transition. Keeping the attempt,
 * target, and immutable proof in one version prevents recovery from observing a
 * target that is published but has no proof.
 */
export function completeAutomaticPublication(
  item: ContentItem,
  attemptId: string,
  targetId: string,
  proof: Omit<PublishProof, "id" | "contentItemId">,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:publish")) throw new DomainError("This role cannot record publishing results.", "permission_denied", 403);
  const target = item.targets.find((entry) => entry.id === targetId);
  if (!target) throw new DomainError("Publish target not found.", "target_not_found", 404);
  if (target.deliveryMode !== "auto_publish") throw new DomainError("This target is not an automatic provider publication.", "auto_publish_required", 409);
  const attempt = item.publishAttempts.find((entry) => entry.id === attemptId);
  if (!attempt || attempt.targetId !== targetId) throw new DomainError("Publish attempt not found.", "attempt_not_found", 404);
  if (attempt.status === "failed") throw new DomainError("A failed publish attempt cannot be completed.", "attempt_already_failed", 409);
  if (item.proofs.some((entry) => entry.draftId === proof.draftId && entry.platform === proof.platform && entry.accountId === proof.accountId && entry.externalPostId === proof.externalPostId)) {
    throw new DomainError("This publication is already recorded.", "proof_exists", 409);
  }
  const completeProof: PublishProof = { ...proof, id: id("proof"), contentItemId: item.id };
  const publishAttempts = item.publishAttempts.map((entry) => entry.id === attemptId ? {
    ...entry,
    status: "published" as const,
    externalPostId: proof.externalPostId,
    completedAt: now,
    error: undefined,
  } : entry);
  const targets = item.targets.map((entry) => entry.id === targetId ? { ...entry, status: "published" as const } : entry);
  const next = {
    ...item,
    version: item.version + 1,
    status: "published" as const,
    publishAttempts,
    targets,
    proofs: [...item.proofs, completeProof],
    updatedAt: now,
  };
  return {
    item: next,
    event: event(next, actor, "publish.completed", {
      attemptId,
      targetId,
      proofId: completeProof.id,
      externalPostId: completeProof.externalPostId,
      liveUrl: completeProof.liveUrl,
    }, now),
  };
}

export function attachProof(
  item: ContentItem,
  proof: Omit<PublishProof, "id" | "contentItemId">,
  actor: Actor,
  now = new Date().toISOString(),
): { item: ContentItem; event: AuditEvent } {
  if (!can(actor.role, "content:publish")) {
    throw new DomainError("This role cannot record publishing results.", "permission_denied", 403);
  }
  const completeProof: PublishProof = {
    ...proof,
    id: id("proof"),
    contentItemId: item.id,
  };
  const next = {
    ...item,
    version: item.version + 1,
    status: "published" as const,
    proofs: [...item.proofs, completeProof],
    updatedAt: now,
  };
  return {
    item: next,
    event: event(next, actor, "publish.proof_recorded", {
      proofId: completeProof.id,
      platform: completeProof.platform,
      liveUrl: completeProof.liveUrl,
    }, now),
  };
}

export function allowedTransitions(status: ContentStatus): readonly ContentStatus[] {
  return transitions[status];
}
