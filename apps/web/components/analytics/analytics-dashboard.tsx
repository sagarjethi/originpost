"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Camera,
  CheckCircle2,
  Clock3,
  ExternalLink,
  MessageCircle,
  Minus,
  RefreshCw,
  Share2,
  ShieldAlert,
  Play,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import {
  analyticsStatusCopy,
  filterMatches,
  isMeasuredStatus,
  metricValue,
  type AnalyticsMetric,
  type AnalyticsMetricKey,
  type AnalyticsStatus,
  type AnalyticsTrend,
} from "./analytics-utils";
import { AnalyticsReportStudio } from "./analytics-report-studio";

type AnalyticsPost = {
  proofId: string;
  contentItemId: string;
  title: string;
  platform: "instagram" | "youtube";
  accountId: string;
  accountName: string;
  externalPostId: string;
  liveUrl: string;
  publishedAt: string;
  status: AnalyticsStatus;
  capturedAt?: string;
  metrics: AnalyticsMetric[];
  trends: AnalyticsTrend[];
  historyCount: number;
  provider?: string;
  errorCode?: string;
  errorSummary?: string;
  completeThrough?: string;
  caveats: string[];
};

type AnalyticsResponse = {
  brandId: string;
  generatedAt: string;
  summary: {
    publishedPosts: number;
    measuredPosts: number;
    needsAttention: number;
    metrics: Record<AnalyticsMetricKey, number | null>;
    metricsScope: "single-platform" | "not-comparable";
  };
  accountSummaries: Array<{ platform: "instagram" | "youtube"; accountId: string; accountName: string; publishedPosts: number; metrics: Record<AnalyticsMetricKey, number | null> }>;
  posts: AnalyticsPost[];
};

type AnalyticsDashboardProps = { auth: AuthView; workspaceId: string; brandId: string; brands: Array<{ id: string; name: string; status: "active" | "archived" }> };
type StatusFilter = "all" | AnalyticsStatus;

const numberFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fullNumberFormatter = new Intl.NumberFormat();

function formatNumber(value: number | undefined, compact = true) {
  if (value === undefined) return "—";
  return compact ? numberFormatter.format(value) : fullNumberFormatter.format(value);
}

function formatDate(value?: string) {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDuration(seconds: number | undefined) {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function metricLabel(key: AnalyticsMetricKey) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusIcon(status: AnalyticsStatus) {
  if (status === "ready") return <CheckCircle2 size={15} />;
  if (["stale", "not_fetched", "pending"].includes(status)) return <Clock3 size={15} />;
  if (status === "unsupported") return <Minus size={15} />;
  if (status === "permission_missing") return <ShieldAlert size={15} />;
  return <AlertTriangle size={15} />;
}

function Trend({ trend }: { trend: AnalyticsTrend | undefined }) {
  if (!trend) return null;
  const positive = trend.absoluteChange > 0;
  const negative = trend.absoluteChange < 0;
  const Icon = positive ? ArrowUpRight : negative ? ArrowDownRight : Minus;
  const amount = trend.percentChange === undefined
    ? `${trend.absoluteChange > 0 ? "+" : ""}${fullNumberFormatter.format(trend.absoluteChange)}`
    : `${trend.percentChange > 0 ? "+" : ""}${trend.percentChange.toFixed(1)}%`;
  return <span className={`analytics-trend ${positive ? "up" : negative ? "down" : "flat"}`} title={`Previous snapshot: ${fullNumberFormatter.format(trend.previous)}`}><Icon size={12} /> {amount}<span className="sr-only"> from the previous saved snapshot</span></span>;
}

function Metric({ label, value, trend, duration = false }: { label: string; value: number | undefined; trend?: AnalyticsTrend | undefined; duration?: boolean }) {
  return <div className="analytics-post-metric" title={value === undefined ? `${label} was not returned by the provider` : undefined}>
    <dt>{label}</dt>
    <dd>{duration ? formatDuration(value) : formatNumber(value)}<Trend trend={trend} /></dd>
  </div>;
}

function PostCard({ post, refreshing, canRefresh, onRefresh }: { post: AnalyticsPost; refreshing: boolean; canRefresh: boolean; onRefresh: (post: AnalyticsPost) => void }) {
  const copy = analyticsStatusCopy[post.status];
  const trends = new Map(post.trends.map((trend) => [trend.key, trend]));
  return <article className={`analytics-post panel status-${post.status}`}>
    <div className="analytics-post-head">
      <span className={`analytics-platform ${post.platform}`} aria-hidden="true">{post.platform === "instagram" ? <Camera size={20} /> : <Play size={20} />}</span>
      <div className="analytics-post-title">
        <span>{post.platform === "instagram" ? "Instagram" : "YouTube"} · {post.accountName}</span>
        <h2>{post.title}</h2>
      </div>
      <span className={`analytics-status ${post.status}`}>{statusIcon(post.status)} {copy.label}</span>
    </div>

    <div className="analytics-post-meta">
      <span><Clock3 size={13} /> Published {formatDate(post.publishedAt)}</span>
      <span><BarChart3 size={13} /> {post.capturedAt ? `Metrics updated ${formatDate(post.capturedAt)}` : "Metrics have not been fetched"}</span>
      {post.provider ? <span>Provider: {post.provider}</span> : null}
    </div>

    {isMeasuredStatus(post.status) ? <dl className="analytics-post-metrics">
      <Metric label="Views" value={metricValue(post.metrics, "views")} trend={trends.get("views")} />
      <Metric label="Engaged views" value={metricValue(post.metrics, "engaged_views")} trend={trends.get("engaged_views")} />
      <Metric label="Reach" value={metricValue(post.metrics, "reach")} trend={trends.get("reach")} />
      <Metric label="Likes" value={metricValue(post.metrics, "likes")} trend={trends.get("likes")} />
    </dl> : <div className={`analytics-status-note ${post.status}`}>
      {statusIcon(post.status)}
      <div><strong>{copy.label}</strong><p>{post.errorSummary ?? copy.detail}</p>{post.errorCode ? <small>Provider code: {post.errorCode}</small> : null}</div>
    </div>}

    {isMeasuredStatus(post.status) && post.metrics.length ? <details className="analytics-details">
      <summary>All reported metrics</summary>
      <dl>{post.metrics.map((metric) => <div key={metric.key}><dt>{metricLabel(metric.key)}</dt><dd>{metric.unit === "seconds" ? formatDuration(metric.value) : fullNumberFormatter.format(metric.value)}<Trend trend={trends.get(metric.key)} /></dd>{metric.source || metric.coverage ? <small>{[metric.source?.replaceAll("_", " "), metric.coverage?.replaceAll("_", " ")].filter(Boolean).join(" · ")}</small> : null}</div>)}</dl>
      <p>Trends appear only when OriginPost has an earlier saved provider snapshot for the same published proof.</p>
      {post.completeThrough ? <p>Complete through {post.completeThrough}.</p> : null}
      {post.caveats.map((caveat) => <p key={caveat}>{caveat}</p>)}
    </details> : null}

    <footer className="analytics-post-actions">
      <a href={post.liveUrl} target="_blank" rel="noreferrer">View live post <ExternalLink size={14} /><span className="sr-only"> (opens in a new tab)</span></a>
      <span>Proof {post.proofId.slice(0, 8)} · {post.historyCount} saved snapshot{post.historyCount === 1 ? "" : "s"}</span>
      <button type="button" onClick={() => onRefresh(post)} disabled={refreshing || !canRefresh} title={!canRefresh ? "Your workspace role can view analytics but cannot request a refresh." : undefined} aria-label={`Refresh provider analytics for ${post.title}`}><RefreshCw className={refreshing ? "analytics-spin" : ""} size={14} /> {refreshing ? "Queued…" : "Refresh metrics"}</button>
    </footer>
  </article>;
}

export function AnalyticsDashboard({ auth, workspaceId, brandId, brands }: AnalyticsDashboardProps) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [refreshingProof, setRefreshingProof] = useState("");
  const [view, setView] = useState<"ledger" | "reports">("ledger");

  const load = useCallback(async (quiet = false) => {
    if (!workspaceId || !brandId) return;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await apiFetch(`/v1/analytics?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        const detail = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        throw new Error(detail ?? "Could not load provider analytics.");
      }
      setData(await response.json() as AnalyticsResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load provider analytics.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [auth.csrfToken, brandId, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  async function refreshPost(post: AnalyticsPost) {
    setRefreshingProof(post.proofId);
    setError("");
    setMessage("");
    try {
      const response = await apiFetch(`/v1/analytics/content-items/${encodeURIComponent(post.contentItemId)}/proofs/${encodeURIComponent(post.proofId)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        const detail = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        throw new Error(detail ?? "Could not queue this analytics refresh.");
      }
      setMessage(`Refresh queued for “${post.title}”. Provider results will appear after the worker saves a new snapshot.`);
      window.setTimeout(() => void load(true), 1200);
      window.setTimeout(() => void load(true), 4000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not queue this analytics refresh.");
    } finally {
      setRefreshingProof("");
    }
  }

  const visiblePosts = useMemo(() => data?.posts.filter((post) => filterMatches(post.status, filter)) ?? [], [data?.posts, filter]);
  const canRefresh = auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role !== "viewer";

  return <section className="analytics-page">
    <header className="analytics-hero">
      <div>
        <p className="eyebrow">PROOF-TIED ANALYTICS</p>
        <h1>What happened after publish</h1>
        <p>Instagram and YouTube metrics are attached to the exact live-post proof. Facebook Page analytics are clearly marked unavailable.</p>
      </div>
      <div className="analytics-hero-actions"><div className="analytics-view-switch" role="tablist" aria-label="Analytics views"><button role="tab" aria-selected={view === "ledger"} className={view === "ledger" ? "active" : ""} onClick={() => setView("ledger")}>Proof ledger</button><button role="tab" aria-selected={view === "reports"} className={view === "reports" ? "active" : ""} onClick={() => setView("reports")}>Client reports</button></div>{view === "ledger" ? <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "analytics-spin" : ""} size={15} /> Refresh screen</button> : null}</div>
    </header>

    {error ? <div className="analytics-banner error" role="alert"><AlertTriangle size={17} /><span><strong>Analytics unavailable</strong><small>{error}</small></span></div> : null}
    {message ? <div className="analytics-banner success" role="status"><CheckCircle2 size={17} /><span><strong>Refresh requested</strong><small>{message}</small></span></div> : null}

    {view === "reports" ? <AnalyticsReportStudio auth={auth} workspaceId={workspaceId} activeBrandId={brandId} brands={brands} /> : loading && !data ? <div className="analytics-state panel" role="status"><RefreshCw className="analytics-spin" size={28} /><strong>Loading proof analytics…</strong><p>Reading saved provider snapshots for this brand.</p></div> : data ? <>
      <section className="analytics-summary" aria-label="Analytics summary">
        <article><span className="teal"><BarChart3 size={18} /></span><small>IG + YouTube proofs</small><strong>{data.summary.publishedPosts}</strong><p>Facebook Pages are not counted</p></article>
        <article><span className="sage"><Camera size={18} /></span><small>Instagram posts</small><strong>{data.posts.filter((post) => post.platform === "instagram").length}</strong><p>Kept separate from YouTube views</p></article>
        <article><span className="sand"><Play size={18} /></span><small>YouTube posts</small><strong>{data.posts.filter((post) => post.platform === "youtube").length}</strong><p>Owned channel analytics only</p></article>
        <article className="unsupported"><span className="facebook"><Share2 size={18} /></span><small>Facebook Page analytics</small><strong>—</strong><p>Not available in this release</p></article>
        <article><span className="charcoal"><BarChart3 size={18} /></span><small>Measured posts</small><strong>{data.summary.measuredPosts}<i> / {data.summary.publishedPosts}</i></strong><p>Current or saved stale snapshot</p></article>
        <article className={data.summary.needsAttention ? "attention" : ""}><span className="brick"><ShieldAlert size={18} /></span><small>Needs attention</small><strong>{data.summary.needsAttention}</strong><p>Stale, failed or missing access</p></article>
      </section>

      <section className="analytics-ledger">
        <div className="analytics-ledger-head">
          <div><h2>Published proof ledger</h2><p>{data.posts.length} live post{data.posts.length === 1 ? "" : "s"} · Screen checked {formatDate(data.generatedAt)}</p></div>
          <label>Snapshot status<select value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}><option value="all">All statuses</option><option value="ready">Current</option><option value="stale">Out of date</option><option value="pending">Still processing</option><option value="not_fetched">Not fetched</option><option value="unavailable">Not returned</option><option value="privacy_threshold">Audience too small</option><option value="expired">Insight window ended</option><option value="hidden">Hidden</option><option value="permission_missing">Permission missing</option><option value="unsupported">Not supported</option><option value="failed">Fetch failed</option></select></label>
        </div>

        {data.posts.length === 0 ? <div className="analytics-state panel"><BarChart3 size={28} /><strong>No measured Instagram or YouTube proofs yet</strong><p>Facebook Page publishing proof stays in OriginPost, but Page analytics are not available in this release and are not counted here.</p></div> : visiblePosts.length === 0 ? <div className="analytics-state panel"><MessageCircle size={27} /><strong>No posts with this status</strong><p>Choose another snapshot status to see the rest of the proof ledger.</p></div> : <div className="analytics-post-list">{visiblePosts.map((post) => <PostCard key={post.proofId} post={post} refreshing={refreshingProof === post.proofId} canRefresh={canRefresh} onRefresh={(value) => void refreshPost(value)} />)}</div>}
      </section>

      <footer className="analytics-honesty-note"><ShieldAlert size={16} /><p><strong>How to read this screen:</strong> Instagram and YouTube define views differently, so OriginPost does not merge them into one score. Facebook Page analytics are not fetched or counted in this release. A dash means unavailable—not zero. Trends compare compatible snapshots of the same proof only.</p></footer>
    </> : null}
  </section>;
}
