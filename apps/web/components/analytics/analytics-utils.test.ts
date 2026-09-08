import { describe, expect, it } from "vitest";
import { filterMatches, interactionTotal, isActionStatus, metricValue } from "./analytics-utils";

describe("analytics display helpers", () => {
  const metrics = [
    { key: "likes" as const, value: 18, unit: "count" as const },
    { key: "comments" as const, value: 4, unit: "count" as const },
  ];

  it("uses only metrics returned by the API", () => {
    expect(metricValue(metrics, "likes")).toBe(18);
    expect(metricValue(metrics, "views")).toBeUndefined();
    expect(interactionTotal(metrics)).toBe(22);
    expect(interactionTotal([])).toBeUndefined();
  });

  it("keeps provider and freshness states distinct", () => {
    expect(isActionStatus("stale")).toBe(true);
    expect(isActionStatus("permission_missing")).toBe(true);
    expect(isActionStatus("unsupported")).toBe(false);
    expect(filterMatches("not_fetched", "not_fetched")).toBe(true);
    expect(filterMatches("not_fetched", "failed")).toBe(false);
  });
});
