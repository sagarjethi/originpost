"use client";

import { AlertTriangle, Download, ExternalLink, ShieldCheck } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiBasePath } from "@/lib/api-client";
import styles from "./report.module.css";

type Metric = { key: string; value?: number; unit?: "count" | "seconds"; status: "ready" | "unavailable" | "not_comparable" };
type ClientReport = {
  report: { name: string; generatedAt: string; periodFrom: string; periodTo: string; canonicalSha256: string; expiresAt: string };
  groups: Array<{ brandName: string; platform: string; accountName: string; publishedPosts: number; measuredPosts: number; needsAttention: number; metrics: Metric[] }>;
  posts: Array<{ brandName: string; title: string; platform: string; accountName: string; liveUrl: string; publishedAt: string; status: string; evidenceMode: "official" | "manual_attestation" | "provider_reconciliation" | "simulation" | "legacy_unknown"; metrics: Array<{ key: string; value: number; unit: string; aggregation?: "sum" | "non_additive" }> }>;
  warnings: Array<{ code: string; message: string; count?: number }>;
};

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
function date(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function metricValue(metric: Metric) {
  if (metric.status === "not_comparable") return <em>Kept separate</em>;
  if (metric.value === undefined) return "—";
  if (metric.unit !== "seconds") return compact.format(metric.value);
  const minutes = Math.floor(metric.value / 60); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function AnalyticsReportPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<ClientReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch(`${apiBasePath}/analytics-reports/${encodeURIComponent(token)}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => { const body = await response.json().catch(() => ({})) as ClientReport & { message?: string }; if (!response.ok) throw new Error(body.message ?? "This report link is unavailable."); setView(body); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "This report link is unavailable."));
  }, [token]);

  if (error) return <main className={styles.page}><section className={styles.state}><AlertTriangle size={30} /><h1>Report unavailable</h1><p>{error}</p></section></main>;
  if (!view) return <main className={styles.page}><section className={styles.state}>Opening the saved report snapshot…</section></main>;

  return <main className={styles.page}>
    <header className={styles.top}><span className={styles.mark}>O</span><div><strong>OriginPost</strong><small>Read-only client report</small></div><span><ShieldCheck size={15} /> Saved proof snapshot</span></header>
    <div className={styles.main}>
      <section className={styles.hero}><div><p className={styles.eyebrow}>CLIENT PERFORMANCE REPORT</p><h1>{view.report.name}</h1><p>{date(view.report.periodFrom)} – {date(view.report.periodTo)} · Generated {date(view.report.generatedAt)}</p></div><a className={styles.download} href={`${apiBasePath}/analytics-reports/${encodeURIComponent(token)}/export.csv`}><Download size={15} /> Download CSV</a></section>
      {view.warnings.length ? <div className={styles.warnings}>{view.warnings.map((warning, index) => <div className={styles.warning} key={`${warning.code}-${index}`}><AlertTriangle size={16} /><span>{warning.message}</span></div>)}</div> : null}
      <section className={styles.summary} aria-label="Account summaries">{view.groups.map((group) => <article className={styles.card} key={`${group.brandName}-${group.platform}-${group.accountName}`}><header><div><span>{group.platform}</span><h2>{group.accountName}</h2><p>{group.brandName} · {group.measuredPosts}/{group.publishedPosts} measured</p></div>{group.needsAttention ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}</header><dl className={styles.metrics}>{group.metrics.map((metric) => <div className={styles.metric} key={metric.key}><dt>{metric.key.replaceAll("_", " ")}</dt><dd>{metricValue(metric)}</dd></div>)}</dl></article>)}</section>
      <section className={styles.section}><h2>Publication proof records</h2><p>Every row comes from an exact OriginPost proof record. Missing provider data is shown as missing, not zero; unique per-post values are never totalled.</p><div className={styles.posts}>{view.posts.map((post, index) => {
        const verified = post.evidenceMode === "official" || post.evidenceMode === "manual_attestation" || post.evidenceMode === "provider_reconciliation";
        return <article className={styles.post} key={`${post.liveUrl}-${index}`}><div><strong>{post.title}</strong><small>{post.brandName} · {post.platform} · {post.accountName} · {date(post.publishedAt)} · {post.status.replaceAll("_", " ")} · {post.evidenceMode.replaceAll("_", " ")}</small>{post.metrics.length ? <span className={styles.postMetrics}>{post.metrics.map((metric) => `${metric.key.replaceAll("_", " ")}: ${compact.format(metric.value)}${metric.aggregation === "non_additive" ? " (per post)" : ""}`).join(" · ")}</span> : null}</div>{verified ? <a href={post.liveUrl} target="_blank" rel="noreferrer">View live <ExternalLink size={13} /></a> : <span className={styles.simulation}>{post.evidenceMode === "simulation" ? "Simulation only" : "Unverified legacy proof"}</span>}</article>;
      })}</div></section>
      <footer className={styles.integrity}><strong>Snapshot integrity</strong><br />SHA-256 {view.report.canonicalSha256}<br />This read-only link expires {date(view.report.expiresAt)}.</footer>
    </div>
  </main>;
}
