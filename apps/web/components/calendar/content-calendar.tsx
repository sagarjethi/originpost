"use client";

import {
  AlertTriangle,
  Camera,
  CalendarClock,
  CalendarDays,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  Download,
  LayoutGrid,
  Grid3X3,
  List,
  RefreshCw,
  Share2,
  Trash2,
  Play,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { platformLabel } from "../platform-ui";
import {
  browserTimeZone,
  calendarEntriesForMonth,
  dateKeyInZone,
  flattenCalendarEntries,
  formatInZone,
  formatUtc,
  isValidTimeZone,
  monthDays,
  monthKeyInZone,
  shiftMonth,
  toLocalInputValue,
  zonedDateTimeToUtc,
  type CalendarContentItem,
  type CalendarEntry,
} from "./calendar-utils";
import { InstagramGridPlanner } from "./instagram-grid-planner";
import { scheduleConflictHeadline, scheduleConflictReady } from "../content-studio/schedule-conflict-utils";

type ScheduleConflict = { contentTitle: string; targetId: string; scheduledFor: string; status: string; kinds: Array<"exact_content_duplicate" | "account_time_overlap">; minutesApart: number };
type ScheduleConflictPreflight = { conflicts: ScheduleConflict[]; acknowledgementSha256: string; requiresConfirmation: boolean };

type CalendarProps = {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  brandName: string;
  items: CalendarContentItem[];
  loading: boolean;
  dataMode: "api" | "demo" | "loading" | "error";
  onChanged: () => void | Promise<void>;
};

const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const commonTimeZones = ["UTC", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "America/Los_Angeles"];
const editableStatus = "queued";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function platformMark(platform: string) {
  if (platform === "instagram") return <Camera size={15} aria-hidden="true" />;
  if (platform === "facebook") return <Share2 size={15} aria-hidden="true" />;
  if (platform === "youtube") return <Play size={15} fill="currentColor" aria-hidden="true" />;
  return <span aria-hidden="true">?</span>;
}

function timeInZone(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function monthTitle(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year!, month! - 1, 1)));
}

function readableError(body: { message?: string | string[] } | undefined, fallback: string) {
  return Array.isArray(body?.message) ? body.message.join(" ") : body?.message ?? fallback;
}

function TargetButton({ entry, calendarZone, selected, onSelect, compact = false }: {
  entry: CalendarEntry;
  calendarZone: string;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  const savedZone = entry.target.timezone && isValidTimeZone(entry.target.timezone) ? entry.target.timezone : calendarZone;
  return <button
    type="button"
    className={`calendar-target ${entry.target.status} ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
    onClick={onSelect}
    aria-pressed={selected}
    aria-label={`${entry.contentTitle}, ${platformLabel(entry.target.platform)}, ${label(entry.target.status)}, ${formatInZone(entry.target.scheduledFor, savedZone)}`}
  >
    <span className={`calendar-platform ${entry.target.platform}`}>{platformMark(entry.target.platform)}</span>
    <span className="calendar-target-copy"><strong>{entry.contentTitle}</strong><small>{timeInZone(entry.target.scheduledFor, calendarZone)} · {entry.target.queueAssignment ? "Queue assigned · " : ""}{label(entry.target.status)}</small></span>
  </button>;
}

export function ContentCalendar({ auth, workspaceId, brandId, brandName, items, loading, dataMode, onChanged }: CalendarProps) {
  const calendarZone = useMemo(browserTimeZone, []);
  const entries = useMemo(() => flattenCalendarEntries(items), [items]);
  const [view, setView] = useState<"month" | "list" | "grid">("month");
  const [viewMonth, setViewMonth] = useState(() => monthKeyInZone(new Date(), calendarZone));
  const [platformFilter, setPlatformFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [timezone, setTimezone] = useState(calendarZone);
  const [busy, setBusy] = useState<"reschedule" | "cancel" | "export" | "">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reschedulePreflight, setReschedulePreflight] = useState<ScheduleConflictPreflight | null>(null);
  const [reschedulePreflightBusy, setReschedulePreflightBusy] = useState(false);
  const [reschedulePreflightError, setReschedulePreflightError] = useState("");
  const [acknowledgedConflictHash, setAcknowledgedConflictHash] = useState("");
  const detailTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setView("list");
  }, []);

  const platforms = useMemo(() => [...new Set(entries.map((entry) => entry.target.platform))].sort(), [entries]);
  const statuses = useMemo(() => [...new Set(entries.map((entry) => entry.target.status))].sort(), [entries]);
  const filteredEntries = useMemo(() => entries.filter((entry) => {
    if (platformFilter !== "all" && entry.target.platform !== platformFilter) return false;
    return statusFilter === "all" || entry.target.status === statusFilter;
  }), [entries, platformFilter, statusFilter]);
  const visibleMonthEntries = useMemo(() => calendarEntriesForMonth(filteredEntries, viewMonth, calendarZone), [calendarZone, filteredEntries, viewMonth]);
  const selected = entries.find((entry) => entry.key === selectedKey);
  const shownTimeZones = useMemo(() => [...new Set([calendarZone, ...entries.map((entry) => entry.target.timezone).filter((value): value is string => Boolean(value)), ...commonTimeZones])], [calendarZone, entries]);

  useEffect(() => {
    if (!selected) return;
    const nextZone = selected.target.timezone && isValidTimeZone(selected.target.timezone) ? selected.target.timezone : calendarZone;
    setTimezone(nextZone);
    setScheduledLocal(toLocalInputValue(selected.target.scheduledFor, nextZone));
    setConfirmCancel(false);
    setReschedulePreflight(null);
    setReschedulePreflightError("");
    setAcknowledgedConflictHash("");
    setError("");
    setMessage("");
  }, [calendarZone, selected?.key, selected?.target.scheduledFor, selected?.target.timezone]);

  useEffect(() => {
    if (selectedKey && !entries.some((entry) => entry.key === selectedKey)) setSelectedKey("");
  }, [entries, selectedKey]);

  useEffect(() => {
    if (!selected || !window.matchMedia("(max-width: 760px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      detailTitleRef.current?.focus({ preventScroll: true });
      detailTitleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected?.key]);

  const todayKey = dateKeyInZone(new Date(), calendarZone);
  const cells = monthDays(viewMonth);
  const entriesByDate = useMemo(() => {
    const grouped = new Map<string, CalendarEntry[]>();
    for (const entry of visibleMonthEntries) {
      const key = dateKeyInZone(entry.target.scheduledFor, calendarZone);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [calendarZone, visibleMonthEntries]);
  const listGroups = useMemo(() => [...entriesByDate.entries()].sort(([left], [right]) => left.localeCompare(right)), [entriesByDate]);
  const queuedCount = entries.filter((entry) => entry.target.status === editableStatus).length;
  const actionCount = entries.filter((entry) => ["action_required", "failed"].includes(entry.target.status)).length;
  const monthEntryCount = visibleMonthEntries.length;
  const role = auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role;
  const canManageSchedule = role === "owner" || role === "manager";

  useEffect(() => {
    setReschedulePreflight(null); setReschedulePreflightError(""); setAcknowledgedConflictHash("");
    if (!selected || selected.target.status !== editableStatus || !selected.contentVersion || !canManageSchedule || dataMode !== "api") return;
    let scheduledFor: string;
    try { scheduledFor = zonedDateTimeToUtc(scheduledLocal, timezone.trim()); }
    catch { return; }
    if (new Date(scheduledFor).getTime() <= Date.now()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setReschedulePreflightBusy(true);
      void (async () => {
        const response = await apiFetch(`/v1/content-items/${encodeURIComponent(selected.contentId)}/schedule-preflight?workspaceId=${encodeURIComponent(workspaceId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "if-match": String(selected.contentVersion) },
          body: JSON.stringify({ platform: selected.target.platform, accountId: selected.target.accountId, draftId: selected.target.draftId, scheduledFor, timezone: timezone.trim(), deliveryMode: selected.target.deliveryMode ?? "auto_publish", excludeTargetId: selected.target.id }),
        }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as ScheduleConflictPreflight & { message?: string | string[] };
        if (!response.ok) throw new Error(readableError(body, "Could not check the calendar for conflicts."));
        if (!cancelled) setReschedulePreflight(body);
      })().catch((cause) => { if (!cancelled) setReschedulePreflightError(cause instanceof Error ? cause.message : "Could not check the calendar for conflicts."); })
        .finally(() => { if (!cancelled) setReschedulePreflightBusy(false); });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [auth.csrfToken, canManageSchedule, dataMode, scheduledLocal, selected?.contentId, selected?.contentVersion, selected?.target.accountId, selected?.target.deliveryMode, selected?.target.draftId, selected?.target.id, selected?.target.platform, selected?.target.status, timezone, workspaceId]);

  async function reschedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || selected.target.status !== editableStatus) return;
    if (!selected.contentVersion) { setError("Refresh this content before changing its schedule."); return; }
    let scheduledFor: string;
    try { scheduledFor = zonedDateTimeToUtc(scheduledLocal, timezone.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Choose a valid date, time, and time zone."); return; }
    if (new Date(scheduledFor).getTime() <= Date.now()) { setError("Choose a publish time in the future."); return; }
    if (!scheduleConflictReady(reschedulePreflight, acknowledgedConflictHash)) { setError(reschedulePreflight?.requiresConfirmation ? "Review and confirm the current scheduling warnings first." : "Wait for the calendar conflict check before rescheduling."); return; }
    setBusy("reschedule"); setError(""); setMessage("");
    try {
      const response = await apiFetch(`/v1/content-items/${encodeURIComponent(selected.contentId)}/targets/${encodeURIComponent(selected.target.id)}/reschedule?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": String(selected.contentVersion) },
        body: JSON.stringify({ scheduledFor, timezone: timezone.trim(), ...(reschedulePreflight?.requiresConfirmation ? { conflictAcknowledgementSha256: reschedulePreflight.acknowledgementSha256 } : {}) }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
      if (!response.ok) throw new Error(readableError(body, "Could not reschedule this target."));
      setMessage(`Moved to ${formatInZone(scheduledFor, timezone.trim())} (${timezone.trim()}).`);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reschedule this target."); }
    finally { setBusy(""); }
  }

  async function cancelTarget() {
    if (!selected || selected.target.status !== editableStatus) return;
    if (!selected.contentVersion) { setError("Refresh this content before cancelling its schedule."); return; }
    setBusy("cancel"); setError(""); setMessage("");
    try {
      const response = await apiFetch(`/v1/content-items/${encodeURIComponent(selected.contentId)}/targets/${encodeURIComponent(selected.target.id)}/cancel?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "if-match": String(selected.contentVersion) },
      }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
      if (!response.ok) throw new Error(readableError(body, "Could not cancel this target."));
      setConfirmCancel(false);
      setMessage("Scheduled target cancelled. The draft and approval history are unchanged.");
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel this target."); }
    finally { setBusy(""); }
  }

  async function exportCsv() {
    if (dataMode !== "api") return;
    setBusy("export"); setError("");
    try {
      const params = new URLSearchParams({ workspaceId, brandId, month: viewMonth, timeZone: calendarZone });
      if (platformFilter !== "all") params.set("platform", platformFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const response = await apiFetch(`/v1/content-items/schedule/export.csv?${params.toString()}`, {}, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
        throw new Error(readableError(body, "Could not export this calendar."));
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `originpost-calendar-${viewMonth}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      const filters = [platformFilter === "all" ? "all platforms" : platformLabel(platformFilter), statusFilter === "all" ? "all statuses" : label(statusFilter)].join(" · ");
      setMessage(`CSV download started for ${brandName} · ${monthTitle(viewMonth)} · ${filters}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export this calendar."); }
    finally { setBusy(""); }
  }

  function changeTimezone(value: string) {
    const previous = timezone;
    setTimezone(value);
    if (selected && isValidTimeZone(value) && isValidTimeZone(previous)) {
      setScheduledLocal(toLocalInputValue(selected.target.scheduledFor, value));
    }
  }

  return <section className="calendar-page" aria-labelledby="calendar-title">
    <header className="calendar-hero">
      <div><p className="eyebrow">PUBLISHING CALENDAR</p><h1 id="calendar-title">Plan the week. See every handoff.</h1><p>Review upcoming posts, their destinations, and the local time each one is scheduled to publish.</p></div>
      <div className="calendar-summary" aria-label="Calendar summary"><span><strong>{queuedCount}</strong><small>Queued</small></span><span className={actionCount ? "attention" : ""}><strong>{actionCount}</strong><small>Need action</small></span></div>
    </header>

    {dataMode === "demo" ? <div className="calendar-banner warning" role="status"><AlertTriangle size={16} /><span><strong>Demo calendar</strong><small>Connect the API before rescheduling or cancelling.</small></span></div> : null}
    {error ? <div className="calendar-banner error" role="alert"><AlertTriangle size={16} /><span><strong>Calendar action failed</strong><small>{error}</small></span></div> : null}
    {message ? <div className="calendar-banner success" role="status"><CircleCheck size={16} /><span><strong>{message.startsWith("CSV ") ? "Calendar exported" : "Schedule updated"}</strong><small>{message}</small></span></div> : null}

    <div className="calendar-toolbar panel">
      {view !== "grid" ? <div className="calendar-period-controls">
        <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))} aria-label="Previous month"><ChevronLeft size={17} /></button>
        <button type="button" className="calendar-today" onClick={() => setViewMonth(monthKeyInZone(new Date(), calendarZone))}>Today</button>
        <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, 1))} aria-label="Next month"><ChevronRight size={17} /></button>
        <h2 aria-live="polite">{monthTitle(viewMonth)}</h2>
      </div> : <div className="calendar-period-controls"><h2>Instagram grid</h2></div>}
      <div className="calendar-filters">
        {view !== "grid" ? <><label>Platform<select value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value)}><option value="all">All platforms</option>{platforms.map((platform) => <option value={platform} key={platform}>{platformLabel(platform)}</option>)}</select></label>
        <label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{statuses.map((status) => <option value={status} key={status}>{label(status)}</option>)}</select></label></> : null}
        {view !== "grid" ? <div className="calendar-export-control"><button type="button" className="calendar-export" onClick={() => void exportCsv()} disabled={dataMode !== "api" || busy !== ""} aria-label={`Export the current saved schedule for ${brandName}, ${monthTitle(viewMonth)}, using ${calendarZone} and the selected filters`}><Download size={15} />{busy === "export" ? "Exporting…" : "Export CSV"}</button><small>{brandName} · {monthTitle(viewMonth)}</small></div> : null}
        <div className="calendar-view-toggle" role="group" aria-label="Calendar view">
          <button type="button" className={view === "month" ? "active" : ""} aria-pressed={view === "month"} onClick={() => setView("month")}><LayoutGrid size={15} /> Month</button>
          <button type="button" className={view === "list" ? "active" : ""} aria-pressed={view === "list"} onClick={() => setView("list")}><List size={15} /> List</button>
          <button type="button" className={view === "grid" ? "active" : ""} aria-pressed={view === "grid"} onClick={() => setView("grid")}><Grid3X3 size={15} /> Instagram grid</button>
        </div>
      </div>
    </div>

    {view === "grid" ? <div className="calendar-main panel"><InstagramGridPlanner auth={auth} workspaceId={workspaceId} brandId={brandId} dataMode={dataMode} /></div> : loading && dataMode === "loading" ? <div className="calendar-state panel" role="status"><RefreshCw className="calendar-spin" size={25} /><strong>Loading publishing schedule…</strong><p>Checking current targets and their latest workflow state.</p></div> : entries.length === 0 ? <div className="calendar-state panel"><CalendarX2 size={27} /><strong>No publishing targets yet</strong><p>Approve a draft in Content Studio, then schedule Instagram, a Facebook Page, or YouTube. It will appear here.</p></div> : <div className={`calendar-workspace ${selected ? "with-detail" : ""}`}>
      <div className="calendar-main panel">
        {visibleMonthEntries.length === 0 ? <div className="calendar-state inline"><CalendarX2 size={24} /><strong>No matches</strong><p>Change the month, platform, or status filter to see other scheduled work.</p></div> : view === "month" ? <><div className="calendar-month" aria-label={`${monthTitle(viewMonth)} publishing calendar, viewed in ${calendarZone}`}>
          {weekDays.map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}
          {cells.map((cell) => {
            const dayEntries = cell.inMonth ? entriesByDate.get(cell.key) ?? [] : [];
            return <div className={`calendar-day ${cell.key === todayKey ? "today" : ""} ${cell.inMonth ? "" : "outside"}`} key={cell.key} aria-label={cell.inMonth ? `${cell.day}, ${dayEntries.length} scheduled target${dayEntries.length === 1 ? "" : "s"}` : undefined}>
              {cell.inMonth ? <><span className="calendar-day-number">{cell.day}</span><div className="calendar-day-targets">{dayEntries.slice(0, 3).map((entry) => <TargetButton entry={entry} calendarZone={calendarZone} selected={selectedKey === entry.key} onSelect={() => setSelectedKey(entry.key)} compact key={entry.key} />)}{dayEntries.length > 3 ? <small className="calendar-more">+{dayEntries.length - 3} more</small> : null}</div></> : null}
            </div>;
          })}
        </div>{monthEntryCount === 0 ? <div className="calendar-month-empty" role="status"><CalendarX2 size={16} /><span>No matching targets in {monthTitle(viewMonth)}.</span></div> : null}</> : <div className="calendar-list">
          {listGroups.map(([dateKey, group]) => <section className="calendar-list-group" key={dateKey} aria-labelledby={`calendar-date-${dateKey}`}><header><span>{dateKey === todayKey ? "Today" : new Intl.DateTimeFormat("en", { timeZone: calendarZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(group[0]!.target.scheduledFor))}</span><small>{group.length} target{group.length === 1 ? "" : "s"}</small></header>{group.map((entry) => <TargetButton entry={entry} calendarZone={calendarZone} selected={selectedKey === entry.key} onSelect={() => setSelectedKey(entry.key)} key={entry.key} />)}</section>)}
        </div>}
        <footer className="calendar-zone-note"><Clock3 size={14} /><span>Calendar grouping uses <strong>{calendarZone}</strong>. Open a target to see its saved zone and UTC instant.</span></footer>
      </div>

      {selected ? <aside className="calendar-detail panel" aria-labelledby="calendar-detail-title">
        <header><span className={`calendar-platform large ${selected.target.platform}`}>{platformMark(selected.target.platform)}</span><div><p className="eyebrow">SELECTED TARGET</p><h2 ref={detailTitleRef} tabIndex={-1} id="calendar-detail-title">{selected.contentTitle}</h2></div><em className={`calendar-status ${selected.target.status}`}>{label(selected.target.status)}</em></header>
        <p className="calendar-detail-summary">{selected.contentSummary || "No summary was added to this content item."}</p>
        <dl className="calendar-facts">
          <div><dt>Saved local time</dt><dd>{formatInZone(selected.target.scheduledFor, selected.target.timezone && isValidTimeZone(selected.target.timezone) ? selected.target.timezone : calendarZone)}</dd><small>{selected.target.timezone && isValidTimeZone(selected.target.timezone) ? selected.target.timezone : `${calendarZone} · fallback`}</small></div>
          <div><dt>UTC</dt><dd>{formatUtc(selected.target.scheduledFor)}</dd><small>{new Date(selected.target.scheduledFor).toISOString()}</small></div>
          <div><dt>{selected.target.platform === "facebook" ? "Page" : "Account"}</dt><dd>{selected.target.accountId}</dd><small>{platformLabel(selected.target.platform)} · {label(selected.target.deliveryMode ?? "auto_publish")}</small></div>
          {selected.target.queueAssignment ? <div><dt>Queue assignment</dt><dd>{selected.target.queueAssignment.localDate} · {selected.target.queueAssignment.localTime}</dd><small>Profile v{selected.target.queueAssignment.profileVersion} · UTC{selected.target.queueAssignment.utcOffset}</small></div> : null}
        </dl>

        {selected.target.status === editableStatus ? <form className="calendar-reschedule" onSubmit={reschedule}>
          <div className="calendar-section-title"><CalendarClock size={17} /><div><strong>Reschedule target</strong><small>Enter the intended wall-clock time and its IANA zone.</small></div></div>
          <label>Local publish time<input type="datetime-local" required value={scheduledLocal} onChange={(event) => setScheduledLocal(event.target.value)} disabled={busy !== "" || dataMode !== "api" || !canManageSchedule} /></label>
          <label>Time zone<input list="originpost-timezones" required value={timezone} onChange={(event) => changeTimezone(event.target.value)} aria-describedby="calendar-timezone-help" disabled={busy !== "" || dataMode !== "api" || !canManageSchedule} /></label>
          <datalist id="originpost-timezones">{shownTimeZones.map((zone) => <option value={zone} key={zone} />)}</datalist>
          <p id="calendar-timezone-help">{canManageSchedule ? "Use an IANA name such as Asia/Kolkata. OriginPost will store the matching UTC instant." : "Your workspace role can view schedules but cannot change them."}</p>
          {reschedulePreflightBusy ? <div className="calendar-conflict-note" role="status"><RefreshCw className="calendar-spin" size={14} />Checking duplicates and nearby posts…</div> : reschedulePreflightError ? <div className="calendar-conflict-note warning" role="alert"><AlertTriangle size={14} />{reschedulePreflightError}</div> : reschedulePreflight?.requiresConfirmation ? <div className="calendar-conflict-warning" role="alert"><strong><AlertTriangle size={14} />Review {reschedulePreflight.conflicts.length} warning{reschedulePreflight.conflicts.length === 1 ? "" : "s"}</strong>{reschedulePreflight.conflicts.map((conflict) => <span key={conflict.targetId}>{scheduleConflictHeadline(conflict)}: {conflict.contentTitle} · {conflict.minutesApart} min apart</span>)}<label><input type="checkbox" checked={acknowledgedConflictHash === reschedulePreflight.acknowledgementSha256} onChange={(event) => setAcknowledgedConflictHash(event.target.checked ? reschedulePreflight.acknowledgementSha256 : "")} /> I reviewed these exact warnings.</label></div> : reschedulePreflight ? <div className="calendar-conflict-note clear"><CircleCheck size={14} />No exact duplicate or same-account post within 60 minutes.</div> : null}
          <button className="calendar-primary" disabled={busy !== "" || dataMode !== "api" || !canManageSchedule || reschedulePreflightBusy || !scheduleConflictReady(reschedulePreflight, acknowledgedConflictHash)}>{busy === "reschedule" ? <RefreshCw className="calendar-spin" size={15} /> : <CalendarClock size={15} />}{busy === "reschedule" ? "Saving…" : "Save new time"}</button>
        </form> : <div className="calendar-locked"><Clock3 size={17} /><div><strong>This target cannot be moved</strong><p>Only queued targets can be rescheduled or cancelled. Its current state is {label(selected.target.status)}.</p></div></div>}

        {selected.target.status === editableStatus ? <div className="calendar-cancel">
          {!confirmCancel ? <button type="button" onClick={() => setConfirmCancel(true)} disabled={busy !== "" || dataMode !== "api" || !canManageSchedule}><Trash2 size={14} /> Cancel scheduled target</button> : <div className="calendar-confirm" role="alert"><strong>Cancel this target?</strong><p>The draft and approval stay in history. This target will not publish.</p><div><button type="button" onClick={() => setConfirmCancel(false)} disabled={busy !== ""}>Keep it</button><button type="button" className="danger" onClick={() => void cancelTarget()} disabled={busy !== ""}>{busy === "cancel" ? "Cancelling…" : "Yes, cancel"}</button></div></div>}
        </div> : null}
      </aside> : null}
    </div>}
  </section>;
}
