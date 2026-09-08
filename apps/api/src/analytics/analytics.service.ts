import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { analyticsTrends, can, DomainError, metricValue, type Actor, type AnalyticsMetricKey, type PostAnalyticsSnapshot, type PublishProof } from "@originpost/domain";
import { resolveActiveBrand } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";

const summaryKeys: AnalyticsMetricKey[] = ["views", "reach", "likes", "comments", "shares", "saves", "watch_time_seconds"];

@Injectable()
export class AnalyticsService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}

  async list(workspaceId: string, requestedBrandId: string | undefined, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view analytics.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    const items = await this.infrastructure.repository.list(workspaceId, brandId);
    const snapshots = await this.infrastructure.analyticsRepository.list(workspaceId, { brandId, limit: 2000 });
    const snapshotsByProof = new Map<string, PostAnalyticsSnapshot[]>();
    for (const snapshot of snapshots) {
      const existing = snapshotsByProof.get(snapshot.proofId) ?? [];
      existing.push(snapshot); snapshotsByProof.set(snapshot.proofId, existing);
    }
    const accounts = new Map((await this.infrastructure.connectedAccountRepository.list(workspaceId, brandId)).map((account) => [account.id, account]));
    const rows = items.flatMap((item) => item.proofs.flatMap((proof) => proof.platform === "instagram" || proof.platform === "youtube" ? [{ item, proof }] : [])).map(({ item, proof }) => {
      const history = snapshotsByProof.get(proof.id) ?? [];
      const latest = history[0];
      const previous = history.slice(1).find((entry) => entry.status === "ready");
      const status = !latest ? "not_fetched" : latest.status === "ready" && Date.now() - new Date(latest.capturedAt).getTime() > 86_400_000 ? "stale" : latest.status;
      return {
        proofId: proof.id,
        contentItemId: item.id,
        title: item.title,
        platform: proof.platform,
        accountId: proof.accountId,
        accountName: accounts.get(proof.accountId)?.displayName ?? "Disconnected account",
        externalPostId: proof.externalPostId,
        liveUrl: proof.liveUrl,
        publishedAt: proof.publishedAt,
        status,
        capturedAt: latest?.capturedAt,
        metrics: latest?.metrics ?? [],
        trends: latest ? analyticsTrends(latest, previous) : [],
        historyCount: history.length,
        provider: latest?.provider,
        errorCode: latest?.errorCode,
        errorSummary: latest?.errorSummary,
        completeThrough: latest?.completeThrough,
        caveats: latest?.caveats ?? [],
      };
    }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

    const summarize = (entries: typeof rows) => Object.fromEntries(summaryKeys.map((key) => {
      const values = entries.flatMap((row) => {
        const value = metricValue(row.metrics, key);
        return value === undefined ? [] : [value];
      });
      return [key, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
    }));
    const groupMap = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.platform}:${row.accountId}`;
      groupMap.set(key, [...(groupMap.get(key) ?? []), row]);
    }
    const accountSummaries = [...groupMap.values()].map((entries) => ({
      platform: entries[0]!.platform,
      accountId: entries[0]!.accountId,
      accountName: entries[0]!.accountName,
      publishedPosts: entries.length,
      metrics: summarize(entries),
    }));
    const comparableAcrossBrand = new Set(rows.map((row) => row.platform)).size <= 1 && !(
      rows.some((row) => row.platform === "youtube") && new Set(rows.filter((row) => row.platform === "youtube").map((row) => row.accountId)).size > 1
    );
    return {
      brandId,
      generatedAt: new Date().toISOString(),
      summary: {
        publishedPosts: rows.length,
        measuredPosts: rows.filter((row) => row.status === "ready" || row.status === "stale").length,
        needsAttention: rows.filter((row) => ["permission_missing", "failed", "stale"].includes(row.status)).length,
        metrics: comparableAcrossBrand ? summarize(rows) : Object.fromEntries(summaryKeys.map((key) => [key, null])),
        metricsScope: comparableAcrossBrand ? "single-platform" : "not-comparable",
      },
      accountSummaries,
      posts: rows,
    };
  }

  async refresh(workspaceId: string, contentItemId: string, proofId: string, actor: Actor) {
    if (!can(actor.role, "content:edit")) throw new ForbiddenException("You cannot refresh analytics.");
    if (!this.infrastructure.analyticsQueue) throw new ServiceUnavailableException("Redis is required to refresh analytics.");
    const item = await this.infrastructure.repository.get(workspaceId, contentItemId);
    if (!item) throw new DomainError("Content item not found.", "not_found", 404);
    const proof = item.proofs.find((entry) => entry.id === proofId && (entry.platform === "instagram" || entry.platform === "youtube")) as PublishProof | undefined;
    if (!proof) throw new DomainError("Published proof not found.", "proof_not_found", 404);
    await this.infrastructure.analyticsQueue.add("capture-proof", { workspaceId, contentItemId, proofId }, {
      jobId: `analytics-${proofId}-${crypto.randomUUID()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
    return { queued: true, proofId };
  }
}
