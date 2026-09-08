"use client";

import { BookmarkPlus, CalendarDays, ExternalLink, Loader2, MapPinned, Radar, RefreshCw, RotateCcw, ShieldCheck, Users, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import styles from "./source-signal-desk.module.css";

type SignalState = "new" | "saving" | "saved" | "dismissed";
type Signal = {
  id: string; version: number; state: SignalState; urgency: "low" | "normal" | "high"; score: number; rankReasons: string[];
  title: string; summary: string; occurrenceCount: number; firstSeenAt: string; lastSeenAt: string; contentItemId?: string;
  sources: Array<{ id: string; title: string; url?: string; publisher?: string; publishedAt?: string; rights?: string }>;
};
type Summary = { new: number; saving: number; saved: number; dismissed: number; highUrgency: number };
type MonitorStatus = { monitor: { id: string; name: string; enabled: boolean; sourceIntelligence?: { sources?: Array<{ kind?: string; url?: string }> } } };

const lumaUrl = "https://luma.com/mumbai";

function messageFrom(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const message = (body as { message?: unknown }).message;
  return Array.isArray(message) ? message.join(" ") : typeof message === "string" ? message : fallback;
}

function shortTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function SourceSignalDesk({ auth, workspaceId, brandId, onOpenContent }: { auth: AuthView; workspaceId: string; brandId: string; onOpenContent?: (contentItemId: string) => void }) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [summary, setSummary] = useState<Summary>({ new: 0, saving: 0, saved: 0, dismissed: 0, highUrgency: 0 });
  const [filter, setFilter] = useState<"all" | "new" | "saved" | "dismissed">("new");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [lumaBusy, setLumaBusy] = useState(false);
  const [lumaMonitorId, setLumaMonitorId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ workspaceId, brandId, limit: "150", ...(filter === "all" ? {} : { state: filter }), ...(search.trim() ? { search: search.trim() } : {}) });
      const [listResponse, summaryResponse, monitorsResponse] = await Promise.all([
        apiFetch(`/v1/signals?${query}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/signals/summary?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/monitors/status?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!listResponse.ok || !summaryResponse.ok) throw new Error("Could not load source signals.");
      setSignals(await listResponse.json() as Signal[]);
      setSummary(await summaryResponse.json() as Summary);
      if (monitorsResponse.ok) {
        const statuses = await monitorsResponse.json() as MonitorStatus[];
        const matchesLuma = ({ monitor }: MonitorStatus) => monitor.sourceIntelligence?.sources?.some((source) => source.kind === "luma_city" && source.url === lumaUrl);
        const luma = statuses.find((status) => status.monitor.enabled && matchesLuma(status)) ?? statuses.find(matchesLuma);
        setLumaMonitorId(luma?.monitor.id ?? "");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Source Signals are unavailable."); }
    finally { setLoading(false); }
  }, [auth.csrfToken, brandId, filter, search, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => filter === "all" ? signals : signals.filter((signal) => signal.state === filter), [filter, signals]);

  async function mutate(signal: Signal, action: "save" | "dismiss" | "restore") {
    const reason = action === "dismiss" ? window.prompt("Why is this signal not useful? (optional)", "") : null;
    if (action === "dismiss" && reason === null) return;
    setBusyId(signal.id); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/signals/${encodeURIComponent(signal.id)}/${action}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST", headers: { "if-match": String(signal.version), ...(action === "dismiss" ? { "content-type": "application/json" } : {}) },
        ...(action === "dismiss" ? { body: JSON.stringify({ reason: reason?.trim() || undefined }) } : {}),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { contentItem?: { id?: string }; message?: unknown };
      if (!response.ok) throw new Error(messageFrom(body, "This signal changed. Refresh and try again."));
      if (action === "save" && body.contentItem?.id) {
        setNotice("Saved to the Content Inbox with its source links.");
        onOpenContent?.(body.contentItem.id);
      } else setNotice(action === "dismiss" ? "Signal dismissed." : "Signal restored to New.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this signal."); }
    finally { setBusyId(""); }
  }

  async function startLumaMumbai() {
    setLumaBusy(true); setError(""); setNotice("");
    try {
      let monitorId = lumaMonitorId;
      if (!monitorId) {
        const response = await apiFetch("/v1/monitors", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            workspaceId, brandId, name: "Luma Mumbai events", intervalMinutes: 60, depth: "standard",
            query: "Upcoming public events in Mumbai listed by Luma. Return each event title, official event URL, date and time, venue, and public hosts or organizers. Never include attendees or private guest lists.",
            languages: ["English", "Hindi"], region: "Mumbai, Maharashtra, India", sourceLimit: 15, freshnessHours: 720, enabled: true,
            sourceIntelligence: { mode: "tracked_sources", sources: [{ label: "Luma Mumbai city events", url: lumaUrl, kind: "luma_city", publisher: "Luma", priority: "primary", enabled: true }], includeTerms: [], excludeTerms: [], minimumScore: 35 },
          }),
        }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as { id?: string; message?: unknown };
        if (!response.ok || !body.id) throw new Error(messageFrom(body, "Could not add the Luma Mumbai monitor."));
        monitorId = body.id; setLumaMonitorId(monitorId);
      }
      const run = await apiFetch(`/v1/monitors/${encodeURIComponent(monitorId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
      if (!run.ok) throw new Error(messageFrom(await run.json().catch(() => ({})), "Could not start the Luma Mumbai check."));
      setNotice("Luma Mumbai check started. New events will appear here after the research run finishes.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start Luma Mumbai."); }
    finally { setLumaBusy(false); }
  }

  return <section className={styles.page}>
    <header className={styles.hero}>
      <div><p>SOURCE SIGNAL DESK</p><h1>Find the useful update before it becomes a post.</h1><span>Review ranked, source-linked findings. Nothing enters the Content Inbox until a person saves it.</span></div>
      <button onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? styles.spin : ""} /> Refresh</button>
    </header>

    <section className={styles.lumaCard} aria-label="Luma Mumbai events">
      <div className={styles.lumaVisual} role="img" aria-label="Mumbai city reference image supplied by the workspace owner"><span><MapPinned size={18} /> Mumbai</span></div>
      <div><p>PUBLIC EVENT SOURCE</p><h2>Luma Mumbai events</h2><span>Track upcoming Mumbai events, venues, and public hosts. Attendee and guest-list names are never collected. The Mumbai photo is a city visual, not proof of any event.</span><div><a href={lumaUrl} target="_blank" rel="noreferrer">Open official city page <ExternalLink size={13} /></a><em><Users size={13} /> Public hosts only</em></div></div>
      <button onClick={() => void startLumaMumbai()} disabled={lumaBusy}>{lumaBusy ? <Loader2 className={styles.spin} size={15} /> : <CalendarDays size={15} />}{lumaMonitorId ? "Check Luma now" : "Add Luma Mumbai"}</button>
    </section>

    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {notice ? <div className={styles.notice} role="status">{notice}</div> : null}

    <div className={styles.stats}>
      <article><Radar size={18} /><span><small>New</small><strong>{summary.new}</strong></span></article>
      <article><ShieldCheck size={18} /><span><small>High priority</small><strong>{summary.highUrgency}</strong></span></article>
      <article><BookmarkPlus size={18} /><span><small>Saved</small><strong>{summary.saved}</strong></span></article>
      <article><XCircle size={18} /><span><small>Dismissed</small><strong>{summary.dismissed}</strong></span></article>
    </div>

    <div className={styles.toolbar}>
      <div>{(["new", "all", "saved", "dismissed"] as const).map((value) => <button key={value} className={filter === value ? styles.active : ""} onClick={() => setFilter(value)}>{value === "all" ? "All" : value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search signals or sources…" aria-label="Search source signals" />
    </div>

    <div className={styles.list}>
      {loading ? <div className={styles.empty}><Loader2 className={styles.spin} /><strong>Loading signals…</strong></div> : shown.map((signal) => <article key={signal.id} className={`${styles.signal} ${styles[signal.urgency]}`}>
        <div className={styles.score}><strong>{signal.score}</strong><small>/100</small></div>
        <div className={styles.copy}>
          <div className={styles.signalHead}><span>{signal.urgency} priority</span><time>{shortTime(signal.lastSeenAt)}</time></div>
          <h2>{signal.title}</h2><p>{signal.summary}</p>
          <div className={styles.reasons}>{signal.rankReasons.map((reason) => <em key={reason}>{reason}</em>)}</div>
          <div className={styles.sources}>{signal.sources.map((source) => source.url ? <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /><span><strong>{source.publisher ?? source.title}</strong><small>{source.publishedAt ? shortTime(source.publishedAt) : "Publication time unavailable"} · Reference only</small></span></a> : null)}</div>
          <small className={styles.seen}>Seen {signal.occurrenceCount} time{signal.occurrenceCount === 1 ? "" : "s"} · first seen {shortTime(signal.firstSeenAt)}</small>
        </div>
        <div className={styles.actions}>
          {signal.state === "new" ? <><button className={styles.primary} disabled={busyId === signal.id} onClick={() => void mutate(signal, "save")}><BookmarkPlus size={14} /> Save to Inbox</button><button disabled={busyId === signal.id} onClick={() => void mutate(signal, "dismiss")}><XCircle size={14} /> Dismiss</button></> : null}
          {signal.state === "saving" ? <button disabled><Loader2 className={styles.spin} size={14} /> Saving safely</button> : null}
          {signal.state === "dismissed" ? <button disabled={busyId === signal.id} onClick={() => void mutate(signal, "restore")}><RotateCcw size={14} /> Restore</button> : null}
          {signal.state === "saved" && signal.contentItemId ? <button className={styles.primary} onClick={() => onOpenContent?.(signal.contentItemId!)}><BookmarkPlus size={14} /> Open content</button> : null}
        </div>
      </article>)}
      {!loading && shown.length === 0 ? <div className={styles.empty}><Radar size={24} /><strong>No {filter === "all" ? "" : filter} signals yet</strong><p>Add the Luma Mumbai watch or create an RSS/Atom monitor. Repeats and weak matches will stay quiet.</p></div> : null}
    </div>
  </section>;
}
