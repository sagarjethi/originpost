import { describe, expect, it } from "vitest";
import { analyticsReportCsv, createAnalyticsReportDefinition, createAnalyticsReportSnapshot, verifyAnalyticsReportSnapshot, type Actor, type AnalyticsReportProofInput } from "../src/index.js";

const actor: Actor = { id: "manager-1", name: "Manager", role: "manager", actorType: "human" };

function row(input: Partial<AnalyticsReportProofInput> = {}): AnalyticsReportProofInput {
  return {
    proofId: "proof-1", contentItemId: "content-1", brandId: "brand-1", brandName: "Newsroom",
    title: "Verified post", platform: "instagram", accountId: "account-1", accountName: "Main Instagram",
    externalPostId: "provider-1", liveUrl: "https://instagram.com/p/provider-1", publishedAt: "2026-08-20T10:00:00.000Z",
    status: "ready", analyticsSnapshotId: "snapshot-1", analyticsRawPayloadSha256: "a".repeat(64), capturedAt: "2026-08-21T10:00:00.000Z",
    provider: "instagram-official", metrics: [{ key: "views", value: 100, unit: "count", rawMetric: "views", source: "instagram_media_insights", coverage: "instagram_only", definitionVersion: "2026-01" }], caveats: [],
    ...input,
  };
}

describe("analytics client reports", () => {
  it("creates a reusable definition and immutable proof-backed snapshot", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "August client report", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 },
      platforms: ["instagram", "youtube"], metricKeys: ["views", "likes"], actor, now: "2026-09-01T00:00:00.000Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row()], actor, generatedAt: "2026-09-01T00:00:00.000Z" });
    expect(snapshot.proofRows).toHaveLength(1);
    expect(snapshot.groups[0]?.metrics.find((metric) => metric.key === "views")?.value).toBe(100);
    expect(snapshot.groups[0]?.metrics.find((metric) => metric.key === "likes")?.status).toBe("unavailable");
    expect(snapshot.sourceAnalyticsSnapshotIds).toEqual(["snapshot-1"]);
    expect(verifyAnalyticsReportSnapshot(snapshot)).toBe(true);
    expect(verifyAnalyticsReportSnapshot({ ...snapshot, reportName: "Changed later" })).toBe(false);
  });

  it("never combines metrics whose provider definitions differ", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "Definition guard", brandIds: ["brand-1"], range: { mode: "fixed", from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:59Z" },
      platforms: ["instagram"], metricKeys: ["views"], actor, now: "2026-09-01T00:00:00Z",
    });
    const second = row({ proofId: "proof-2", contentItemId: "content-2", externalPostId: "provider-2", analyticsSnapshotId: "snapshot-2", metrics: [{ key: "views", value: 200, unit: "count", rawMetric: "views", source: "instagram_media_insights", coverage: "paid_and_organic", definitionVersion: "2026-01" }] });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row(), second], actor, generatedAt: "2026-09-01T00:00:00Z" });
    expect(snapshot.groups[0]?.metrics[0]).toMatchObject({ key: "views", status: "not_comparable" });
    expect(snapshot.groups[0]?.metrics[0]?.value).toBeUndefined();
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({ code: "metric_not_comparable", metricKey: "views" }));
  });

  it("admits Facebook proof rows but never sums unique viewers across posts", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "Facebook proof report", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 },
      platforms: ["facebook"], metricKeys: ["views", "reach", "clicks"], actor, now: "2026-09-01T00:00:00.000Z",
    });
    const facebookMetric = (value: number) => ({ key: "reach" as const, value, unit: "count" as const, rawMetric: "post_total_media_view_unique", source: "facebook_page_post_insights" as const, coverage: "paid_and_organic" as const, definitionVersion: "v26.0:post_total_media_view_unique", aggregation: "non_additive" as const });
    const first = row({ platform: "facebook", accountName: "Main Page", metrics: [facebookMetric(80)] });
    const second = row({ proofId: "proof-2", contentItemId: "content-2", externalPostId: "page-1_2", analyticsSnapshotId: "snapshot-2", platform: "facebook", accountName: "Main Page", metrics: [facebookMetric(70)] });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [first, second], actor, generatedAt: "2026-09-01T00:00:00.000Z" });
    const reach = snapshot.groups[0]?.metrics.find((metric) => metric.key === "reach");
    expect(reach).toMatchObject({ status: "not_comparable", measuredPosts: 2, aggregation: "non_additive" });
    expect(reach?.value).toBeUndefined();
    expect(snapshot.proofRows.map((entry) => entry.metrics[0]?.value)).toEqual([80, 70]);
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({ code: "metric_not_comparable", metricKey: "reach" }));
  });

  it("exports the exact saved rows as UTF-8 CSV and keeps unavailable values blank", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "CSV", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 }, platforms: ["instagram"], metricKeys: ["views", "likes"], actor, now: "2026-09-01T00:00:00Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row({ title: "One, verified post" })], actor, generatedAt: "2026-09-01T00:00:00Z" });
    const csv = analyticsReportCsv(snapshot);
    expect(csv.startsWith('\uFEFF"brand","platform"')).toBe(true);
    expect(csv).toContain('"One, verified post"');
    expect(csv).toContain('"evidence_mode"');
    expect(csv).toContain('"legacy_unknown"');
    expect(csv).toContain(',\"\",\"100\"\r\n');
  });

  it("labels simulated proof records and warns that they cannot be shared as live reporting", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "Simulation", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 }, platforms: ["instagram"], metricKeys: ["views"], actor, now: "2026-09-01T00:00:00Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row({ evidenceMode: "simulation" })], actor, generatedAt: "2026-09-01T00:00:00Z" });
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({ code: "simulation_data", count: 1 }));
    expect(analyticsReportCsv(snapshot)).toContain('"simulation"');
  });

  it("warns when a legacy proof has unknown provenance", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "Legacy", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 }, platforms: ["instagram"], metricKeys: ["views"], actor, now: "2026-09-01T00:00:00Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row({ evidenceMode: "legacy_unknown" })], actor, generatedAt: "2026-09-01T00:00:00Z" });
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({ code: "unverified_evidence", count: 1 }));
  });

  it("neutralizes spreadsheet formulas in report text", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "CSV", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 }, platforms: ["instagram"], metricKeys: ["views"], actor, now: "2026-09-01T00:00:00Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row({ title: "  =HYPERLINK(\"https://invalid.example\")" })], actor, generatedAt: "2026-09-01T00:00:00Z" });
    expect(analyticsReportCsv(snapshot)).toContain('"\'  =HYPERLINK(""https://invalid.example"")"');
  });
});
