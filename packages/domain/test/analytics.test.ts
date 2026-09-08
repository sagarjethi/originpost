import { describe, expect, it } from "vitest";
import { analyticsTrends, metricValue, type PostAnalyticsSnapshot } from "../src/index.js";

const snapshot = (id: string, views: number): PostAnalyticsSnapshot => ({
  id, workspaceId: "workspace", brandId: "brand", contentItemId: "content", proofId: "proof", platform: "instagram", accountId: "account", externalPostId: "post",
  status: "ready", period: "lifetime", metrics: [{ key: "views", value: views, unit: "count" }], rawPayloadSha256: "a".repeat(64), capturedAt: `2026-08-29T0${id === "new" ? 2 : 1}:00:00.000Z`, createdAt: "2026-08-29T01:00:00.000Z",
});

describe("analytics", () => {
  it("computes trends only from two stored ready snapshots", () => {
    expect(analyticsTrends(snapshot("new", 150), snapshot("old", 100))).toEqual([{ key: "views", current: 150, previous: 100, absoluteChange: 50, percentChange: 50 }]);
    expect(analyticsTrends(snapshot("new", 150))).toEqual([]);
    expect(analyticsTrends({ ...snapshot("new", 150), status: "failed" }, snapshot("old", 100))).toEqual([]);
  });

  it("keeps an unavailable metric distinct from a measured zero", () => {
    expect(metricValue([], "views")).toBeUndefined();
    expect(metricValue([{ key: "views", value: 0, unit: "count" }], "views")).toBe(0);
  });

  it("does not compare snapshots whose provider definition changed", () => {
    const old = { ...snapshot("old", 100), metrics: [{ key: "views" as const, value: 100, unit: "count" as const, rawMetric: "views", definitionVersion: "youtube-views-2025" }] };
    const current = { ...snapshot("new", 150), metrics: [{ key: "views" as const, value: 150, unit: "count" as const, rawMetric: "views", definitionVersion: "youtube-views-2026" }] };
    expect(analyticsTrends(current, old)).toEqual([]);
  });

  it("does not compare snapshots whose aggregation contract changed", () => {
    const old = { ...snapshot("old", 100), metrics: [{ key: "reach" as const, value: 100, unit: "count" as const, aggregation: "sum" as const }] };
    const current = { ...snapshot("new", 150), metrics: [{ key: "reach" as const, value: 150, unit: "count" as const, aggregation: "non_additive" as const }] };
    expect(analyticsTrends(current, old)).toEqual([]);
  });
});
