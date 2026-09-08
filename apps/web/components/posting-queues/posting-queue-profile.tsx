"use client";

import { CalendarClock, Check, Clock3, RefreshCw } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import styles from "./posting-queue-profile.module.css";

type Account = { id: string; platform: "instagram" | "facebook" | "youtube"; displayName: string; status: string };
type Profile = { id: string; connectedAccountId: string; enabled: boolean; timezone: string; weeklySlots: Record<string, string[]>; version: number };
type QueueRow = { account: Account; profile: Profile | null };
type Occurrence = { localDate: string; localTime: string; timezone: string; scheduledFor: string; utcOffset: string; notes: string[] };
type Skipped = { localDate: string; localTime: string; reason: "occupied" | "dst_gap_skipped" };
const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const emptySlots = () => Object.fromEntries(days.map((day) => [day, []])) as unknown as Record<typeof days[number], string[]>;
const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function PostingQueueProfilePanel({ auth, workspaceId, brandId, accounts }: { auth: AuthView; workspaceId: string; brandId: string; accounts: Account[] }) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [accountId, setAccountId] = useState("");
  const [timezone, setTimezone] = useState(defaultZone);
  const [enabled, setEnabled] = useState(true);
  const [slots, setSlots] = useState<Record<string, string[]>>(emptySlots);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<Occurrence[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const role = auth.memberships.find((entry) => entry.workspaceId === workspaceId)?.role ?? (auth.mode === "single-user" ? "owner" : "viewer");
  const canManage = role === "owner" || role === "manager";

  const load = useCallback(async () => {
    const response = await apiFetch(`/v1/posting-queue-profiles?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken);
    if (!response.ok) throw new Error("Could not load account posting queues.");
    setRows(await response.json() as QueueRow[]);
  }, [auth.csrfToken, brandId, workspaceId]);

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load posting queues.")); }, [load]);
  useEffect(() => { if (!accountId && accounts.length) setAccountId(accounts[0]!.id); }, [accountId, accounts]);
  const selected = useMemo(() => rows.find((row) => row.account.id === accountId)?.profile ?? null, [accountId, rows]);
  const hasSlots = useMemo(() => Object.values(slots).some((values) => values.length > 0), [slots]);
  const hasUnsavedChanges = useMemo(() => !selected
    || selected.enabled !== enabled
    || selected.timezone !== timezone
    || days.some((day) => JSON.stringify(selected.weeklySlots[day] ?? []) !== JSON.stringify(slots[day] ?? [])), [enabled, selected, slots, timezone]);
  useEffect(() => {
    setTimezone(selected?.timezone ?? defaultZone());
    setEnabled(selected?.enabled ?? true);
    setSlots(selected?.weeklySlots ?? emptySlots());
    setVersion(selected?.version ?? 0);
    setPreview([]);
    setSkipped([]);
  }, [accountId, selected?.id, selected?.version]);

  const loadPreview = useCallback(async () => {
    if (!accountId || !enabled || canManage && !hasSlots) { setPreview([]); setSkipped([]); setPreviewVersion(0); return; }
    const response = canManage
      ? await apiFetch(`/v1/posting-queue-profiles/${encodeURIComponent(accountId)}/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, brandId, enabled, timezone, weeklySlots: slots, expectedVersion: version, count: 7 }),
        }, auth.csrfToken)
      : await apiFetch(`/v1/posting-queue-profiles/${encodeURIComponent(accountId)}/preview?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&count=7`, { cache: "no-store" }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as { profile?: { version?: number }; occurrences?: Occurrence[]; skipped?: Skipped[]; message?: string | string[] };
    if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not preview this queue.");
    setPreview(body.occurrences ?? []);
    setSkipped(body.skipped ?? []);
    setPreviewVersion(body.profile?.version ?? 0);
    setError("");
  }, [accountId, auth.csrfToken, brandId, canManage, enabled, hasSlots, slots, timezone, version, workspaceId]);

  useEffect(() => {
    if (!enabled || canManage && !hasSlots) { setPreview([]); setSkipped([]); setPreviewVersion(0); return; }
    const timer = window.setTimeout(() => {
      void loadPreview().catch((cause) => {
        setPreview([]);
        setSkipped([]);
        setError(cause instanceof Error ? cause.message : "Could not preview this queue.");
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [canManage, enabled, hasSlots, loadPreview]);

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await apiFetch(`/v1/posting-queue-profiles/${encodeURIComponent(accountId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, enabled, timezone, weeklySlots: slots, expectedVersion: version }) }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not save this posting queue.");
      setMessage("Posting queue saved. Existing scheduled posts were not moved.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this posting queue."); }
    finally { setBusy(false); }
  }

  if (!accounts.length) return null;
  return <section className={`${styles.panel} panel`} aria-labelledby="posting-queue-title">
    <header><span><CalendarClock size={20} /></span><div><p className="eyebrow">ACCOUNT POSTING QUEUE</p><h2 id="posting-queue-title">Next available times</h2><p>Each account owns its own weekly clock. Adding a post reserves one exact free time without moving existing posts.</p>{!canManage ? <small>Read-only · an owner or manager can change this account clock.</small> : null}</div></header>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {message ? <div className={styles.success} role="status"><Check size={15} />{message}</div> : null}
    <form onSubmit={save}>
      <div className={styles.topFields}>
        <label>Publishing account<select value={accountId} onChange={(event) => { setAccountId(event.target.value); setMessage(""); setError(""); }}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} · {account.platform}</option>)}</select></label>
        <label>IANA time zone<input value={timezone} maxLength={100} disabled={!canManage} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Kolkata" /></label>
        <label className={styles.enabled}><input type="checkbox" checked={enabled} disabled={!canManage} onChange={(event) => setEnabled(event.target.checked)} /> Queue enabled</label>
      </div>
      <div className={styles.week}>{days.map((day) => <label key={day}><span>{day.slice(0, 3)}</span><input aria-label={`${day} posting times`} value={(slots[day] ?? []).join(", ")} disabled={!canManage} onChange={(event) => setSlots((current) => ({ ...current, [day]: event.target.value.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean) }))} placeholder="09:00, 18:30" /></label>)}</div>
      <div className={styles.actions}><p>Use 24-hour times. Empty days are skipped. DST gaps are never shifted silently.</p><button className="new-button" disabled={!canManage || busy || !accountId}>{busy ? "Saving…" : "Save account queue"}</button></div>
    </form>
    <div className={styles.previewHead}><div><Clock3 size={16} /><strong>Read-only next 7</strong>{previewVersion ? <small>{canManage && hasUnsavedChanges ? `Unsaved changes preview · would save as profile v${previewVersion}` : `Saved profile · v${selected?.version ?? previewVersion}`}</small> : null}</div><button type="button" onClick={() => void loadPreview()} disabled={!enabled || !accountId || canManage && !hasSlots}><RefreshCw size={13} /> Refresh</button></div>
    {skipped.length ? <div className={styles.skipped} role="note"><strong>{skipped.length} earlier candidate{skipped.length === 1 ? " was" : "s were"} skipped</strong><span>{skipped.slice(0, 3).map((entry) => `${entry.localDate} ${entry.localTime} · ${entry.reason === "occupied" ? "already occupied" : "DST gap"}`).join("; ")}{skipped.length > 3 ? `; +${skipped.length - 3} more` : ""}</span></div> : null}
    {preview.length ? <ol className={styles.preview}>{preview.map((entry) => <li key={entry.scheduledFor}><strong>{new Date(entry.scheduledFor).toLocaleString([], { timeZone: entry.timezone, dateStyle: "medium", timeStyle: "short" })}</strong><span>{entry.timezone} · UTC{entry.utcOffset}</span><small>{entry.scheduledFor}{entry.notes.includes("dst_ambiguous_earlier_offset") ? " · earlier DST occurrence" : ""}</small></li>)}</ol> : <p className={styles.empty}>{enabled ? "Enter at least one valid weekly time to preview this account’s free slots before saving." : "This account queue is disabled."}</p>}
  </section>;
}
