import { createHash } from "node:crypto";
import { utf8Csv } from "./csv.js";
import { DomainError } from "./errors.js";
import type { Actor, AnalyticsMetric, AnalyticsMetricKey, AnalyticsMetricUnit, AnalyticsSnapshotStatus, AuditEvent, PublishEvidenceMode } from "./types.js";

export const analyticsReportMetricKeys = [
  "views",
  "engaged_views",
  "reach",
  "impressions",
  "clicks",
  "likes",
  "comments",
  "shares",
  "saves",
  "watch_time_seconds",
  "average_view_duration_seconds",
  "subscribers_gained",
] as const satisfies readonly AnalyticsMetricKey[];

export type AnalyticsReportPlatform = "instagram" | "facebook" | "youtube";
export type AnalyticsReportStatus = "active" | "archived";
export type AnalyticsReportRange =
  | { mode: "rolling"; days: number }
  | { mode: "fixed"; from: string; to: string };

export interface AnalyticsReportDefinition {
  id: string;
  workspaceId: string;
  version: number;
  name: string;
  brandIds: string[];
  range: AnalyticsReportRange;
  platforms: AnalyticsReportPlatform[];
  accountIds: string[];
  metricKeys: AnalyticsMetricKey[];
  status: AnalyticsReportStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type AnalyticsReportDataStatus = AnalyticsSnapshotStatus | "not_fetched" | "stale";

export interface AnalyticsReportProofInput {
  proofId: string;
  contentItemId: string;
  brandId: string;
  brandName: string;
  title: string;
  platform: AnalyticsReportPlatform;
  accountId: string;
  accountName: string;
  externalPostId: string;
  liveUrl: string;
  publishedAt: string;
  evidenceMode?: PublishEvidenceMode | undefined;
  status: AnalyticsReportDataStatus;
  analyticsSnapshotId?: string | undefined;
  analyticsRawPayloadSha256?: string | undefined;
  capturedAt?: string | undefined;
  provider?: string | undefined;
  metrics: AnalyticsMetric[];
  caveats: string[];
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
}

export interface AnalyticsReportProofRow extends AnalyticsReportProofInput {
  metrics: AnalyticsMetric[];
}

export interface AnalyticsReportGroupMetric {
  key: AnalyticsMetricKey;
  unit?: AnalyticsMetricUnit | undefined;
  value?: number | undefined;
  status: "ready" | "unavailable" | "not_comparable";
  measuredPosts: number;
  rawMetric?: string | undefined;
  source?: AnalyticsMetric["source"] | undefined;
  coverage?: AnalyticsMetric["coverage"] | undefined;
  definitionVersion?: string | undefined;
  aggregation?: AnalyticsMetric["aggregation"] | undefined;
}

export interface AnalyticsReportGroup {
  key: string;
  brandId: string;
  brandName: string;
  platform: AnalyticsReportPlatform;
  accountId: string;
  accountName: string;
  publishedPosts: number;
  measuredPosts: number;
  needsAttention: number;
  metrics: AnalyticsReportGroupMetric[];
}

export interface AnalyticsReportWarning {
  code: "metric_not_comparable" | "missing_provider_data" | "stale_provider_data" | "simulation_data" | "unverified_evidence";
  message: string;
  groupKey?: string | undefined;
  metricKey?: AnalyticsMetricKey | undefined;
  count?: number | undefined;
}

export interface AnalyticsReportSnapshot {
  id: string;
  workspaceId: string;
  reportId: string;
  reportVersion: number;
  reportName: string;
  periodFrom: string;
  periodTo: string;
  metricKeys: AnalyticsMetricKey[];
  proofRows: AnalyticsReportProofRow[];
  groups: AnalyticsReportGroup[];
  warnings: AnalyticsReportWarning[];
  sourceAnalyticsSnapshotIds: string[];
  generatedBy: string;
  generatedAt: string;
  canonicalSha256: string;
}

export interface AnalyticsReportShare {
  id: string;
  workspaceId: string;
  reportId: string;
  snapshotId: string;
  tokenSha256: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
}

export interface AnalyticsReportRepository {
  listDefinitions(workspaceId: string, includeArchived?: boolean): Promise<AnalyticsReportDefinition[]>;
  getDefinition(workspaceId: string, reportId: string): Promise<AnalyticsReportDefinition | null>;
  saveDefinition(definition: AnalyticsReportDefinition, event: AuditEvent): Promise<void>;
  listSnapshots(workspaceId: string, reportId: string, limit?: number): Promise<AnalyticsReportSnapshot[]>;
  getSnapshot(workspaceId: string, reportId: string, snapshotId: string): Promise<AnalyticsReportSnapshot | null>;
  saveSnapshot(snapshot: AnalyticsReportSnapshot, event: AuditEvent): Promise<void>;
  saveShare(share: AnalyticsReportShare, event: AuditEvent): Promise<void>;
  listShares(workspaceId: string, reportId: string, snapshotId?: string): Promise<AnalyticsReportShare[]>;
  getShareByTokenSha256(tokenSha256: string): Promise<AnalyticsReportShare | null>;
  revokeShare(workspaceId: string, reportId: string, shareId: string, actorId: string, revokedAt: string, event: AuditEvent): Promise<AnalyticsReportShare | null>;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new DomainError("Report data contains a non-finite number.", "analytics_report_invalid");
  return value;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFC").trim()).filter(Boolean))].sort(compareText);
}

function iso(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new DomainError(`${field} must be a valid date and time.`, "analytics_report_invalid");
  return new Date(time).toISOString();
}

export function createAnalyticsReportDefinition(input: {
  workspaceId: string;
  name: string;
  brandIds: string[];
  range: AnalyticsReportRange;
  platforms: AnalyticsReportPlatform[];
  accountIds?: string[] | undefined;
  metricKeys: AnalyticsMetricKey[];
  actor: Actor;
  now?: string | undefined;
}): { definition: AnalyticsReportDefinition; event: AuditEvent } {
  const now = iso(input.now ?? new Date().toISOString(), "Report creation time");
  const name = input.name.normalize("NFC").trim();
  if (!name || name.length > 120) throw new DomainError("Report name must be between 1 and 120 characters.", "analytics_report_invalid");
  const brandIds = uniqueSorted(input.brandIds);
  if (!brandIds.length || brandIds.length > 50) throw new DomainError("Choose between 1 and 50 brands.", "analytics_report_invalid");
  const platforms = uniqueSorted(input.platforms) as AnalyticsReportPlatform[];
  if (!platforms.length || platforms.some((platform) => platform !== "instagram" && platform !== "facebook" && platform !== "youtube")) throw new DomainError("Choose Instagram, Facebook, YouTube, or a combination.", "analytics_report_invalid");
  const metricKeys = uniqueSorted(input.metricKeys) as AnalyticsMetricKey[];
  if (!metricKeys.length || metricKeys.some((key) => !analyticsReportMetricKeys.includes(key))) throw new DomainError("Choose at least one supported metric.", "analytics_report_invalid");
  if (input.range.mode === "rolling") {
    if (!Number.isInteger(input.range.days) || input.range.days < 1 || input.range.days > 366) throw new DomainError("Rolling reports must cover between 1 and 366 days.", "analytics_report_invalid");
  } else {
    const from = iso(input.range.from, "Report start");
    const to = iso(input.range.to, "Report end");
    if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new DomainError("Fixed reports must use a valid range of at most 366 days.", "analytics_report_invalid");
    input.range = { mode: "fixed", from, to };
  }
  const definition: AnalyticsReportDefinition = {
    id: id("analytics_report"),
    workspaceId: input.workspaceId,
    version: 1,
    name,
    brandIds,
    range: input.range,
    platforms,
    accountIds: uniqueSorted(input.accountIds ?? []),
    metricKeys,
    status: "active",
    createdBy: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  return {
    definition,
    event: {
      id: id("evt"), workspaceId: input.workspaceId, actorId: input.actor.id,
      actorType: input.actor.actorType ?? "human", action: "analytics.report-created",
      detail: { reportId: definition.id, reportVersion: definition.version, brandIds, platforms, metricKeys }, createdAt: now,
    },
  };
}

export function resolveAnalyticsReportPeriod(range: AnalyticsReportRange, generatedAt: string): { from: string; to: string } {
  const to = iso(generatedAt, "Report generation time");
  if (range.mode === "fixed") return { from: iso(range.from, "Report start"), to: iso(range.to, "Report end") };
  if (!Number.isInteger(range.days) || range.days < 1 || range.days > 366) throw new DomainError("Rolling reports must cover between 1 and 366 days.", "analytics_report_invalid");
  return { from: new Date(Date.parse(to) - range.days * 86_400_000).toISOString(), to };
}

export function archiveAnalyticsReportDefinition(definition: AnalyticsReportDefinition, actor: Actor, nowValue = new Date().toISOString()): { definition: AnalyticsReportDefinition; event: AuditEvent } {
  if (definition.status === "archived") throw new DomainError("This report is already archived.", "analytics_report_archived", 409);
  const now = iso(nowValue, "Report archive time");
  const next = { ...definition, version: definition.version + 1, status: "archived" as const, updatedAt: now };
  return {
    definition: next,
    event: {
      id: id("evt"), workspaceId: definition.workspaceId, actorId: actor.id, actorType: actor.actorType ?? "human",
      action: "analytics.report-archived", detail: { reportId: definition.id, reportVersion: next.version }, createdAt: now,
    },
  };
}

export function analyticsMetricContractSha256(metric: AnalyticsMetric): string {
  return canonicalSha256({
    key: metric.key,
    unit: metric.unit,
    rawMetric: metric.rawMetric ?? null,
    source: metric.source ?? null,
    coverage: metric.coverage ?? null,
    definitionVersion: metric.definitionVersion ?? null,
    aggregation: metric.aggregation ?? "sum",
  });
}

export function createAnalyticsReportSnapshot(input: {
  definition: AnalyticsReportDefinition;
  proofRows: AnalyticsReportProofInput[];
  actor: Actor;
  generatedAt?: string | undefined;
}): { snapshot: AnalyticsReportSnapshot; event: AuditEvent } {
  if (input.definition.status !== "active") throw new DomainError("Archived reports cannot be generated.", "analytics_report_archived", 409);
  const generatedAt = iso(input.generatedAt ?? new Date().toISOString(), "Report generation time");
  const period = resolveAnalyticsReportPeriod(input.definition.range, generatedAt);
  const rows = input.proofRows
    .filter((row) => row.publishedAt >= period.from && row.publishedAt <= period.to)
    .filter((row) => input.definition.brandIds.includes(row.brandId))
    .filter((row) => input.definition.platforms.includes(row.platform))
    .filter((row) => !input.definition.accountIds.length || input.definition.accountIds.includes(row.accountId))
    .map((row) => ({
      ...row,
      metrics: row.metrics.filter((metric) => input.definition.metricKeys.includes(metric.key))
        .sort((left, right) => compareText(left.key, right.key)),
      caveats: uniqueSorted(row.caveats),
    }))
    .sort((left, right) => compareText(right.publishedAt, left.publishedAt) || compareText(left.proofId, right.proofId));

  const groupedRows = new Map<string, AnalyticsReportProofRow[]>();
  for (const row of rows) {
    const key = `${row.brandId}:${row.platform}:${row.accountId}`;
    groupedRows.set(key, [...(groupedRows.get(key) ?? []), row]);
  }
  const warnings: AnalyticsReportWarning[] = [];
  const groups: AnalyticsReportGroup[] = [...groupedRows.entries()].map(([key, entries]) => {
    const metrics = input.definition.metricKeys.map((metricKey): AnalyticsReportGroupMetric => {
      const values = entries.flatMap((row) => ["ready", "stale"].includes(row.status)
        ? row.metrics.filter((metric) => metric.key === metricKey)
        : []);
      if (!values.length) return { key: metricKey, status: "unavailable", measuredPosts: 0 };
      const contracts = new Set(values.map(analyticsMetricContractSha256));
      if (contracts.size !== 1) {
        warnings.push({
          code: "metric_not_comparable", groupKey: key, metricKey,
          message: `${metricKey.replaceAll("_", " ")} was kept separate because the provider definition changed.`,
        });
        return { key: metricKey, status: "not_comparable", measuredPosts: values.length };
      }
      const first = values[0]!;
      if (first.aggregation === "non_additive") {
        warnings.push({
          code: "metric_not_comparable", groupKey: key, metricKey,
          message: `${metricKey.replaceAll("_", " ")} is unique per post and was not summed across posts.`,
        });
        return {
          key: metricKey,
          unit: first.unit,
          status: "not_comparable",
          measuredPosts: values.length,
          ...(first.rawMetric ? { rawMetric: first.rawMetric } : {}),
          ...(first.source ? { source: first.source } : {}),
          ...(first.coverage ? { coverage: first.coverage } : {}),
          ...(first.definitionVersion ? { definitionVersion: first.definitionVersion } : {}),
          aggregation: "non_additive",
        };
      }
      return {
        key: metricKey,
        unit: first.unit,
        value: values.reduce((sum, metric) => sum + metric.value, 0),
        status: "ready",
        measuredPosts: values.length,
        ...(first.rawMetric ? { rawMetric: first.rawMetric } : {}),
        ...(first.source ? { source: first.source } : {}),
        ...(first.coverage ? { coverage: first.coverage } : {}),
        ...(first.definitionVersion ? { definitionVersion: first.definitionVersion } : {}),
        ...(first.aggregation ? { aggregation: first.aggregation } : {}),
      };
    });
    return {
      key,
      brandId: entries[0]!.brandId,
      brandName: entries[0]!.brandName,
      platform: entries[0]!.platform,
      accountId: entries[0]!.accountId,
      accountName: entries[0]!.accountName,
      publishedPosts: entries.length,
      measuredPosts: entries.filter((row) => row.status === "ready" || row.status === "stale").length,
      needsAttention: entries.filter((row) => ["stale", "permission_missing", "failed"].includes(row.status)).length,
      metrics,
    };
  }).sort((left, right) => compareText(left.brandName, right.brandName) || compareText(left.platform, right.platform) || compareText(left.accountName, right.accountName));
  const missingCount = rows.filter((row) => !["ready", "stale"].includes(row.status)).length;
  const staleCount = rows.filter((row) => row.status === "stale").length;
  const simulationCount = rows.filter((row) => row.evidenceMode === "simulation").length;
  const legacyUnknownCount = rows.filter((row) => row.evidenceMode === "legacy_unknown").length;
  if (missingCount) warnings.push({ code: "missing_provider_data", count: missingCount, message: `${missingCount} published post${missingCount === 1 ? " has" : "s have"} no usable provider metrics.` });
  if (staleCount) warnings.push({ code: "stale_provider_data", count: staleCount, message: `${staleCount} published post${staleCount === 1 ? " has" : "s have"} an out-of-date provider snapshot.` });
  if (simulationCount) warnings.push({ code: "simulation_data", count: simulationCount, message: `${simulationCount} proof record${simulationCount === 1 ? " is" : "s are"} simulated and cannot be shared as live client reporting.` });
  if (legacyUnknownCount) warnings.push({ code: "unverified_evidence", count: legacyUnknownCount, message: `${legacyUnknownCount} legacy proof record${legacyUnknownCount === 1 ? " has" : "s have"} unknown provenance and cannot be shared as live client reporting.` });

  const unhashed = {
    id: id("analytics_snapshot"),
    workspaceId: input.definition.workspaceId,
    reportId: input.definition.id,
    reportVersion: input.definition.version,
    reportName: input.definition.name,
    periodFrom: period.from,
    periodTo: period.to,
    metricKeys: [...input.definition.metricKeys],
    proofRows: rows,
    groups,
    warnings,
    sourceAnalyticsSnapshotIds: uniqueSorted(rows.flatMap((row) => row.analyticsSnapshotId ? [row.analyticsSnapshotId] : [])),
    generatedBy: input.actor.id,
    generatedAt,
  };
  const snapshot: AnalyticsReportSnapshot = { ...unhashed, canonicalSha256: canonicalSha256(unhashed) };
  return {
    snapshot,
    event: {
      id: id("evt"), workspaceId: snapshot.workspaceId, actorId: input.actor.id,
      actorType: input.actor.actorType ?? "human", action: "analytics.report-generated",
      detail: { reportId: snapshot.reportId, snapshotId: snapshot.id, reportVersion: snapshot.reportVersion, canonicalSha256: snapshot.canonicalSha256, proofCount: rows.length, groupCount: groups.length },
      createdAt: generatedAt,
    },
  };
}

export function verifyAnalyticsReportSnapshot(snapshot: AnalyticsReportSnapshot): boolean {
  const { canonicalSha256: stored, ...unhashed } = snapshot;
  return /^[a-f0-9]{64}$/.test(stored) && canonicalSha256(unhashed) === stored;
}

export function analyticsReportCsv(snapshot: AnalyticsReportSnapshot): string {
  if (!verifyAnalyticsReportSnapshot(snapshot)) throw new DomainError("The saved report snapshot failed its integrity check.", "analytics_report_integrity_failed", 409);
  const headers = ["brand", "platform", "account", "title", "published_at", "status", "evidence_mode", "live_url", ...snapshot.metricKeys];
  const rows = snapshot.proofRows.map((row) => {
    const metrics = new Map(row.metrics.map((metric) => [metric.key, metric.value]));
    return [row.brandName, row.platform, row.accountName, row.title, row.publishedAt, row.status, row.evidenceMode ?? "legacy_unknown", row.liveUrl, ...snapshot.metricKeys.map((key) => metrics.get(key))];
  });
  return utf8Csv(headers, rows);
}
