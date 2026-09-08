export type AnalyticsStatus = "ready" | "not_fetched" | "stale" | "pending" | "unavailable" | "privacy_threshold" | "expired" | "hidden" | "permission_missing" | "unsupported" | "failed";

export type AnalyticsMetricKey = "views" | "engaged_views" | "reach" | "impressions" | "likes" | "comments" | "shares" | "saves" | "watch_time_seconds" | "average_view_duration_seconds" | "subscribers_gained";

export type AnalyticsMetric = { key: AnalyticsMetricKey; value: number; unit: "count" | "seconds"; rawMetric?: string; source?: string; coverage?: string; definitionVersion?: string; caveats?: string[] };

export type AnalyticsTrend = {
  key: AnalyticsMetricKey;
  current: number;
  previous: number;
  absoluteChange: number;
  percentChange?: number;
};

export const analyticsStatusCopy: Record<AnalyticsStatus, { label: string; detail: string }> = {
  ready: { label: "Current", detail: "The latest provider snapshot is available." },
  stale: { label: "Out of date", detail: "This snapshot is more than 24 hours old. Refresh it before making a decision." },
  pending: { label: "Still processing", detail: "The provider has not finished preparing this post's metrics." },
  unavailable: { label: "Not returned", detail: "The provider returned no value. This is not the same as zero." },
  privacy_threshold: { label: "Audience too small", detail: "The provider hid this result because of its privacy threshold." },
  expired: { label: "Insight window ended", detail: "This post type's provider insight window has ended." },
  hidden: { label: "Hidden by account", detail: "The account or provider has hidden this metric." },
  not_fetched: { label: "Not fetched", detail: "No provider snapshot has been saved for this published post yet." },
  permission_missing: { label: "Permission missing", detail: "Reconnect this account or grant analytics access, then try again." },
  unsupported: { label: "Not supported", detail: "This provider or post type does not expose analytics through the current connection." },
  failed: { label: "Fetch failed", detail: "The provider could not return a valid snapshot. Try again or check the account." },
};

export function metricValue(metrics: AnalyticsMetric[], key: AnalyticsMetricKey): number | undefined {
  return metrics.find((metric) => metric.key === key)?.value;
}

export function interactionTotal(metrics: AnalyticsMetric[]): number | undefined {
  const values = (["likes", "comments", "shares", "saves"] as const)
    .map((key) => metricValue(metrics, key))
    .filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function isMeasuredStatus(status: AnalyticsStatus): boolean {
  return status === "ready" || status === "stale";
}

export function isActionStatus(status: AnalyticsStatus): boolean {
  return status === "stale" || status === "permission_missing" || status === "failed";
}

export function filterMatches(status: AnalyticsStatus, filter: "all" | AnalyticsStatus): boolean {
  return filter === "all" || filter === status;
}
