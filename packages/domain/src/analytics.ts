import type { AnalyticsMetric, AnalyticsMetricKey, PostAnalyticsSnapshot } from "./types.js";

export type AnalyticsTrend = {
  key: AnalyticsMetricKey;
  current: number;
  previous: number;
  absoluteChange: number;
  percentChange?: number | undefined;
};

export function analyticsTrends(current: PostAnalyticsSnapshot, previous?: PostAnalyticsSnapshot): AnalyticsTrend[] {
  if (current.status !== "ready" || previous?.status !== "ready") return [];
  const prior = new Map(previous.metrics.map((metric) => [metric.key, metric]));
  return current.metrics.flatMap((metric) => {
    const before = prior.get(metric.key);
    if (!before || before.unit !== metric.unit) return [];
    if (before.rawMetric !== metric.rawMetric || before.source !== metric.source || before.coverage !== metric.coverage || before.definitionVersion !== metric.definitionVersion) return [];
    const absoluteChange = metric.value - before.value;
    return [{
      key: metric.key,
      current: metric.value,
      previous: before.value,
      absoluteChange,
      ...(before.value !== 0 ? { percentChange: absoluteChange / before.value * 100 } : {}),
    }];
  });
}

export function metricValue(metrics: AnalyticsMetric[], key: AnalyticsMetricKey): number | undefined {
  return metrics.find((metric) => metric.key === key)?.value;
}
