"use client";

import { AlertTriangle, CalendarClock, Check, ChevronDown, Eye, Play, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";

export type YouTubePublishSettings = {
  title: string;
  description: string;
  privacyStatus: "private" | "unlisted" | "public";
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  notifySubscribers: boolean;
  categoryId?: string;
  defaultLanguage?: string;
  timezone?: string;
};

type YouTubeAccount = {
  id: string;
  displayName: string;
  externalAccountId: string;
  platform: "instagram" | "facebook" | "youtube";
  status: "setup_required" | "healthy" | "expiring" | "refresh_failed" | "disconnected";
};

type YouTubeSchedulePayload = {
  platform: "youtube";
  accountId: string;
  draftId: string;
  scheduledFor: string;
  deliveryMode: "auto_publish";
  settings: YouTubePublishSettings;
};

type PostingQueueProfile = { id: string; enabled: boolean; timezone: string; version: number };
type PostingQueueRow = { account: YouTubeAccount; profile: PostingQueueProfile | null };
type PostingQueueOccurrence = { scheduledFor: string; timezone: string; utcOffset: string; profileVersion: number; notes: string[] };

type YouTubePublishReviewProps = {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  contentItemId: string;
  contentVersion?: number | undefined;
  draft: { id: string; title?: string; caption: string };
  fallbackTitle: string;
  onScheduled: () => void | Promise<void>;
};

function defaultScheduleTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function statusCopy(status: YouTubeAccount["status"]) {
  if (status === "healthy") return "Ready";
  if (status === "expiring") return "Access expiring";
  if (status === "setup_required") return "Setup needed";
  if (status === "refresh_failed") return "Reconnect needed";
  return "Disconnected";
}

export function YouTubePublishReview({ auth, workspaceId, brandId, contentItemId, contentVersion, draft, fallbackTitle, onScheduled }: YouTubePublishReviewProps) {
  const [accounts, setAccounts] = useState<YouTubeAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [scheduledFor, setScheduledFor] = useState(defaultScheduleTime);
  const [settings, setSettings] = useState<YouTubePublishSettings>({
    title: draft.title?.trim() || fallbackTitle,
    description: draft.caption,
    privacyStatus: "private",
    madeForKids: false,
    containsSyntheticMedia: false,
    notifySubscribers: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [madeForKidsChoice, setMadeForKidsChoice] = useState<boolean | null>(null);
  const [syntheticMediaChoice, setSyntheticMediaChoice] = useState<boolean | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [postingQueues, setPostingQueues] = useState<PostingQueueRow[]>([]);
  const [queuePreview, setQueuePreview] = useState<PostingQueueOccurrence | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const queueCommandKey = useRef("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingAccounts(true);
      try {
        const [accountsResponse, queuesResponse] = await Promise.all([
          apiFetch(`/v1/channels/accounts?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
          apiFetch(`/v1/posting-queue-profiles?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        ]);
        if (!accountsResponse.ok) throw new Error("Could not load YouTube channels.");
        const result = (await accountsResponse.json() as YouTubeAccount[]).filter((account) => account.platform === "youtube" && account.status !== "disconnected");
        const queueRows = queuesResponse.ok ? (await queuesResponse.json() as PostingQueueRow[]).filter((row) => row.account.platform === "youtube") : [];
        if (!cancelled) {
          setAccounts(result);
          setPostingQueues(queueRows);
          setAccountId((current) => current || result.find((account) => account.status === "healthy")?.id || result[0]?.id || "");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load YouTube channels.");
      } finally {
        if (!cancelled) setLoadingAccounts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, brandId, workspaceId]);

  const selectedAccount = accounts.find((account) => account.id === accountId);
  const selectedQueue = postingQueues.find((row) => row.account.id === accountId)?.profile ?? null;
  useEffect(() => {
    let cancelled = false;
    setQueuePreview(null);
    queueCommandKey.current = "";
    if (!selectedQueue?.enabled || !accountId) return;
    void (async () => {
      const response = await apiFetch(`/v1/posting-queue-profiles/${encodeURIComponent(accountId)}/preview?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&count=1`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { occurrences?: PostingQueueOccurrence[] };
      if (!cancelled && response.ok) setQueuePreview(body.occurrences?.[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [accountId, auth.csrfToken, brandId, selectedQueue?.id, selectedQueue?.version, workspaceId]);
  const descriptionBytes = useMemo(() => new TextEncoder().encode(settings.description).length, [settings.description]);
  const titleError = !settings.title.trim() ? "Enter a video title." : settings.title.length > 100 ? "Keep the title under 100 characters." : /[<>]/.test(settings.title) ? "Remove angle brackets from the title." : "";
  const descriptionError = descriptionBytes > 5000 ? "Keep the description under 5,000 UTF-8 bytes." : /[<>]/.test(settings.description) ? "Remove angle brackets from the description." : "";
  const accountError = loadingAccounts ? "" : accounts.length === 0 ? "Connect a ready YouTube channel before scheduling." : !selectedAccount ? "Choose a YouTube channel." : !["healthy", "expiring"].includes(selectedAccount.status) ? "Choose a channel that is ready to publish." : "";
  const titleInvalid = Boolean(titleError);
  const descriptionInvalid = Boolean(descriptionError);
  const accountBlocked = loadingAccounts || Boolean(accountError);
  const declarationsMissing = madeForKidsChoice === null || syntheticMediaChoice === null;

  function update<K extends keyof YouTubePublishSettings>(key: K, value: YouTubePublishSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function approvedSettings(): YouTubePublishSettings | null {
    if (madeForKidsChoice === null || syntheticMediaChoice === null) return null;
    return { ...settings, title: settings.title.trim(), description: settings.description.trim(), madeForKids: madeForKidsChoice, containsSyntheticMedia: syntheticMediaChoice };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (titleInvalid) { setError("Use a title under 100 characters without angle brackets."); return; }
    if (descriptionInvalid) { setError("Use a description under 5,000 UTF-8 bytes without angle brackets."); return; }
    if (accountBlocked) { setError("Choose a YouTube channel that is ready to publish."); return; }
    if (declarationsMissing) { setError("Choose the audience and altered-media answers before scheduling."); return; }
    if (!scheduledFor) { setError("Choose a publish date and time."); return; }

    const scheduleDate = new Date(scheduledFor);
    if (Number.isNaN(scheduleDate.getTime()) || scheduleDate.getTime() <= Date.now()) {
      setError("Choose a publish time in the future.");
      return;
    }

    const reviewedSettings = approvedSettings();
    if (!reviewedSettings) { setError("Choose the audience and altered-media answers before scheduling."); return; }
    const payload: YouTubeSchedulePayload = {
      platform: "youtube",
      accountId,
      draftId: draft.id,
      scheduledFor: scheduleDate.toISOString(),
      deliveryMode: "auto_publish",
      settings: reviewedSettings,
    };

    setSaving(true);
    try {
      const response = await apiFetch(`/v1/content-items/${encodeURIComponent(contentItemId)}/schedule?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(contentVersion ? { "if-match": String(contentVersion) } : {}),
        },
        body: JSON.stringify(payload),
      }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not schedule this YouTube video.");
      }
      await onScheduled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not schedule this YouTube video.");
    } finally {
      setSaving(false);
    }
  }

  async function scheduleNextAvailable() {
    setError("");
    const reviewedSettings = approvedSettings();
    if (titleInvalid || descriptionInvalid) { setError("Use the exact approved YouTube title and description within the limits."); return; }
    if (accountBlocked || !selectedAccount) { setError("Choose a YouTube channel that is ready to publish."); return; }
    if (!reviewedSettings) { setError("Choose the audience and altered-media answers before queue scheduling."); return; }
    if (!selectedQueue?.enabled || !queuePreview) { setError("Set up an enabled posting queue for this YouTube channel in Channels."); return; }
    if (!contentVersion) { setError("Refresh this Content Item before queue scheduling."); return; }
    if (!queueCommandKey.current) queueCommandKey.current = `queue-youtube-${crypto.randomUUID()}`;
    setSaving(true);
    try {
      const response = await apiFetch(`/v1/content-items/${encodeURIComponent(contentItemId)}/schedule-next`, {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": String(contentVersion), "idempotency-key": queueCommandKey.current },
        body: JSON.stringify({ workspaceId, brandId, draftId: draft.id, connectedAccountId: selectedAccount.id, deliveryMode: "auto_publish", expectedProfileVersion: selectedQueue.version, settings: reviewedSettings }),
      }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not reserve the next YouTube slot.");
      }
      queueCommandKey.current = "";
      await onScheduled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reserve the next YouTube slot.");
    } finally {
      setSaving(false);
    }
  }

  return <form className="youtube-review" onSubmit={submit}>
    <div className="youtube-review-head">
      <span><Play size={21} fill="currentColor" /></span>
      <div><p className="eyebrow">YOUTUBE FINAL REVIEW</p><h3>Ready the video for publishing</h3><p>Check exactly what viewers and YouTube will receive.</p></div>
      <em>Approved draft</em>
    </div>

    <div className="youtube-review-layout">
      <div className="youtube-review-fields">
        <label>Video title <span>{settings.title.length}/100</span><input value={settings.title} maxLength={100} required onChange={(event) => update("title", event.target.value)} aria-invalid={titleInvalid} aria-describedby={titleError ? "youtube-title-error" : undefined} />{titleError ? <small className="youtube-field-error" id="youtube-title-error">{titleError}</small> : null}</label>
        <label>Description <span>{descriptionBytes.toLocaleString()}/5,000 bytes</span><textarea rows={6} value={settings.description} onChange={(event) => update("description", event.target.value)} aria-invalid={descriptionInvalid} aria-describedby={descriptionError ? "youtube-description-error" : undefined} />{descriptionError ? <small className="youtube-field-error" id="youtube-description-error">{descriptionError}</small> : null}</label>

        <div className="youtube-field-grid">
          <label>Channel <span>{loadingAccounts ? "Loading…" : `${accounts.length} available`}</span><div className="select-wrap"><select value={accountId} required aria-invalid={accountBlocked} aria-describedby={accountError ? "youtube-channel-error" : undefined} onChange={(event) => setAccountId(event.target.value)} disabled={loadingAccounts || accounts.length === 0}><option value="">Choose a channel</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.displayName} — {statusCopy(account.status)}</option>)}</select><ChevronDown size={15} /></div>{accountError ? <small className="youtube-field-error" id="youtube-channel-error">{accountError}</small> : null}</label>
          <label>Publish time <span>{settings.timezone}</span><input type="datetime-local" value={scheduledFor} min={defaultScheduleTime()} required onChange={(event) => setScheduledFor(event.target.value)} /></label>
          <label>Visibility <span>Starts private</span><div className="select-wrap"><select value={settings.privacyStatus} onChange={(event) => update("privacyStatus", event.target.value as YouTubePublishSettings["privacyStatus"])}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select><ChevronDown size={15} /></div></label>
          <fieldset aria-required="true" aria-describedby="youtube-audience-required"><legend>Audience</legend><span id="youtube-audience-required">Choose one · required</span><label className="choice-row"><input type="radio" name="madeForKids" required checked={madeForKidsChoice === false} onChange={() => setMadeForKidsChoice(false)} /> No, it’s not made for kids</label><label className="choice-row"><input type="radio" name="madeForKids" checked={madeForKidsChoice === true} onChange={() => setMadeForKidsChoice(true)} /> Yes, it’s made for kids</label></fieldset>
        </div>

        <div className="youtube-disclosures">
          <fieldset className="youtube-required-choice" aria-required="true" aria-describedby="youtube-synthetic-required"><legend>Realistic altered or synthetic media</legend><span id="youtube-synthetic-required">Choose one · required</span><label className="choice-row"><input type="radio" name="syntheticMedia" required checked={syntheticMediaChoice === false} onChange={() => setSyntheticMediaChoice(false)} /> No</label><label className="choice-row"><input type="radio" name="syntheticMedia" checked={syntheticMediaChoice === true} onChange={() => setSyntheticMediaChoice(true)} /> Yes, add the disclosure</label></fieldset>
          <label className="toggle-row"><input type="checkbox" checked={settings.notifySubscribers} onChange={(event) => update("notifySubscribers", event.target.checked)} /><span><strong>Notify subscribers</strong><small>Off by default to avoid an accidental channel-wide alert.</small></span></label>
        </div>
      </div>

      <aside className="youtube-review-summary">
        <div><Eye size={17} /><span><small>Visibility</small><strong>{settings.privacyStatus}</strong></span></div>
        <div><ShieldCheck size={17} /><span><small>Audience</small><strong>{madeForKidsChoice === null ? "Not chosen" : madeForKidsChoice ? "Made for kids" : "Not made for kids"}</strong></span></div>
        <div><AlertTriangle size={17} /><span><small>Synthetic media</small><strong>{syntheticMediaChoice === null ? "Not chosen" : syntheticMediaChoice ? "Disclosure on" : "No disclosure"}</strong></span></div>
        <div><CalendarClock size={17} /><span><small>Channel</small><strong>{selectedAccount?.displayName ?? "Not selected"}</strong></span></div>
        {queuePreview && selectedQueue?.enabled ? <div><CalendarClock size={17} /><span><small>Next account slot</small><strong>{new Date(queuePreview.scheduledFor).toLocaleString([], { timeZone: queuePreview.timezone, dateStyle: "medium", timeStyle: "short" })}</strong><small>{queuePreview.timezone} · UTC{queuePreview.utcOffset} · profile v{queuePreview.profileVersion}</small></span></div> : null}
        <p>Check the title, description, audience, and disclosure against the approved draft before scheduling.</p>
      </aside>
    </div>

    {error ? <div className="youtube-review-error" role="alert"><AlertTriangle size={16} /> {error}</div> : null}
    <div className="youtube-certification">By clicking “Schedule on YouTube,” you certify that this content follows the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms of Service</a>, including the Community Guidelines. Do not violate anyone’s copyright or privacy rights.</div>
    <div className="youtube-review-actions"><p id="youtube-submit-help"><ShieldCheck size={15} /> Complete every required choice. OriginPost will keep the approved draft and publish settings together.</p>{selectedQueue?.enabled ? <button type="button" className="secondary-button" disabled={saving || !queuePreview} onClick={() => void scheduleNextAvailable()}><CalendarClock size={16} /> {saving ? "Reserving…" : "Add to next channel slot"}</button> : null}<button disabled={saving} aria-describedby="youtube-submit-help"><Check size={16} /> {saving ? "Scheduling…" : "Schedule on YouTube"}</button></div>
  </form>;
}
