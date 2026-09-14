"use client";

import { BookmarkPlus, CalendarDays, ExternalLink, Loader2, MapPinned, Radar, RefreshCw, RotateCcw, ShieldCheck, Users, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import styles from "./source-signal-desk.module.css";

type SignalState = "new" | "saving" | "saved" | "dismissed";
type Signal = {
  id: string; version: number; state: SignalState; urgency: "low" | "normal" | "high"; score: number; rankReasons: string[];
  title: string; summary: string; occurrenceCount: number; firstSeenAt: string; lastSeenAt: string; publishedAt?: string; contentItemId?: string;
  sources: Array<{ id: string; title: string; url?: string; publisher?: string; publishedAt?: string; rights?: string; snapshot?: { capturedAt: string; pageUrl: string } }>;
};
type Summary = { new: number; saving: number; saved: number; dismissed: number; highUrgency: number };
type MonitorStatus = { health?: string; lastRun?: {reason?: string; error?: string}; monitor: { id: string; name: string; enabled: boolean; sourceIntelligence?: { sources?: Array<{ kind?: string; url?: string }> } } };

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
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState("newest");
  const [recentHours, setRecentHours] = useState("");
  const [monitorId, setMonitorId] = useState("");
  const [monitors, setMonitors] = useState<MonitorStatus[]>([]);
  const [feedName, setFeedName] = useState("");
  const [feedUrls, setFeedUrls] = useState("");
  const [sourceKind, setSourceKind] = useState("rss_atom");
  const screenshotRef = useRef<HTMLElement>(null);
  const [sourceScreenshot, setSourceScreenshot] = useState<{ workspaceId: string; brandId: string; url: string; pageUrl: string; capturedAt: string; resourceFailures?: number } | null>(null);
  useEffect(() => { if (sourceScreenshot) screenshotRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [sourceScreenshot]);
  const [intervalMinutes, setIntervalMinutes] = useState("120");
  const [feedBusy, setFeedBusy] = useState(false);
  const loadSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [lumaBusy, setLumaBusy] = useState(false);
  const [lumaMonitorId, setLumaMonitorId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ workspaceId, brandId, limit: "100", offset: String(page * 100), sort, ...(recentHours ? { recentHours } : {}), ...(monitorId ? {monitorId} : {}), ...(filter === "all" ? {} : { state: filter }), ...(search.trim() ? { search: search.trim() } : {}) });
      const [listResponse, summaryResponse, monitorsResponse] = await Promise.all([
        apiFetch(`/v1/signals?${query}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/signals/summary?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/monitors/status?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!listResponse.ok || !summaryResponse.ok) throw new Error("Could not load source signals.");
      const newSignals = await listResponse.json() as Signal[];
      const newSummary = await summaryResponse.json() as Summary;
      if (sequence !== loadSequence.current) return;
      setSignals(newSignals); setSummary(newSummary);
      if (monitorsResponse.ok) {
        const statuses = await monitorsResponse.json() as MonitorStatus[];
        if (sequence !== loadSequence.current) return;
        setMonitors(statuses);
        const matchesLuma = ({ monitor }: MonitorStatus) => monitor.sourceIntelligence?.sources?.some((source) => source.kind === "luma_city" && source.url === lumaUrl);
        const luma = statuses.find((status) => status.monitor.enabled && matchesLuma(status)) ?? statuses.find(matchesLuma);
        setLumaMonitorId(luma?.monitor.id ?? "");
      }
    } catch (cause) { if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "Source Signals are unavailable."); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [auth.csrfToken, brandId, filter, search, workspaceId, sort, recentHours, monitorId, page]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60000); return () => { clearInterval(timer); loadSequence.current += 1; }; }, [load]);

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
      const body = await response.json().catch(() => ({})) as { contentItem?: { id?: string; version?: number }; idempotentReplay?: boolean; message?: unknown };
      if (!response.ok) throw new Error(messageFrom(body, "This signal changed. Refresh and try again."));
      if (action === "save" && body.contentItem?.id) {
        setNotice("Saved to the Content Inbox with its source links.");
        if (!body.idempotentReplay && body.contentItem.version) {
          try {
            const research = await apiFetch(`/v1/content-items/${encodeURIComponent(body.contentItem.id)}/research?workspaceId=${encodeURIComponent(workspaceId)}`, {method:"POST",headers:{"content-type":"application/json","if-match":String(body.contentItem.version)},body:JSON.stringify({query:`Independently verify the key claims in: ${signal.title}`.slice(0,500),depth:"standard",languages:["English","Gujarati","Hindi"],sourceLimit:8,freshnessHours:168})},auth.csrfToken);
            if (!research.ok) throw new Error("Research unavailable");
            setNotice("Saved with sources. Independent research is queued; review its evidence before writing.");
          } catch { setNotice("Saved with sources, but research could not be confirmed. Check its research status before retrying."); }
        }
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

  async function addFeedCollection(event: React.FormEvent) {
    event.preventDefault(); setFeedBusy(true); setError(""); setNotice("");
    try {
      const urls = [...new Set(feedUrls.split(/\n/).map(value => value.trim()).filter(Boolean))];
      if (!urls.length || urls.length > 20) throw new Error("Add 1–20 public source URLs, one per line.");
      const sources = urls.map((url) => ({ label: new URL(url).hostname, url, kind: sourceKind, priority: "trusted", enabled: true }));
      const response = await apiFetch("/v1/monitors", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ workspaceId, brandId, name: feedName, query: `Latest updates from ${feedName}`, intervalMinutes: Number(intervalMinutes), depth: "standard", languages: ["English"], sourceLimit: 20, freshnessHours: 24, enabled: true, sourceIntelligence: {mode:"tracked_sources", sources, includeTerms:[], excludeTerms:[], minimumScore: 35} }) }, auth.csrfToken);
      const body = await response.json();
      if (!response.ok) throw new Error(messageFrom(body,"Could not save the source collection."));
      setFeedName(""); setFeedUrls("");
      const run = await apiFetch(`/v1/monitors/${encodeURIComponent(body.id)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {method:"POST"}, auth.csrfToken);
      if (!run.ok) { setNotice("Source collection saved. Its first check could not be queued; retry from Automations."); }
      else setNotice("Source collection saved and first check queued. This desk refreshes every minute.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add sources."); }
    finally { setFeedBusy(false); }
  }

  async function openScreenshot(signalId: string, sourceId: string) {
    setError("");
    try {
      const response = await apiFetch(`/v1/signals/${signalId}/sources/${sourceId}/screenshot?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Could not open the source screenshot."));
      setSourceScreenshot({ url: body.url, ...body.snapshot, workspaceId, brandId });
    } catch (error) { setError(error instanceof Error ? error.message : "Source screenshot unavailable."); }
  }

  return <section className={styles.page}>
    <header className={styles.hero}>
      <div><p>NEWS & SOURCE DESK</p><h1>Your daily news, with the sources attached.</h1><span>Collect updates from your chosen feeds and public publisher pages. Check facts and image rights before making a post.</span></div>
      <button onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? styles.spin : ""} /> Refresh</button>
    </header>

    {sourceScreenshot && sourceScreenshot.workspaceId === workspaceId && sourceScreenshot.brandId === brandId && <section ref={screenshotRef} className={`${styles.feedSetup} ${styles.capture}`} aria-label="Publisher desktop screenshot">
      <button onClick={() => setSourceScreenshot(null)}>Close capture</button>
      <p>Source page captured {shortTime(sourceScreenshot.capturedAt)} · Research evidence only. This does not grant image reuse rights.</p>
      {Boolean(sourceScreenshot.resourceFailures) && <p>Some page images or styling could not load. Compare this capture with the original page.</p>}
      <a href={sourceScreenshot.pageUrl} target="_blank" rel="noreferrer">Open the captured page</a>
      <img src={sourceScreenshot.url} alt="Desktop capture of the publisher page" style={{ maxWidth: "100%", height: "auto" }} onError={() => setError("The capture link expired or is unavailable. Close it and open the capture again.")} />
    </section>}
    <details className={styles.feedSetup}>
      <summary>Add news sources</summary>
      <p>Create a section such as Gujarat, India, Business, or Science. Use publisher feeds or public newsroom pages you have permission to collect.</p>
      <form onSubmit={event => void addFeedCollection(event)}>
        <label>Section name<input required minLength={2} maxLength={120} value={feedName} onChange={event => setFeedName(event.target.value)} placeholder="Gujarat news" /></label>
        <label>Source type<select value={sourceKind} onChange={event => setSourceKind(event.target.value)}><option value="rss_atom">RSS / Atom feeds</option><option value="publisher_site">Publisher websites · desktop screenshots</option></select></label>
        <label>{sourceKind === "rss_atom" ? "Feed URLs" : "Publisher page URLs"} · one per line<textarea required rows={4} value={feedUrls} onChange={event => setFeedUrls(event.target.value)} placeholder={sourceKind === "rss_atom" ? "https://publisher.example/feed.xml" : "https://publisher.example/news"} /></label>
        <label>Check for updates<select value={intervalMinutes} onChange={event => setIntervalMinutes(event.target.value)}><option value="10">Every 10 minutes</option><option value="30">Every 30 minutes</option><option value="120">Every 2 hours</option><option value="1440">Daily</option></select></label>
        <p>Collects the last 24 hours plus leads with unknown dates. Website mode captures public, server-rendered text and a desktop screenshot. Login, blocked and script-only pages need a manual check. View failures and pause sources in <a href="/automations">Automations</a>.</p>
        <button disabled={feedBusy}>{feedBusy ? "Adding sources…" : "Save sources & check now"}</button>
      </form>
    </details>

    <section className={styles.lumaCard} aria-label="Luma Mumbai events">
      <div className={styles.lumaVisual} role="img" aria-label="Mumbai city reference image supplied by the workspace owner"><span><MapPinned size={18} /> Mumbai</span></div>
      <div><p>PUBLIC EVENT SOURCE</p><h2>Luma Mumbai events</h2><span>Track upcoming Mumbai events, venues, and public hosts. Attendee and guest-list names are never collected. The Mumbai photo is a city visual, not proof of any event.</span><div><a href={lumaUrl} target="_blank" rel="noreferrer">Open official city page <ExternalLink size={13} /></a><em><Users size={13} /> Public hosts only</em></div></div>
      <button onClick={() => void startLumaMumbai()} disabled={lumaBusy}>{lumaBusy ? <Loader2 className={styles.spin} size={15} /> : <CalendarDays size={15} />}{lumaMonitorId ? "Check Luma now" : "Add Luma Mumbai"}</button>
    </section>

    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {notice ? <div className={styles.notice} role="status">{notice}</div> : null}

    {monitors.filter(status => ["degraded", "failed", "stale"].includes(status.health ?? "")).map(status => <div className={styles.notice} key={status.monitor.id} role="status"><strong>{status.monitor.name}: {status.health}</strong> · {status.lastRun?.error ?? status.lastRun?.reason ?? "No recent successful check. Open Automations to investigate."}</div>)}
    <div className={styles.stats}>
      <article><Radar size={18} /><span><small>New</small><strong>{summary.new}</strong></span></article>
      <article><ShieldCheck size={18} /><span><small>High priority</small><strong>{summary.highUrgency}</strong></span></article>
      <article><BookmarkPlus size={18} /><span><small>Saved</small><strong>{summary.saved}</strong></span></article>
      <article><XCircle size={18} /><span><small>Dismissed</small><strong>{summary.dismissed}</strong></span></article>
    </div>

    <div className={styles.toolbar}>
      <div>{(["new", "all", "saved", "dismissed"] as const).map((value) => <button key={value} className={filter === value ? styles.active : ""} onClick={() => {setPage(0); setFilter(value);}}>{value === "all" ? "All" : value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
      <label>Section<select aria-label="News section" value={monitorId} onChange={event => {setPage(0); setMonitorId(event.target.value);}}><option value="">All sections</option>{monitors.filter(value => value.monitor.sourceIntelligence).map(value => <option key={value.monitor.id} value={value.monitor.id}>{value.monitor.name}</option>)}</select></label>
      <label>When<select aria-label="Publication window" value={recentHours} onChange={event => {setPage(0); setRecentHours(event.target.value);}}><option value="">Any time · include unknown</option><option value="2">Last 2 hours</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option></select></label>
      <label>Order<select aria-label="News order" value={sort} onChange={event => {setPage(0); setSort(event.target.value);}}><option value="newest">Newest published</option><option value="discovered">Newly found</option><option value="priority">Highest priority</option></select></label>
      <input value={search} onChange={(event) => {setPage(0); setSearch(event.target.value);}} placeholder="Search signals or sources…" aria-label="Search source signals" />
    </div>

    <nav className={styles.toolbar} aria-label="News result pages"><button disabled={loading || page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page + 1} · up to 100 reports</span><button disabled={loading || signals.length < 100 || page >= 1000} onClick={() => setPage(value => value + 1)}>Next</button></nav>
    <div className={styles.list}>
      {loading ? <div className={styles.empty}><Loader2 className={styles.spin} /><strong>Loading signals…</strong></div> : shown.map((signal) => <article key={signal.id} className={`${styles.signal} ${styles[signal.urgency]}`}>
        <div className={styles.score}><strong>{signal.score}</strong><small>/100</small></div>
        <div className={styles.copy}>
          <div className={styles.signalHead}><span>{signal.urgency} priority</span><time>{signal.publishedAt ? `Published ${shortTime(signal.publishedAt)}` : "Publication time unknown"}</time></div>
          <h2>{signal.title}</h2><p>{signal.summary}</p><p className={styles.verification}>Verify before posting · Check important claims against an independent source. Source images and screenshots are not cleared for reuse.</p>
          <div className={styles.reasons}>{signal.rankReasons.map((reason) => <em key={reason}>{reason}</em>)}</div>
          <div className={styles.sources}>{signal.sources.map((source) => source.url ? <div key={source.id}><a href={source.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /><span><strong>{source.publisher ?? source.title}</strong><small>{source.publishedAt ? shortTime(source.publishedAt) : "Publication time unavailable"} · Reference only</small></span></a>{source.snapshot && <button onClick={() => void openScreenshot(signal.id, source.id)}>View desktop capture · {shortTime(source.snapshot.capturedAt)}</button>}</div> : null)}</div>
          <small className={styles.seen}>Seen {signal.occurrenceCount} time{signal.occurrenceCount === 1 ? "" : "s"} · first seen {shortTime(signal.firstSeenAt)}</small>
        </div>
        <div className={styles.actions}>
          {(signal.state === "new" || signal.state === "saved") && <a className={styles.primary} href={`/agent?sourceSignal=${encodeURIComponent(signal.id)}&sourceVersion=${signal.version}`}>Create post</a>}
          {signal.state === "new" ? <><button className={styles.primary} disabled={busyId === signal.id} onClick={() => void mutate(signal, "save")}><BookmarkPlus size={14} /> Save & research</button><button disabled={busyId === signal.id} onClick={() => void mutate(signal, "dismiss")}><XCircle size={14} /> Dismiss</button></> : null}
          {signal.state === "saving" ? <button disabled><Loader2 className={styles.spin} size={14} /> Saving safely</button> : null}
          {signal.state === "dismissed" ? <button disabled={busyId === signal.id} onClick={() => void mutate(signal, "restore")}><RotateCcw size={14} /> Restore</button> : null}
          {signal.state === "saved" && signal.contentItemId ? <button className={styles.primary} onClick={() => onOpenContent?.(signal.contentItemId!)}><BookmarkPlus size={14} /> Open content</button> : null}
        </div>
      </article>)}
      {!loading && shown.length === 0 ? <div className={styles.empty}><Radar size={24} /><strong>No {filter === "all" ? "" : filter} signals yet</strong><p>Add your news sources above or adjust the publication window. Unknown publication dates appear only in Any time.</p></div> : null}
    </div>
  </section>;
}
