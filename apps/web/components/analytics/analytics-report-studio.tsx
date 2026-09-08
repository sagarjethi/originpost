"use client";

import { AlertTriangle, Archive, BarChart3, CheckCircle2, Copy, Download, FilePlus2, RefreshCw, Share2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import styles from "./analytics-report-studio.module.css";

type Brand = { id: string; name: string; status: "active" | "archived" };
type SnapshotSummary = { id: string; generatedAt: string; periodFrom: string; periodTo: string; proofCount: number; groupCount: number; warningCount: number; canonicalSha256: string };
type Definition = { id: string; name: string; brandIds: string[]; range: { mode: "rolling"; days: number } | { mode: "fixed"; from: string; to: string }; platforms: string[]; accountIds: string[]; metricKeys: string[]; status: "active" | "archived"; version: number };
type ReportEntry = { definition: Definition; latestSnapshot: SnapshotSummary | null };
type Metric = { key: string; value?: number; unit?: string; status: "ready" | "unavailable" | "not_comparable" };
type Snapshot = SnapshotSummary & { reportId: string; reportName: string; groups: Array<{ key: string; brandName: string; platform: string; accountName: string; publishedPosts: number; measuredPosts: number; needsAttention: number; metrics: Metric[] }>; warnings: Array<{ code: string; message: string }>; proofRows: Array<{ title: string; evidenceMode?: string }> };
type Share = { id: string; snapshotId: string; expiresAt: string; createdAt: string; revokedAt?: string };
type ReportDetail = { definition: Definition; snapshots: SnapshotSummary[]; shares: Share[] };

const metricOptions = ["views", "engaged_views", "reach", "impressions", "clicks", "likes", "comments", "shares", "saves", "watch_time_seconds", "average_view_duration_seconds", "subscribers_gained"];
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
function date(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function statusMessage(body: { message?: string | string[] }, fallback: string) { return Array.isArray(body.message) ? body.message.join(" ") : body.message ?? fallback; }

export function AnalyticsReportStudio({ auth, workspaceId, activeBrandId, brands }: { auth: AuthView; workspaceId: string; activeBrandId: string; brands: Brand[] }) {
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [rangeMode, setRangeMode] = useState<"rolling" | "fixed">("rolling");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const role = auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role;
  const canManage = role === "owner" || role === "manager";
  const hasUnshareableEvidence = snapshot?.proofRows.some((row) => !["official", "manual_attestation", "provider_reconciliation"].includes(row.evidenceMode ?? "legacy_unknown")) ?? false;

  const loadReports = useCallback(async () => {
    setError("");
    const response = await apiFetch(`/v1/analytics/reports?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
    const body = await response.json().catch(() => ([])) as ReportEntry[] & { message?: string | string[] };
    if (!response.ok) { setError(statusMessage(body, "Could not load client reports.")); return; }
    setReports(body);
    if (!selectedId && body[0]) setSelectedId(body[0].definition.id);
  }, [auth.csrfToken, selectedId, workspaceId]);

  const loadDetail = useCallback(async (reportId: string) => {
    if (!reportId) { setDetail(null); setSnapshot(null); return; }
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(reportId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as ReportDetail & { message?: string | string[] };
    if (!response.ok) { setError(statusMessage(body, "Could not open this report.")); return; }
    setDetail(body);
    if (body.snapshots[0]) await openSnapshot(reportId, body.snapshots[0].id);
    else setSnapshot(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.csrfToken, workspaceId]);

  useEffect(() => { void loadReports(); }, [loadReports]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [loadDetail, selectedId]);

  async function openSnapshot(reportId: string, snapshotId: string) {
    setBusy("snapshot"); setError("");
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(reportId)}/snapshots/${encodeURIComponent(snapshotId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as Snapshot & { message?: string | string[] };
    setBusy("");
    if (!response.ok) { setError(statusMessage(body, "Could not open this saved snapshot.")); return; }
    setSnapshot(body);
  }

  async function createReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("create"); setError(""); setMessage("");
    const form = new FormData(event.currentTarget);
    const body = {
      workspaceId, name: String(form.get("name") ?? "").trim(), brandIds: form.getAll("brandIds").map(String), rangeMode,
      ...(rangeMode === "rolling" ? { rollingDays: Number(form.get("rollingDays")) } : { from: new Date(`${String(form.get("from"))}T00:00:00`).toISOString(), to: new Date(`${String(form.get("to"))}T23:59:59.999`).toISOString() }),
      platforms: form.getAll("platforms").map(String), accountIds: [], metricKeys: form.getAll("metricKeys").map(String),
    };
    const response = await apiFetch("/v1/analytics/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, auth.csrfToken);
    const result = await response.json().catch(() => ({})) as ReportEntry & { message?: string | string[] };
    setBusy("");
    if (!response.ok) { setError(statusMessage(result, "Could not create this report.")); return; }
    setFormOpen(false); setSelectedId(result.definition.id); setMessage("Report definition saved. Generate it to freeze the current proof-backed data."); await loadReports();
  }

  async function generate() {
    if (!selectedId) return; setBusy("generate"); setError(""); setMessage(""); setShareUrl("");
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(selectedId)}/generate?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as Snapshot & { message?: string | string[] };
    setBusy("");
    if (!response.ok) { setError(statusMessage(body, "Could not generate this report.")); return; }
    setSnapshot(body); setMessage(`Saved an immutable snapshot with ${body.proofRows.length} publication proof record${body.proofRows.length === 1 ? "" : "s"}.`); await loadReports(); await loadDetail(selectedId);
  }

  async function createShare() {
    if (!selectedId || !snapshot) return; setBusy("share"); setError(""); setMessage("");
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(selectedId)}/snapshots/${encodeURIComponent(snapshot.id)}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, expiresInDays: 14 }) }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as { url?: string; message?: string | string[] };
    setBusy("");
    if (!response.ok || !body.url) { setError(statusMessage(body, "Could not create a client link.")); return; }
    setShareUrl(body.url); setMessage("Read-only client link created for 14 days."); await loadDetail(selectedId);
  }

  async function revokeShare(shareId: string) {
    if (!selectedId || !window.confirm("Revoke this client link now? Anyone using it will immediately lose access.")) return;
    setBusy(`revoke:${shareId}`); setError(""); setMessage("");
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(selectedId)}/shares/${encodeURIComponent(shareId)}/revoke?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    setBusy("");
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { message?: string | string[] }; setError(statusMessage(body, "Could not revoke this client link.")); return; }
    setMessage("Client link revoked."); setShareUrl(""); await loadDetail(selectedId);
  }

  async function downloadCsv() {
    if (!selectedId || !snapshot) return; setBusy("csv"); setError("");
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(selectedId)}/snapshots/${encodeURIComponent(snapshot.id)}/export.csv?workspaceId=${encodeURIComponent(workspaceId)}`, {}, auth.csrfToken);
    setBusy("");
    if (!response.ok) { setError("Could not export this report."); return; }
    const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${detail?.definition.name ?? "originpost-report"}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  async function archive() {
    if (!selectedId || !window.confirm("Archive this report definition? Existing immutable snapshots and client links stay intact.")) return;
    setBusy("archive"); setError("");
    const response = await apiFetch(`/v1/analytics/reports/${encodeURIComponent(selectedId)}/archive?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    setBusy("");
    if (!response.ok) { setError("Could not archive this report."); return; }
    setSelectedId(""); setDetail(null); setSnapshot(null); await loadReports();
  }

  return <section className={styles.studio}>
    <div className={styles.toolbar}><div><h2>Client Report Studio</h2><p>Freeze exact proof-backed metrics, share a read-only view, and export CSV.</p></div><div><button type="button" onClick={() => void loadReports()}><RefreshCw size={14} /> Refresh</button>{canManage ? <button type="button" onClick={() => setFormOpen((value) => !value)}><FilePlus2 size={14} /> New report</button> : null}</div></div>
    {error ? <div className={`${styles.notice} ${styles.error}`} role="alert"><AlertTriangle size={16} /> {error}</div> : null}
    {message ? <div className={`${styles.notice} ${styles.success}`} role="status"><CheckCircle2 size={16} /> {message}</div> : null}
    {formOpen ? <form className={styles.form} onSubmit={createReport}><div className={styles.formGrid}><label>Report name<input name="name" required maxLength={120} placeholder="Monthly client performance" /></label><label>Date range<select value={rangeMode} onChange={(event) => setRangeMode(event.target.value as "rolling" | "fixed")}><option value="rolling">Rolling window</option><option value="fixed">Fixed dates</option></select></label>{rangeMode === "rolling" ? <label>Days<input name="rollingDays" type="number" min={1} max={366} defaultValue={30} required /></label> : <><label>From<input name="from" type="date" required /></label><label>To<input name="to" type="date" required /></label></>}</div><fieldset><legend>Brands</legend><div className={styles.checks}>{brands.filter((brand) => brand.status === "active").map((brand) => <label key={brand.id}><input type="checkbox" name="brandIds" value={brand.id} defaultChecked={brand.id === activeBrandId} /> {brand.name}</label>)}</div></fieldset><fieldset><legend>Platforms</legend><div className={styles.checks}><label><input type="checkbox" name="platforms" value="instagram" defaultChecked /> Instagram</label><label><input type="checkbox" name="platforms" value="facebook" defaultChecked /> Facebook Page</label><label><input type="checkbox" name="platforms" value="youtube" defaultChecked /> YouTube</label></div></fieldset><fieldset><legend>Metrics</legend><div className={styles.checks}>{metricOptions.map((metric) => <label key={metric}><input type="checkbox" name="metricKeys" value={metric} defaultChecked={["views", "reach", "clicks", "likes", "comments", "shares", "saves", "watch_time_seconds"].includes(metric)} /> {metric.replaceAll("_", " ")}</label>)}</div></fieldset><footer><button type="button" onClick={() => setFormOpen(false)}>Cancel</button><button type="submit" disabled={busy === "create"}>{busy === "create" ? "Saving…" : "Save report"}</button></footer></form> : null}
    <div className={styles.layout}><aside className={styles.list}>{reports.map((report) => <button className={styles.reportButton} data-active={selectedId === report.definition.id} key={report.definition.id} onClick={() => { setSelectedId(report.definition.id); setShareUrl(""); }}><span><strong>{report.definition.name}</strong><small>{report.definition.brandIds.length} brand{report.definition.brandIds.length === 1 ? "" : "s"} · {report.definition.platforms.join(" + ")}</small>{report.latestSnapshot ? <small>Latest {date(report.latestSnapshot.generatedAt)} · {report.latestSnapshot.proofCount} posts</small> : <small>Not generated yet</small>}</span><BarChart3 size={18} /></button>)}{!reports.length ? <div className={styles.empty}><BarChart3 size={24} /><p>No client reports yet.</p></div> : null}</aside>
      <article className={styles.detail}>{detail ? <><div className={styles.detailHead}><div><h2>{detail.definition.name}</h2><p>{detail.definition.range.mode === "rolling" ? `Last ${detail.definition.range.days} days` : `${date(detail.definition.range.from)} – ${date(detail.definition.range.to)}`}</p></div><div className={styles.actions}>{canManage ? <><button type="button" onClick={() => void generate()} disabled={Boolean(busy)}><RefreshCw size={14} /> {busy === "generate" ? "Generating…" : "Generate snapshot"}</button>{snapshot ? <button type="button" onClick={() => void createShare()} disabled={Boolean(busy) || hasUnshareableEvidence} title={hasUnshareableEvidence ? "Client links require verified or human-attested publication evidence." : undefined}><Share2 size={14} /> {hasUnshareableEvidence ? "Unverified proof cannot be shared" : "Client link"}</button> : null}</> : null}{snapshot ? <button type="button" onClick={() => void downloadCsv()} disabled={Boolean(busy)}><Download size={14} /> CSV</button> : null}{canManage ? <button type="button" onClick={() => void archive()} disabled={Boolean(busy)} aria-label="Archive report"><Archive size={14} /></button> : null}</div></div><div className={styles.meta}><span>{detail.definition.brandIds.length} selected brand{detail.definition.brandIds.length === 1 ? "" : "s"}</span><span>{detail.definition.platforms.join(" + ")}</span><span>{detail.definition.metricKeys.length} metrics</span><span>Definition v{detail.definition.version}</span></div>{shareUrl ? <div className={styles.share}><input readOnly value={shareUrl} aria-label="Read-only client report link" /><button type="button" onClick={() => void navigator.clipboard.writeText(shareUrl)}><Copy size={14} /> Copy</button></div> : null}{detail.shares.length ? <section className={styles.shareLedger} aria-label="Client links"><h3>Client links</h3>{detail.shares.map((share) => <div key={share.id}><span><strong>{share.revokedAt ? "Revoked" : Date.parse(share.expiresAt) <= Date.now() ? "Expired" : "Active"}</strong><small>Created {date(share.createdAt)} · expires {date(share.expiresAt)}</small></span>{canManage && !share.revokedAt && Date.parse(share.expiresAt) > Date.now() ? <button type="button" onClick={() => void revokeShare(share.id)} disabled={Boolean(busy)}>{busy === `revoke:${share.id}` ? "Revoking…" : "Revoke"}</button> : null}</div>)}</section> : null}<div className={styles.snapshots}>{detail.snapshots.map((entry) => <div className={styles.snapshot} key={entry.id}><button type="button" onClick={() => void openSnapshot(detail.definition.id, entry.id)}>{date(entry.generatedAt)}<small>{entry.proofCount} proof records · {entry.groupCount} account groups</small></button><span>{entry.warningCount ? `${entry.warningCount} warning${entry.warningCount === 1 ? "" : "s"}` : "Complete"}</span></div>)}</div>{snapshot ? <><div className={styles.warningList}>{snapshot.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}</div><div className={styles.groups}>{snapshot.groups.map((group) => <article className={styles.group} key={group.key}><small>{group.platform} · {group.brandName}</small><h3>{group.accountName}</h3><small>{group.measuredPosts}/{group.publishedPosts} proof records measured</small><dl className={styles.metrics}>{group.metrics.map((metric) => <div className={styles.metric} key={metric.key}><dt>{metric.key.replaceAll("_", " ")}</dt><dd>{metric.status === "not_comparable" ? <em>Kept separate</em> : metric.value === undefined ? "—" : compact.format(metric.value)}</dd></div>)}</dl></article>)}</div><small className={styles.hash}>Immutable snapshot SHA-256 {snapshot.canonicalSha256}</small></> : <div className={styles.empty}><p>Generate the first immutable snapshot to see and share this report.</p></div>}</> : <div className={styles.empty}><p>Choose a report or create a new one.</p></div>}</article>
    </div>
  </section>;
}
