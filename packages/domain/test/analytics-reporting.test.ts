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

  it("exports the exact saved rows as UTF-8 CSV and keeps unavailable values blank", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "CSV", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 }, platforms: ["instagram"], metricKeys: ["views", "likes"], actor, now: "2026-09-01T00:00:00Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row({ title: "One, verified post" })], actor, generatedAt: "2026-09-01T00:00:00Z" });
    const csv = analyticsReportCsv(snapshot);
    expect(csv.startsWith('\uFEFF"brand","platform"')).toBe(true);
    expect(csv).toContain('"One, verified post"');
    expect(csv).toContain(',\"\",\"100\"\r\n');
  });

  it("neutralizes spreadsheet formulas in report text", () => {
    const { definition } = createAnalyticsReportDefinition({
      workspaceId: "workspace-1", name: "CSV", brandIds: ["brand-1"], range: { mode: "rolling", days: 30 }, platforms: ["instagram"], metricKeys: ["views"], actor, now: "2026-09-01T00:00:00Z",
    });
    const { snapshot } = createAnalyticsReportSnapshot({ definition, proofRows: [row({ title: "  =HYPERLINK(\"https://invalid.example\")" })], actor, generatedAt: "2026-09-01T00:00:00Z" });
    expect(analyticsReportCsv(snapshot)).toContain('"\'  =HYPERLINK(""https://invalid.example"")"');
  });
});
