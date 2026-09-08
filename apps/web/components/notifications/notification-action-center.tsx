"use client";

import { AlertCircle, Bell, BellRing, CalendarClock, Check, CheckCheck, ChevronRight, CircleAlert, Info, RefreshCw, ShieldAlert, X } from "lucide-react";
import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";

export type WorkspaceNotification = {
  id: string;
  workspaceId: string;
  kind: string;
  severity: "info" | "warning" | "error" | "critical" | string;
  title: string;
  body: string;
  contentItemId?: string;
  targetId?: string;
  monitorId?: string;
  accountId?: string;
  actionUrl?: string;
  createdAt: string;
  readAt?: string;
  readBy?: string;
};

type NotificationActionCenterProps = {
  auth: AuthView;
  workspaceId: string;
  onNavigate: (notification: WorkspaceNotification) => void;
};

function responseError(body: { message?: string | string[] } | undefined, fallback: string) {
  return Array.isArray(body?.message) ? body.message.join(" ") : body?.message ?? fallback;
}

function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function exactTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function kindLabel(kind: string) {
  return kind.replaceAll("_", " ").replaceAll(".", " · ");
}

function actionLabel(notification: WorkspaceNotification) {
  if (notification.contentItemId) return "Open content";
  if (notification.monitorId) return "Open Automations";
  if (notification.accountId) return "Open Channels";
  if (notification.actionUrl) return "Open action";
  return "View workspace";
}

function SeverityIcon({ severity }: { severity: WorkspaceNotification["severity"] }) {
  if (severity === "critical") return <ShieldAlert size={17} />;
  if (severity === "error") return <AlertCircle size={17} />;
  if (severity === "warning") return <CircleAlert size={17} />;
  return <Info size={17} />;
}

export function NotificationActionCenter({ auth, workspaceId, onNavigate }: NotificationActionCenterProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [notifications, setNotifications] = useState<WorkspaceNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const loadSummary = useCallback(async () => {
    try {
      const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications/summary`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) return;
      const body = await response.json() as { unread: number };
      setUnread(Math.max(0, body.unread));
    } catch { /* The panel will expose a detailed error when opened. */ }
  }, [auth.csrfToken, workspaceId]);

  const loadNotifications = useCallback(async (showUnreadOnly: boolean) => {
    setLoading(true); setError("");
    try {
      const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications?unreadOnly=${showUnreadOnly ? "true" : "false"}&limit=30`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as (WorkspaceNotification[] & { message?: string | string[] }) | undefined;
      if (!response.ok || !Array.isArray(body)) throw new Error(responseError(body, "Could not load notifications."));
      setNotifications(body);
      await loadSummary();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load notifications.");
    } finally { setLoading(false); }
  }, [auth.csrfToken, loadSummary, workspaceId]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { if (open) void loadNotifications(filter === "unread"); }, [filter, loadNotifications, open]);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function closePanel() {
    setOpen(false);
    window.requestAnimationFrame(() => bellRef.current?.focus());
  }

  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") { event.preventDefault(); closePanel(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function markRead(notification: WorkspaceNotification) {
    if (notification.readAt) return true;
    setBusyId(notification.id); setError("");
    try {
      const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
      if (!response.ok) throw new Error(responseError(body, "Could not mark this notification as read."));
      const readAt = new Date().toISOString();
      setNotifications((current) => filter === "unread" ? current.filter((entry) => entry.id !== notification.id) : current.map((entry) => entry.id === notification.id ? { ...entry, readAt } : entry));
      setUnread((current) => Math.max(0, current - 1));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark this notification as read.");
      return false;
    } finally { setBusyId(""); }
  }

  async function markAllRead() {
    if (!unread) return;
    setBusyId("all"); setError("");
    try {
      const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications/read-all`, { method: "POST" }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
      if (!response.ok) throw new Error(responseError(body, "Could not mark all notifications as read."));
      const readAt = new Date().toISOString();
      setNotifications((current) => filter === "unread" ? [] : current.map((entry) => entry.readAt ? entry : { ...entry, readAt }));
      setUnread(0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not mark all notifications as read."); }
    finally { setBusyId(""); }
  }

  async function openAction(notification: WorkspaceNotification) {
    await markRead(notification);
    closePanel();
    onNavigate(notification);
  }

  const unreadLabel = unread === 1 ? "1 unread notification" : `${unread} unread notifications`;

  return <div className="notification-action-center">
    <button ref={bellRef} className="icon-button notification-bell" aria-label={unread ? `Notifications, ${unreadLabel}` : "Notifications"} aria-expanded={open} aria-controls="notification-action-panel" onClick={() => setOpen((current) => !current)}>
      {unread ? <BellRing size={19} /> : <Bell size={19} />}
      {unread ? <span className="notification-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span> : null}
    </button>
    <span className="sr-only" aria-live="polite">{unreadLabel}</span>

    {open ? <>
      <button className="notification-scrim" aria-label="Close notifications" onClick={closePanel} />
      <section ref={panelRef} className="notification-panel" id="notification-action-panel" role="dialog" aria-modal="true" aria-labelledby="notification-panel-title" onKeyDown={trapFocus}>
        <header className="notification-panel-head"><div><p className="eyebrow">ACTION CENTER</p><h2 id="notification-panel-title">Notifications</h2><p>{unread ? `${unreadLabel} need attention.` : "You’re caught up."}</p></div><button className="icon-button" aria-label="Close notifications" onClick={closePanel}><X size={18} /></button></header>
        <div className="notification-toolbar"><div className="notification-filters" aria-label="Filter notifications"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button><button aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>Unread{unread ? ` ${unread}` : ""}</button></div><button className="notification-read-all" onClick={() => void markAllRead()} disabled={!unread || busyId === "all"}><CheckCheck size={14} />{busyId === "all" ? "Saving…" : "Mark all read"}</button></div>
        {error ? <div className="notification-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button onClick={() => void loadNotifications(filter === "unread")}><RefreshCw size={13} /> Retry</button></div> : null}
        <div className="notification-list" aria-busy={loading}>
          {loading ? <div className="notification-state"><RefreshCw className="notification-spinner" size={22} /><strong>Loading notifications</strong><p>Checking what needs your attention.</p></div> : error && !notifications.length ? <div className="notification-state"><AlertCircle size={24} /><strong>Notifications are unavailable</strong><p>Use Retry above to check again.</p></div> : notifications.length ? notifications.map((notification) => <article className={`notification-item severity-${notification.severity} ${notification.readAt ? "read" : "unread"}`} key={notification.id}>
            <span className="notification-severity"><SeverityIcon severity={notification.severity} /></span>
            <div className="notification-copy"><div className="notification-meta"><span>{kindLabel(notification.kind)}</span>{!notification.readAt ? <em>Unread</em> : null}</div><h3>{notification.title}</h3><p>{notification.body}</p><time dateTime={notification.createdAt} title={exactTime(notification.createdAt)}><strong>{relativeTime(notification.createdAt)}</strong><span>{exactTime(notification.createdAt)}</span></time><div className="notification-actions"><button className="notification-open" onClick={() => void openAction(notification)} disabled={busyId === notification.id}>{actionLabel(notification)} <ChevronRight size={14} /></button>{!notification.readAt ? <button onClick={() => void markRead(notification)} disabled={busyId === notification.id}><Check size={13} /> Mark read</button> : null}</div></div>
          </article>) : <div className="notification-state"><CheckCheck size={24} /><strong>{filter === "unread" ? "No unread notifications" : "No notifications yet"}</strong><p>{filter === "unread" ? "New action items will appear here." : "Publishing, channel, and monitoring updates will appear here."}</p>{filter === "unread" ? <button onClick={() => setFilter("all")}>Show all</button> : null}</div>}
        </div>
      </section>
    </> : null}
  </div>;
}
