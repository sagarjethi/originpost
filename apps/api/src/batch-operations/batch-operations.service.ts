import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { addBatchRowDiagnostics, batchContentItemId, batchTargetId, can, createBatchPlan, summarizeBatchPlan, validateMeasuredMedia, type Actor, type AuditEvent, type BatchPlan, type BatchPlanRow, type ContentItem, type MeasuredPublishMedia, type PlatformDraft } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { ContentService } from "../content/content.service.js";
import type { ApproveBatchDto, PreviewBatchDto } from "./batch-operations.dto.js";

function audit(plan: Pick<BatchPlan, "workspaceId" | "id" | "brandId">, actor: Actor, action: string, detail: Record<string, unknown>): AuditEvent { return { id: `audit_${randomUUID()}`, workspaceId: plan.workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human", action, detail: { batchPlanId: plan.id, brandId: plan.brandId, ...detail }, createdAt: new Date().toISOString() }; }
function sameStrings(a: readonly string[], b: readonly string[]) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function exactDraft(item: ContentItem, row: BatchPlanRow): PlatformDraft | undefined { return item.drafts.find((draft) => draft.platform === row.platform && draft.format === row.format && draft.title === row.title && draft.caption === row.caption && sameStrings(draft.mediaIds, row.mediaAssetIds)); }
const batchLeaseMilliseconds = 5 * 60_000;
function processingRecoverableAt(plan: BatchPlan) { return new Date(Date.parse(plan.updatedAt) + batchLeaseMilliseconds).toISOString(); }
function planSummary(plan: BatchPlan) { return { ...plan, counts: Object.fromEntries(["invalid", "ready", "review_ready", "individual_review", "approved", "scheduled", "failed"].map((status) => [status, plan.rows.filter((row) => row.status === status).length])), ...(plan.status === "processing" ? { processingRecoverableAt: processingRecoverableAt(plan) } : {}) }; }

@Injectable()
export class BatchOperationsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, private readonly content: ContentService) {}
  private requireHuman(actor: Actor) { if (actor.actorType && actor.actorType !== "human") throw new ForbiddenException("Batch operations require a signed-in person."); }
  private requireCreator(actor: Actor) { this.requireHuman(actor); if (!can(actor.role, "content:create") || !can(actor.role, "content:edit")) throw new ForbiddenException("You cannot create batch drafts."); }
  private requireApprover(actor: Actor) { this.requireHuman(actor); if (!can(actor.role, "content:approve") || !can(actor.role, "content:schedule")) throw new ForbiddenException("Only a manager or owner can approve and schedule a batch."); }

  async list(workspaceId: string, brandId: string | undefined, limit: number, actor: Actor) { if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view batch operations."); return (await this.infrastructure.batchPlanRepository.list(workspaceId, brandId, limit)).map(planSummary); }
  async get(workspaceId: string, id: string, actor: Actor) { if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view batch operations."); const plan = await this.infrastructure.batchPlanRepository.get(workspaceId, id); if (!plan) throw new NotFoundException("Batch plan not found."); return planSummary(plan); }

  async preview(workspaceId: string, dto: PreviewBatchDto, actor: Actor) {
    this.requireCreator(actor); const brand = await this.infrastructure.organizationRepository.getBrand(workspaceId, dto.brandId); if (!brand || brand.status !== "active") throw new NotFoundException("Active brand not found.");
    let plan = createBatchPlan({ id: `batch_${randomUUID()}`, workspaceId, brandId: dto.brandId, name: dto.name, rows: dto.rows, actor }); const diagnostics = new Map<number, { errors: string[]; warnings: string[] }>(); const mediaUse = new Map<string, number[]>();
    for (const row of plan.rows) {
      const errors: string[] = []; const warnings: string[] = []; const measuredMedia: MeasuredPublishMedia[] = [];
      for (const mediaId of row.mediaAssetIds) {
        const asset = await this.infrastructure.mediaRepository.get(workspaceId, mediaId);
        if (!asset || asset.brandId !== dto.brandId) { errors.push(`Media ${mediaId} is outside this brand or missing.`); continue; }
        if (asset.status !== "ready") errors.push(`${asset.fileName} is not ready.`); if ((asset.kind === "image" || asset.kind === "video") && asset.inspectionStatus !== "ready") errors.push(`${asset.fileName} has no trusted inspection result.`);
        if (asset.malwareScanStatus !== undefined && asset.malwareScanStatus !== "clean" && asset.malwareScanStatus !== "disabled") errors.push(`${asset.fileName} has not passed malware scanning.`);
        if (asset.purpose !== "creative") errors.push(`${asset.fileName} is not creative media.`); if (asset.rights !== "owned" && asset.rights !== "cleared") errors.push(`${asset.fileName} needs owned or cleared rights.`);
        if (["reel", "short"].includes(row.format) && asset.kind !== "video") errors.push(`${asset.fileName} must be a video for ${row.format}.`); if (["image", "carousel"].includes(row.format) && asset.kind !== "image") errors.push(`${asset.fileName} must be an image for ${row.format}.`);
        if (asset.kind === "image" || asset.kind === "video") measuredMedia.push({ id: asset.id, type: asset.kind, mimeType: asset.detectedContentType ?? asset.contentType, inspectionStatus: asset.inspectionStatus, malwareScanStatus: asset.malwareScanStatus, rights: asset.rights, ...(asset.widthPixels !== undefined ? { widthPixels: asset.widthPixels } : {}), ...(asset.heightPixels !== undefined ? { heightPixels: asset.heightPixels } : {}), ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}) });
        mediaUse.set(asset.sha256, [...(mediaUse.get(asset.sha256) ?? []), row.rowNumber]);
      }
      if (row.platform === "instagram" && row.format === "story") for (const issue of validateMeasuredMedia({ platform: row.platform, format: row.format, media: measuredMedia })) if (!errors.includes(issue.message)) errors.push(issue.message);
      if (row.accountId) { const account = await this.infrastructure.connectedAccountRepository.get(workspaceId, row.accountId); if (!account || account.brandId !== dto.brandId) errors.push("The publishing account is outside this brand or missing."); else { if (account.platform !== row.platform) errors.push("The publishing account platform does not match the draft."); if (account.status !== "healthy" && account.status !== "expiring") errors.push("The publishing account is not ready."); } }
      diagnostics.set(row.rowNumber, { errors, warnings });
    }
    for (const rows of mediaUse.values()) if (rows.length > 1) for (const rowNumber of rows) diagnostics.get(rowNumber)!.warnings.push("The same media bytes are used in another row. Check that this is intentional.");
    plan = addBatchRowDiagnostics(plan, diagnostics); const result = await this.infrastructure.batchPlanRepository.create(plan, audit(plan, actor, "batch.preview-created", { rows: plan.rows.length, ready: plan.rows.filter((row) => row.status === "ready").length, invalid: plan.rows.filter((row) => row.status === "invalid").length, sourceSha256: plan.sourceSha256 }));
    return { data: planSummary(result.plan), meta: { idempotentReplay: !result.created } };
  }

  private async claim(plan: BatchPlan, actor: Actor, action: string) {
    if (plan.status === "archived") throw new ConflictException("Archived batches cannot be changed.");
    if (plan.status === "processing" && Date.parse(plan.updatedAt) + batchLeaseMilliseconds > Date.now()) throw new ConflictException(`This batch operation is still running. Refresh after ${processingRecoverableAt(plan)} if it does not finish.`);
    const now = new Date().toISOString(); const next = { ...plan, version: plan.version + 1, status: "processing" as const, updatedAt: now };
    const claimed = await this.infrastructure.batchPlanRepository.replace(plan.workspaceId, plan.id, plan.version, next, audit(plan, actor, action, { expectedVersion: plan.version, recoveredStaleRun: plan.status === "processing" }));
    if (!claimed) throw new ConflictException("This batch changed. Refresh before continuing."); return claimed;
  }
  private async checkpoint(plan: BatchPlan, rows: BatchPlanRow[], actor: Actor, action: string, rowNumber: number) {
    const now = new Date().toISOString(); const next: BatchPlan = { ...plan, version: plan.version + 1, rows, status: "processing", updatedAt: now };
    const saved = await this.infrastructure.batchPlanRepository.replace(plan.workspaceId, plan.id, plan.version, next, audit(plan, actor, action, { rowNumber }));
    if (!saved) throw new ConflictException("This batch changed while a row was being saved. Refresh before continuing."); return saved;
  }
  private async finish(plan: BatchPlan, rows: BatchPlanRow[], actor: Actor, action: string) { const now = new Date().toISOString(); const next: BatchPlan = { ...plan, version: plan.version + 1, rows, status: summarizeBatchPlan(rows), updatedAt: now, committedAt: plan.committedAt ?? now }; const saved = await this.infrastructure.batchPlanRepository.replace(plan.workspaceId, plan.id, plan.version, next, audit(plan, actor, action, { status: next.status, ready: rows.filter((row) => row.status === "review_ready").length, failed: rows.filter((row) => row.status === "failed").length })); if (!saved) throw new ConflictException("This batch changed while the operation was finishing. Refresh to see the durable row results."); return planSummary(saved); }

  async commit(workspaceId: string, id: string, version: number, actor: Actor) {
    this.requireCreator(actor); const found = await this.infrastructure.batchPlanRepository.get(workspaceId, id); if (!found) throw new NotFoundException("Batch plan not found."); if (found.version !== version) throw new ConflictException("This batch changed. Refresh before committing."); let working = await this.claim(found, actor, "batch.prepare-started");
    for (const row of [...working.rows]) {
      if (row.status === "invalid" || ["review_ready", "individual_review", "approved", "scheduled"].includes(row.status) || (row.status === "failed" && row.failedStep !== "prepare")) continue;
      const contentItemId = batchContentItemId(working, row); let result: BatchPlanRow;
      try {
        let item = await this.infrastructure.repository.get(workspaceId, contentItemId); if (!item) item = await this.content.create({ workspaceId, brandId: working.brandId, contentId: contentItemId, title: row.title, summary: row.summary, researchDepth: row.researchDepth, riskLevel: row.riskLevel }, actor);
        if (item.brandId !== working.brandId || item.title !== row.title) throw new ConflictException("The deterministic Content Item already contains different data.");
        for (const mediaId of row.mediaAssetIds) {
          const asset = await this.infrastructure.mediaRepository.get(workspaceId, mediaId);
          if (asset && !item.sources.some((source) => source.sha256 === asset.sha256)) item = await this.content.addSource(workspaceId, item.id, { kind: asset.kind === "video" ? "video" : "image", title: asset.fileName, sha256: asset.sha256, rights: asset.rights, confidence: 100, notes: `Owned batch media ${asset.id}` }, actor, item.version);
        }
        let draft = exactDraft(item, row);
        if (!draft) { item = await this.content.addDraft(workspaceId, item.id, { platform: row.platform, format: row.format, title: row.title, caption: row.caption, mediaIds: row.mediaAssetIds }, actor, item.version); draft = item.drafts.at(-1); }
        if (!draft) throw new Error("Draft creation did not return a draft."); if (!["review", "approved", "scheduled"].includes(item.status)) item = await this.content.transition(workspaceId, item.id, { to: "review", reason: `Prepared in batch “${working.name}”` }, actor, item.version);
        result = { ...row, contentItemId: item.id, draftId: draft.id, status: row.bulkApprovalEligible ? "review_ready" : "individual_review", errors: [], failedStep: undefined };
      } catch (error) { result = { ...row, contentItemId, status: "failed", failedStep: "prepare", errors: [error instanceof Error ? error.message : "Could not prepare this row."] }; }
      const rows = working.rows.map((entry) => entry.rowNumber === row.rowNumber ? result : entry); working = await this.checkpoint(working, rows, actor, "batch.prepare-row-saved", row.rowNumber);
    }
    return { data: await this.finish(working, working.rows, actor, "batch.prepare-finished") };
  }

  async approve(workspaceId: string, id: string, dto: ApproveBatchDto, actor: Actor) {
    this.requireApprover(actor); const found = await this.infrastructure.batchPlanRepository.get(workspaceId, id); if (!found) throw new NotFoundException("Batch plan not found."); if (found.version !== dto.version) throw new ConflictException("This batch changed. Refresh before approving."); if (dto.confirmation.trim() !== `APPROVE ${dto.rowNumbers.length}`) throw new ConflictException(`Type APPROVE ${dto.rowNumbers.length} to confirm this human approval.`);
    const selected = new Set(dto.rowNumbers); let working = await this.claim(found, actor, "batch.approval-started");
    for (const row of [...working.rows]) {
      if (!selected.has(row.rowNumber)) continue; let result: BatchPlanRow;
      if (!row.bulkApprovalEligible || row.status === "individual_review") result = { ...row, status: "individual_review", warnings: [...row.warnings, "Open the Content Item and approve this row individually."] };
      else if (!row.contentItemId || !row.draftId) result = { ...row, status: "failed", failedStep: "approval", errors: ["Prepare this row before approval."] };
      else {
        let step: "approval" | "schedule" = "approval";
      try {
        let item = await this.content.get(workspaceId, row.contentItemId); const draft = item.drafts.find((entry) => entry.id === row.draftId); const expected = exactDraft(item, row); if (!draft || !expected || draft.id !== expected.id || draft.contentSha256 !== expected.contentSha256) throw new ConflictException("The prepared draft changed. Review it individually.");
        const approved = item.approvals.some((entry) => entry.decision === "approved" && entry.draftId === draft.id && entry.draftSha256 === draft.contentSha256); if (!approved) item = await this.content.approve(workspaceId, item.id, { decision: "approved", draftId: draft.id, note: `Human batch approval: ${working.name}` }, actor, item.version);
        if (row.accountId && row.scheduledFor) {
          step = "schedule"; const targetId = batchTargetId(working, row); const existing = item.targets.find((entry) => entry.id === targetId);
          if (existing && (existing.platform !== row.platform || existing.accountId !== row.accountId || existing.draftId !== draft.id || existing.scheduledFor !== row.scheduledFor)) throw new ConflictException("The deterministic schedule already contains different data.");
          if (!existing) { const settings = row.platform === "youtube" ? { title: draft.title, description: draft.caption, privacyStatus: row.youtubeSettings!.privacyStatus, madeForKids: row.youtubeSettings!.madeForKids, containsSyntheticMedia: row.youtubeSettings!.containsSyntheticMedia, notifySubscribers: row.youtubeSettings!.notifySubscribers, ...(row.timezone ? { timezone: row.timezone } : {}) } : undefined; item = await this.content.schedule(workspaceId, item.id, { targetId, platform: row.platform, accountId: row.accountId, draftId: draft.id, scheduledFor: row.scheduledFor, ...(row.timezone ? { timezone: row.timezone } : {}), deliveryMode: row.deliveryMode, ...(settings ? { settings } : {}) }, actor, item.version); }
          result = { ...row, targetId, status: "scheduled", errors: [], failedStep: undefined };
        } else result = { ...row, status: "approved", errors: [], failedStep: undefined };
      } catch (error) { result = { ...row, status: "failed", failedStep: step, errors: [error instanceof Error ? error.message : "Could not approve this row."] }; }
      }
      const rows = working.rows.map((entry) => entry.rowNumber === row.rowNumber ? result : entry); working = await this.checkpoint(working, rows, actor, "batch.approval-row-saved", row.rowNumber);
    }
    return { data: await this.finish(working, working.rows, actor, "batch.approval-finished") };
  }

  async archive(workspaceId: string, id: string, version: number, actor: Actor) { this.requireApprover(actor); const found = await this.infrastructure.batchPlanRepository.get(workspaceId, id); if (!found) throw new NotFoundException("Batch plan not found."); if (found.version !== version) throw new ConflictException("This batch changed. Refresh before archiving."); if (found.status === "processing") throw new ConflictException("Recover the interrupted batch before archiving it."); const now = new Date().toISOString(); const next = { ...found, version: found.version + 1, status: "archived" as const, archivedAt: now, updatedAt: now }; const saved = await this.infrastructure.batchPlanRepository.replace(workspaceId, id, found.version, next, audit(found, actor, "batch.archived", {})); if (!saved) throw new ConflictException("This batch changed. Refresh before archiving."); return { data: planSummary(saved) }; }
}
