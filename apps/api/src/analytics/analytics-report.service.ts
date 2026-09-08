import { createHash, randomBytes } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  analyticsReportCsv,
  archiveAnalyticsReportDefinition,
  can,
  createAnalyticsReportDefinition,
  createAnalyticsReportSnapshot,
  DomainError,
  isClientReportEligibleEvidenceMode,
  publishProofEvidenceMode,
  resolveAnalyticsReportPeriod,
  verifyAnalyticsReportSnapshot,
  type Actor,
  type AnalyticsReportDataStatus,
  type AnalyticsReportDefinition,
  type AnalyticsReportProofInput,
  type AnalyticsReportShare,
  type AnalyticsReportSnapshot,
  type AuditEvent,
  type PostAnalyticsSnapshot,
} from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { CreateAnalyticsReportDto } from "./dto/analytics.dto.js";

function id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }
function tokenSha256(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
function isHuman(actor: Actor): boolean { return !actor.actorType || actor.actorType === "human"; }

function event(workspaceId: string, actor: Actor, action: string, detail: Record<string, unknown>, at: string): AuditEvent {
  return { id: id("evt"), workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human", action, detail, createdAt: at };
}

function safeFileName(value: string): string {
  return value.normalize("NFC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "originpost-report";
}

@Injectable()
export class AnalyticsReportService {
  private readonly webPublicUrl: string;

  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure, config: ConfigService) {
    this.webPublicUrl = (config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, "");
  }

  async list(workspaceId: string, actor: Actor, includeArchived = false) {
    this.assertRead(actor);
    const definitions = await this.infrastructure.analyticsReportRepository.listDefinitions(workspaceId, includeArchived);
    return Promise.all(definitions.map(async (definition) => {
      const latest = (await this.infrastructure.analyticsReportRepository.listSnapshots(workspaceId, definition.id, 1))[0];
      return { definition, latestSnapshot: latest ? this.snapshotSummary(latest) : null };
    }));
  }

  async create(workspaceId: string, dto: CreateAnalyticsReportDto, actor: Actor) {
    this.assertManage(actor);
    const availableBrands = await this.infrastructure.organizationRepository.listBrands(workspaceId, true);
    const active = new Map(availableBrands.filter((brand) => brand.status === "active").map((brand) => [brand.id, brand]));
    const brandIds = [...new Set(dto.brandIds)];
    if (brandIds.some((brandId) => !active.has(brandId))) throw new DomainError("Every selected brand must be active in this workspace.", "analytics_report_brand_invalid", 400);
    const accounts = (await Promise.all(brandIds.map((brandId) => this.infrastructure.connectedAccountRepository.list(workspaceId, brandId)))).flat();
    const allowedAccounts = new Map(accounts.filter((account) => dto.platforms.includes(account.platform as "instagram" | "facebook" | "youtube")).map((account) => [account.id, account]));
    if (dto.accountIds.some((accountId) => !allowedAccounts.has(accountId))) throw new DomainError("A selected account does not belong to the chosen brands and platforms.", "analytics_report_account_invalid", 400);
    const range = dto.rangeMode === "rolling"
      ? { mode: "rolling" as const, days: dto.rollingDays! }
      : { mode: "fixed" as const, from: dto.from!, to: dto.to! };
    const created = createAnalyticsReportDefinition({ workspaceId, name: dto.name, brandIds, range, platforms: dto.platforms, accountIds: dto.accountIds, metricKeys: dto.metricKeys, actor });
    await this.infrastructure.analyticsReportRepository.saveDefinition(created.definition, created.event);
    return { definition: created.definition, latestSnapshot: null };
  }

  async get(workspaceId: string, reportId: string, actor: Actor) {
    this.assertRead(actor);
    const definition = await this.definition(workspaceId, reportId);
    const snapshots = await this.infrastructure.analyticsReportRepository.listSnapshots(workspaceId, reportId, 25);
    const shares = await this.infrastructure.analyticsReportRepository.listShares(workspaceId, reportId);
    return {
      definition,
      snapshots: snapshots.map((snapshot) => this.snapshotSummary(snapshot)),
      shares: shares.map(({ tokenSha256: _tokenSha256, workspaceId: _workspaceId, ...share }) => share),
    };
  }

  async generate(workspaceId: string, reportId: string, actor: Actor) {
    this.assertManage(actor);
    const definition = await this.definition(workspaceId, reportId);
    const generatedAt = new Date().toISOString();
    const rows = await this.proofRows(definition, generatedAt);
    const generated = createAnalyticsReportSnapshot({ definition, proofRows: rows, actor, generatedAt });
    await this.infrastructure.analyticsReportRepository.saveSnapshot(generated.snapshot, generated.event);
    return generated.snapshot;
  }

  async snapshot(workspaceId: string, reportId: string, snapshotId: string, actor: Actor) {
    this.assertRead(actor);
    const snapshot = await this.infrastructure.analyticsReportRepository.getSnapshot(workspaceId, reportId, snapshotId);
    if (!snapshot) throw new NotFoundException("Analytics report snapshot not found.");
    this.assertSnapshot(snapshot);
    return snapshot;
  }

  async exportCsv(workspaceId: string, reportId: string, snapshotId: string, actor: Actor) {
    const snapshot = await this.snapshot(workspaceId, reportId, snapshotId, actor);
    return { fileName: `${safeFileName(snapshot.reportName)}-${snapshot.generatedAt.slice(0, 10)}.csv`, csv: analyticsReportCsv(snapshot) };
  }

  async share(workspaceId: string, reportId: string, snapshotId: string, expiresInDays: number, actor: Actor) {
    this.assertManage(actor);
    const snapshot = await this.infrastructure.analyticsReportRepository.getSnapshot(workspaceId, reportId, snapshotId);
    if (!snapshot) throw new NotFoundException("Analytics report snapshot not found.");
    this.assertSnapshot(snapshot);
    if (snapshot.proofRows.some((row) => !isClientReportEligibleEvidenceMode(row.evidenceMode))) throw new ConflictException("Client links require official, human-attested, or provider-reconciled publication evidence. Simulated and unverified legacy proofs cannot be shared.");
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    const share: AnalyticsReportShare = {
      id: id("analytics_share"), workspaceId, reportId, snapshotId, tokenSha256: tokenSha256(token),
      expiresAt: new Date(Date.parse(createdAt) + expiresInDays * 86_400_000).toISOString(), createdBy: actor.id, createdAt,
    };
    await this.infrastructure.analyticsReportRepository.saveShare(share, event(workspaceId, actor, "analytics.report-shared", { reportId, snapshotId, shareId: share.id, expiresAt: share.expiresAt }, createdAt));
    return { id: share.id, reportId, snapshotId, expiresAt: share.expiresAt, url: `${this.webPublicUrl}/reports/${encodeURIComponent(token)}` };
  }

  async revoke(workspaceId: string, reportId: string, shareId: string, actor: Actor) {
    this.assertManage(actor);
    const at = new Date().toISOString();
    const revoked = await this.infrastructure.analyticsReportRepository.revokeShare(workspaceId, reportId, shareId, actor.id, at, event(workspaceId, actor, "analytics.report-share-revoked", { reportId, shareId }, at));
    if (!revoked) throw new NotFoundException("Analytics report share link not found or already revoked.");
    return { revoked: true, shareId, revokedAt: revoked.revokedAt };
  }

  async archive(workspaceId: string, reportId: string, actor: Actor) {
    this.assertManage(actor);
    const definition = await this.definition(workspaceId, reportId);
    const archived = archiveAnalyticsReportDefinition(definition, actor);
    await this.infrastructure.analyticsReportRepository.saveDefinition(archived.definition, archived.event);
    return archived.definition;
  }

  async publicView(token: string) {
    const share = await this.activeShare(token);
    const snapshot = await this.infrastructure.analyticsReportRepository.getSnapshot(share.workspaceId, share.reportId, share.snapshotId);
    if (!snapshot) throw new NotFoundException("This report link is no longer available.");
    this.assertSnapshot(snapshot);
    return this.clientView(snapshot, share.expiresAt);
  }

  async publicCsv(token: string) {
    const share = await this.activeShare(token);
    const snapshot = await this.infrastructure.analyticsReportRepository.getSnapshot(share.workspaceId, share.reportId, share.snapshotId);
    if (!snapshot) throw new NotFoundException("This report link is no longer available.");
    this.assertSnapshot(snapshot);
    return { fileName: `${safeFileName(snapshot.reportName)}-${snapshot.generatedAt.slice(0, 10)}.csv`, csv: analyticsReportCsv(snapshot) };
  }

  private async proofRows(definition: AnalyticsReportDefinition, generatedAt: string): Promise<AnalyticsReportProofInput[]> {
    const period = resolveAnalyticsReportPeriod(definition.range, generatedAt);
    const brands = await this.infrastructure.organizationRepository.listBrands(definition.workspaceId, true);
    const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));
    const [itemsByBrand, accountsByBrand, snapshotsByBrand] = await Promise.all([
      Promise.all(definition.brandIds.map((brandId) => this.infrastructure.repository.list(definition.workspaceId, brandId))),
      Promise.all(definition.brandIds.map((brandId) => this.infrastructure.connectedAccountRepository.list(definition.workspaceId, brandId))),
      Promise.all(definition.brandIds.map((brandId) => this.infrastructure.analyticsRepository.list(definition.workspaceId, { brandId, limit: 2000 }))),
    ]);
    const accounts = new Map(accountsByBrand.flat().map((account) => [account.id, account]));
    const latestByProof = new Map<string, PostAnalyticsSnapshot>();
    for (const snapshot of snapshotsByBrand.flat().sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))) {
      if (!latestByProof.has(snapshot.proofId)) latestByProof.set(snapshot.proofId, snapshot);
    }
    const rows: AnalyticsReportProofInput[] = [];
    for (const item of itemsByBrand.flat()) {
      for (const proof of item.proofs) {
        if (proof.platform !== "instagram" && proof.platform !== "facebook" && proof.platform !== "youtube") continue;
        if (!definition.platforms.includes(proof.platform) || (definition.accountIds.length && !definition.accountIds.includes(proof.accountId))) continue;
        if (proof.publishedAt < period.from || proof.publishedAt > period.to) continue;
        const candidate = latestByProof.get(proof.id);
        const latest = candidate && candidate.workspaceId === item.workspaceId && candidate.brandId === item.brandId && candidate.contentItemId === item.id && candidate.platform === proof.platform && candidate.accountId === proof.accountId && candidate.externalPostId === proof.externalPostId ? candidate : undefined;
        const status: AnalyticsReportDataStatus = !latest ? "not_fetched" : latest.status === "ready" && Date.parse(generatedAt) - Date.parse(latest.capturedAt) > 86_400_000 ? "stale" : latest.status;
        rows.push({
          proofId: proof.id, contentItemId: item.id, brandId: item.brandId, brandName: brandNames.get(item.brandId) ?? "Archived brand",
          title: item.title, platform: proof.platform, accountId: proof.accountId, accountName: accounts.get(proof.accountId)?.displayName ?? "Disconnected account",
          externalPostId: proof.externalPostId, liveUrl: proof.liveUrl, publishedAt: proof.publishedAt, evidenceMode: publishProofEvidenceMode(proof), status,
          ...(latest ? { analyticsSnapshotId: latest.id, capturedAt: latest.capturedAt, metrics: latest.metrics, caveats: latest.caveats ?? [], ...(latest.rawPayloadSha256 ? { analyticsRawPayloadSha256: latest.rawPayloadSha256 } : {}), ...(latest.provider ? { provider: latest.provider } : {}), ...(latest.errorCode ? { errorCode: latest.errorCode } : {}), ...(latest.errorSummary ? { errorSummary: latest.errorSummary } : {}) } : { metrics: [], caveats: [] }),
        });
      }
    }
    return rows;
  }

  private clientView(snapshot: AnalyticsReportSnapshot, expiresAt: string) {
    return {
      report: { name: snapshot.reportName, generatedAt: snapshot.generatedAt, periodFrom: snapshot.periodFrom, periodTo: snapshot.periodTo, canonicalSha256: snapshot.canonicalSha256, expiresAt },
      groups: snapshot.groups.map(({ key: _key, brandId: _brandId, accountId: _accountId, ...group }) => group),
      posts: snapshot.proofRows.map((row) => ({
        title: row.title, brandName: row.brandName, platform: row.platform, accountName: row.accountName,
        liveUrl: row.liveUrl, publishedAt: row.publishedAt, evidenceMode: row.evidenceMode ?? "legacy_unknown", status: row.status, capturedAt: row.capturedAt,
        metrics: row.metrics, caveats: row.caveats,
      })),
      warnings: snapshot.warnings.map(({ groupKey: _groupKey, ...warning }) => warning),
    };
  }

  private async activeShare(token: string): Promise<AnalyticsReportShare> {
    const share = await this.infrastructure.analyticsReportRepository.getShareByTokenSha256(tokenSha256(token));
    if (!share || share.revokedAt || Date.parse(share.expiresAt) <= Date.now()) throw new NotFoundException("This report link is invalid, expired, or revoked.");
    return share;
  }

  private assertSnapshot(snapshot: AnalyticsReportSnapshot) {
    if (!verifyAnalyticsReportSnapshot(snapshot)) throw new DomainError("The saved report snapshot failed its integrity check.", "analytics_report_integrity_failed", 409);
  }

  private snapshotSummary(snapshot: AnalyticsReportSnapshot) {
    return { id: snapshot.id, reportId: snapshot.reportId, generatedAt: snapshot.generatedAt, periodFrom: snapshot.periodFrom, periodTo: snapshot.periodTo, proofCount: snapshot.proofRows.length, groupCount: snapshot.groups.length, warningCount: snapshot.warnings.length, canonicalSha256: snapshot.canonicalSha256 };
  }

  private async definition(workspaceId: string, reportId: string): Promise<AnalyticsReportDefinition> {
    const definition = await this.infrastructure.analyticsReportRepository.getDefinition(workspaceId, reportId);
    if (!definition) throw new NotFoundException("Analytics report not found.");
    return definition;
  }

  private assertRead(actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view analytics reports.");
  }

  private assertManage(actor: Actor) {
    if (!can(actor.role, "analytics:manage") || !isHuman(actor)) throw new ForbiddenException("A human workspace manager or owner must manage client reports.");
  }
}
