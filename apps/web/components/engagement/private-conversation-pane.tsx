"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MessagesSquare,
  Paperclip,
  RefreshCw,
  Send,
  Share2,
  ShieldCheck,
  UserCheck,
  Volume2,
  Video,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { platformBadge, platformLabel } from "../platform-ui";
import { apiMessage, engagementCapabilities, relativePastTime, relativeTime } from "./engagement-utils";
import { EngagementTypeTabs } from "./engagement-type-tabs";
import {
  privateAttachmentLabel,
  privateAvailabilityCopy,
  privateAvailabilityFromResponse,
  privateCanCancelIntent,
  privateConnectionModeLabel,
  privateEligibilityPresentation,
  privateInboxResponse,
  privateMessageCopy,
  privateNeedsTerminalPoll,
  privateParticipantLabel,
  privatePreview,
  privateReplyEligibility,
  type PrivateAttentionFilter,
  type PrivateConversationSummary,
  type PrivateConversationView,
  type PrivateInboxAvailability,
  type PrivateMessage,
  type PrivatePlatform,
  type PrivatePlatformFilter,
  type PrivateReplyIntent,
} from "./private-conversation-utils";

const attentionFilters: Array<{ id: PrivateAttentionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "needs_reply", label: "Needs reply" },
  { id: "mine", label: "Assigned to me" },
  { id: "resolved", label: "Resolved" },
];

const platformFilters: Array<{ id: PrivatePlatformFilter; label: string }> = [
  { id: "all", label: "All platforms" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook Page" },
];

function PlatformIcon({ platform, size = 16 }: { platform: PrivatePlatform; size?: number }) {
  return platform === "facebook" ? <Share2 size={size} /> : <Camera size={size} />;
}

function AttachmentIcon({ kind }: { kind?: string | undefined }) {
  if (kind === "image") return <ImageIcon size={14} />;
  if (kind === "video") return <Video size={14} />;
  if (kind === "audio") return <Volume2 size={14} />;
  if (kind === "file") return <FileText size={14} />;
  return <Paperclip size={14} />;
}

function replyStatusLabel(status: PrivateReplyIntent["status"]): string {
  return ({
    draft: "Draft",
    pending_approval: "Needs approval",
    queued: "Queued",
    processing: "Sending",
    succeeded: "Sent",
    failed: "Failed",
    uncertain: "Check provider",
    cancelled: "Cancelled",
    expired: "Expired",
  } satisfies Record<PrivateReplyIntent["status"], string>)[status];
}

export function PrivateConversationPane({
  auth,
  workspaceId,
  brandId,
  onShowComments,
  onUnreadCountChange,
}: {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  onShowComments: () => void;
  onUnreadCountChange?: (count: number) => void;
}) {
  const membership = auth.memberships.find((entry) => entry.workspaceId === workspaceId) ?? auth.memberships[0];
  const role = membership?.role ?? "viewer";
  const capabilities = engagementCapabilities(role);
  const [filter, setFilter] = useState<PrivateAttentionFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<PrivatePlatformFilter>("all");
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [items, setItems] = useState<PrivateConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState("");
  const [view, setView] = useState<PrivateConversationView | null>(null);
  const [availability, setAvailability] = useState<PrivateInboxAvailability>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [editingIntent, setEditingIntent] = useState<PrivateReplyIntent | null>(null);
  const [reconcileIntentId, setReconcileIntentId] = useState("");
  const [reconcileNote, setReconcileNote] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query.normalize("NFC").trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;

  const loadConversations = useCallback(async ({ quiet = false, append = false, cursor }: { quiet?: boolean; append?: boolean; cursor?: string } = {}) => {
    if (!workspaceId || !brandId) return;
    if (!quiet) append ? setLoadingMore(true) : setLoading(true);
    if (!quiet) setError("");
    try {
      const params = new URLSearchParams({ workspaceId, brandId, limit: "50" });
      if (platformFilter !== "all") params.set("platform", platformFilter);
      if (filter === "resolved") params.set("state", "resolved"); else params.set("state", "open");
      if (["unread", "needs_reply", "mine"].includes(filter)) params.set("attention", filter);
      if (filter === "mine") params.set("assignedTo", auth.user.id);
      if (settledQuery) params.set("query", settledQuery);
      if (cursor) params.set("cursor", cursor);
      const response = await apiFetch(`/v1/private-conversations?${params}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const unavailable = privateAvailabilityFromResponse(response.status, body);
        setAvailability(unavailable);
        if (!quiet) setError(privateAvailabilityCopy(unavailable).detail);
        if (!append) { setItems([]); setSelectedId(""); setView(null); }
        return;
      }
      const data = privateInboxResponse(body);
      setAvailability(data.availability ?? { state: "ready" });
      setNextCursor(data.nextCursor);
      setItems((current) => append ? [...current, ...data.items.filter((item) => !current.some((existing) => existing.conversation.id === item.conversation.id))] : data.items);
      onUnreadCountChange?.(data.items.reduce((sum, item) => sum + item.unreadCount, 0));
      if (!append) setSelectedId((current) => data.items.some((item) => item.conversation.id === current) ? current : data.items[0]?.conversation.id ?? "");
    } catch {
      const unavailable = privateAvailabilityFromResponse(503, null);
      setAvailability(unavailable);
      if (!quiet) setError(privateAvailabilityCopy(unavailable).detail);
      if (!append) { setItems([]); setSelectedId(""); setView(null); }
    } finally {
      if (!quiet) append ? setLoadingMore(false) : setLoading(false);
    }
  }, [auth.csrfToken, auth.user.id, brandId, filter, onUnreadCountChange, platformFilter, settledQuery, workspaceId]);

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  const loadConversation = useCallback(async (id: string, markRead = true) => {
    if (!id) { setView(null); return; }
    setConversationLoading(true);
    setError("");
    try {
      const response = await apiFetch(`/v1/private-conversations/${encodeURIComponent(id)}?${scope}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, response.status === 404 ? "This private conversation is no longer available." : "Could not open this private conversation."));
      setView(body as PrivateConversationView);
      if (markRead) {
        const read = await apiFetch(`/v1/private-conversations/${encodeURIComponent(id)}/read?${scope}`, { method: "POST" }, auth.csrfToken);
        if (read.ok) setItems((current) => current.map((item) => item.conversation.id === id ? { ...item, unreadCount: 0 } : item));
      }
    } catch (cause) {
      setView(null);
      setError(cause instanceof Error ? cause.message : "Could not open this private conversation.");
    } finally {
      setConversationLoading(false);
    }
  }, [auth.csrfToken, scope]);

  const loadConversationRef = useRef(loadConversation);
  useEffect(() => { loadConversationRef.current = loadConversation; }, [loadConversation]);
  useEffect(() => { void loadConversation(selectedId); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (availability && availability.state !== "ready") return;
    let attempts = 0;
    let running = false;
    const timer = window.setInterval(() => {
      if (attempts >= 20) { window.clearInterval(timer); return; }
      if (document.visibilityState !== "visible" || running) return;
      attempts += 1;
      running = true;
      void loadConversations({ quiet: true }).finally(() => { running = false; });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [availability?.state, loadConversations]);

  const activeIntentId = view?.replyIntents.find((intent) => privateNeedsTerminalPoll([intent]))?.id ?? "";
  useEffect(() => {
    if (!selectedId || !activeIntentId) return;
    let attempts = 0;
    let running = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || running) return;
      if (attempts >= 15) { window.clearInterval(timer); return; }
      attempts += 1;
      running = true;
      void loadConversationRef.current(selectedId, false).finally(() => { running = false; });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeIntentId, selectedId]);

  async function refreshInbox() {
    await loadConversations();
    if (selectedId) await loadConversation(selectedId, false);
  }

  async function mutate(path: string, init: RequestInit, success: string) {
    setBusy(path); setError(""); setNotice("");
    try {
      const response = await apiFetch(path, init, auth.csrfToken);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, "The private message action could not be saved."));
      setNotice(success);
      if (selectedId) await loadConversation(selectedId, false);
      await loadConversations({ quiet: true });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The private message action could not be saved.");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function saveReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draftBody.normalize("NFC").trim();
    if (!view || !body) return;
    const target = [...view.messages].reverse().find((message) => message.direction === "incoming" && message.availability !== "deleted" && message.availability !== "removed" && message.availability !== "unsent");
    if (!target) { setError("A visible incoming message is required before preparing a reply."); return; }
    const path = editingIntent
      ? `/v1/private-conversations/reply-intents/${encodeURIComponent(editingIntent.id)}?${scope}`
      : `/v1/private-conversations/messages/${encodeURIComponent(target.id)}/reply-intents?${scope}`;
    const payload = editingIntent ? { version: editingIntent.version, body } : { body, clientRequestId: crypto.randomUUID() };
    const saved = await mutate(path, { method: editingIntent ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, editingIntent ? "Revised draft saved. It needs approval again." : "Private reply draft saved.");
    if (saved) { setDraftBody(""); setEditingIntent(null); }
  }

  async function changeIntent(intent: PrivateReplyIntent, operation: "submit" | "approve" | "cancel") {
    const eligibility = privateEligibilityPresentation(privateReplyEligibility(view), now);
    if (operation === "approve" && !eligibility.canReply) { setError(eligibility.detail); return; }
    await mutate(`/v1/private-conversations/reply-intents/${encodeURIComponent(intent.id)}/${operation}?${scope}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: intent.version }),
    }, operation === "submit" ? "Draft submitted for manager approval." : operation === "approve" ? "Reply approved and queued for one provider send." : "Reply cancelled.");
  }

  async function reconcile(intent: PrivateReplyIntent, outcome: "confirmed_sent" | "confirmed_not_sent") {
    const note = reconcileNote.normalize("NFC").trim();
    if (note.length < 10) { setError("Add a short note of at least 10 characters describing what you checked."); return; }
    if (outcome === "confirmed_sent" && !intent.providerAcceptedAt && !intent.providerEvidenceAvailable) { setError("OriginPost has no verified send evidence yet. Refresh and check the live conversation."); return; }
    const saved = await mutate(`/v1/private-conversations/reply-intents/${encodeURIComponent(intent.id)}/reconcile?${scope}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: intent.version, outcome, note }),
    }, outcome === "confirmed_sent" ? "Reply confirmed as sent." : "Reply confirmed as not sent. It can now be revised safely.");
    if (saved) { setReconcileIntentId(""); setReconcileNote(""); }
  }

  async function updateConversation(input: { state?: "open" | "resolved"; assignedTo?: string }) {
    if (!view) return;
    await mutate(`/v1/private-conversations/${encodeURIComponent(view.conversation.id)}?${scope}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: view.conversation.version, ...input }),
    }, input.state === "resolved" ? "Private conversation resolved." : input.state === "open" ? "Private conversation reopened." : input.assignedTo ? "Conversation assigned to you." : "Conversation unassigned.");
  }

  async function refreshConversation() {
    if (!view) return;
    await mutate(`/v1/private-conversations/${encodeURIComponent(view.conversation.id)}/refresh?${scope}`, { method: "POST" }, "Provider refresh queued.");
  }

  function selectConversation(id: string) {
    setSelectedId(id);
    setMobileConversationOpen(true);
    setDraftBody("");
    setEditingIntent(null);
  }

  const selectedParticipant = view?.participant ?? view?.participants?.find((participant) => participant.role !== "business");
  const eligibility = privateEligibilityPresentation(privateReplyEligibility(view), now);
  const activeIntents = view?.replyIntents.filter((intent) => !["cancelled", "succeeded", "expired"].includes(intent.status)) ?? [];
  const replyInFlight = activeIntents.some((intent) => ["queued", "processing", "uncertain"].includes(intent.status));
  const availabilityView = availability && availability.state !== "ready" ? privateAvailabilityCopy(availability) : null;

  return <section className="engagement-page private-conversation-page">
    <header className="engagement-hero private-message-hero">
      <div><p className="eyebrow">PRIVATE INBOX</p><h1>Private conversations, handled carefully</h1><p>Read Instagram and Facebook Page messages, prepare safe text replies, and keep manager approval and provider evidence visible.</p></div>
      <button className="secondary-button" onClick={() => void refreshInbox()} disabled={loading}><RefreshCw className={loading ? "engagement-spin" : ""} size={15} /> Refresh messages</button>
    </header>

    <EngagementTypeTabs value="messages" onChange={(value) => { if (value === "comments") onShowComments(); }} />

    {availabilityView ? <PrivateConversationStatusBanner state={availability!} /> : null}
    {error && !availabilityView ? <div className="engagement-banner error" role="alert"><AlertTriangle size={18} /><span><strong>Private messages could not update</strong><small>{error}</small></span></div> : null}
    {notice ? <div className="engagement-banner success" role="status"><CheckCircle2 size={18} /><span><strong>Saved</strong><small>{notice}</small></span></div> : null}

    <div className={`engagement-shell panel private-message-shell ${mobileConversationOpen ? "mobile-thread-open" : ""}`}>
      <aside className="engagement-list-pane" aria-label="Private conversations">
        <div className="engagement-list-tools">
          <label><MessageCircle size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people or accounts" aria-label="Search private conversations" maxLength={200} /></label>
          <div className="engagement-platform-filters" aria-label="Private message platform filters">{platformFilters.map((entry) => <button type="button" key={entry.id} className={platformFilter === entry.id ? "active" : ""} onClick={() => setPlatformFilter(entry.id)} aria-pressed={platformFilter === entry.id}>{entry.id === "all" ? null : <span>{platformBadge(entry.id)}</span>}{entry.label}</button>)}</div>
          <div className="engagement-filters" aria-label="Private conversation filters">{attentionFilters.map((entry) => <button type="button" key={entry.id} className={filter === entry.id ? "active" : ""} onClick={() => setFilter(entry.id)} aria-pressed={filter === entry.id}>{entry.label}</button>)}</div>
        </div>
        <div className="engagement-thread-list">
          {loading ? <div className="engagement-state"><LoaderCircle className="engagement-spin" size={24} /><strong>Loading private messages…</strong><p>Only authorized workspace members can see this inbox.</p></div> : availabilityView ? <div className="engagement-state"><LockKeyhole size={25} /><strong>{availabilityView.title}</strong><p>{availabilityView.detail}</p></div> : items.length === 0 ? <div className="engagement-state"><MessagesSquare size={25} /><strong>{filter === "resolved" ? "No resolved messages" : "No private conversations"}</strong><p>{settledQuery ? "No conversations match these filters." : "New authorized Instagram and Facebook Page messages will appear here."}</p></div> : items.map((item) => {
            const participantRecord = item.participant ?? item.participants?.find((entry) => entry.role !== "business");
            const participant = privateParticipantLabel(participantRecord);
            const itemEligibility = privateEligibilityPresentation(privateReplyEligibility(item), now);
            return <button type="button" className={`engagement-thread-row private-message-row platform-${item.conversation.platform} ${selectedId === item.conversation.id ? "active" : ""}`} key={item.conversation.id} onClick={() => selectConversation(item.conversation.id)}>
              <span className="engagement-avatar"><PlatformIcon platform={item.conversation.platform} size={16} /><LockKeyhole className="private-lock-mark" size={9} /></span>
              <span className="engagement-thread-copy"><span><strong>{participant}</strong><time>{relativeTime(item.conversation.lastActivityAt)}</time></span><b>{privatePreview(item.latestMessage)}</b><small><b>{platformBadge(item.conversation.platform)}</b> {item.conversation.accountName ?? `Account ${item.conversation.accountId.slice(0, 8)}`} · {privateConnectionModeLabel(item.conversation.connectionMode)} {item.needsReply ? <em>Needs reply</em> : <em className={`eligibility-${itemEligibility.tone}`}>{itemEligibility.label}</em>}</small></span>
              {item.unreadCount ? <i aria-label={`${item.unreadCount} unread private message${item.unreadCount === 1 ? "" : "s"}`}>{item.unreadCount}</i> : <Check size={14} />}
            </button>;
          })}
          {nextCursor && !loading ? <button type="button" className="private-load-more" disabled={loadingMore} onClick={() => void loadConversations({ append: true, cursor: nextCursor })}>{loadingMore ? <LoaderCircle className="engagement-spin" size={14} /> : null} Load more conversations</button> : null}
        </div>
      </aside>

      <main className="engagement-conversation">
        {!selectedId ? <div className="engagement-state large"><LockKeyhole size={30} /><strong>Choose a private conversation</strong><p>Private content stays out of URLs, browser notifications, and public post context.</p></div> : conversationLoading && !view ? <div className="engagement-state large"><LoaderCircle className="engagement-spin" size={27} /><strong>Opening private conversation…</strong></div> : view ? <>
          <header className="engagement-conversation-head">
            <button type="button" className="engagement-mobile-back" onClick={() => setMobileConversationOpen(false)} aria-label="Back to private conversations"><ArrowLeft size={18} /></button>
            <span className={`engagement-proof-icon platform-${view.conversation.platform}`}><PlatformIcon platform={view.conversation.platform} size={19} /></span>
            <div><p>{privateParticipantLabel(selectedParticipant)}</p><span><b>{platformBadge(view.conversation.platform)}</b> {platformLabel(view.conversation.platform)} · <LockKeyhole size={11} /> {view.conversation.accountName ?? `Account ${view.conversation.accountId.slice(0, 8)}`} · {view.conversation.state}</span></div>
            <div className="engagement-head-actions"><button type="button" onClick={() => void refreshConversation()} disabled={Boolean(busy)} title="Check provider for new private messages" aria-label="Refresh private conversation"><RefreshCw className={busy.includes("refresh") ? "engagement-spin" : ""} size={14} /></button></div>
          </header>

          <section className={`private-eligibility ${eligibility.tone}`} aria-label="Reply eligibility"><span>{eligibility.canReply ? <Clock3 size={15} /> : <ShieldCheck size={15} />}</span><p><strong>{eligibility.label}</strong><small>{eligibility.detail}</small></p></section>

          <section className="engagement-proof-context private-conversation-context" aria-label="Private conversation context">
            <div><small>Participant</small><strong>{privateParticipantLabel(selectedParticipant)}</strong></div>
            <div><small>Connected account</small><strong>{view.conversation.accountName ?? view.conversation.accountId}</strong><span>{privateConnectionModeLabel(view.conversation.connectionMode)}</span></div>
            <div><small>Source freshness</small><strong>{view.conversation.lastSyncedAt ? relativePastTime(view.conversation.lastSyncedAt) : "Waiting for first sync"}</strong></div>
            {capabilities.canManageThread ? <div className="engagement-thread-controls"><button type="button" onClick={() => void updateConversation({ assignedTo: view.conversation.assignedTo === auth.user.id ? "" : auth.user.id })} disabled={Boolean(busy)}><UserCheck size={13} /> {view.conversation.assignedTo === auth.user.id ? "Unassign" : "Assign to me"}</button><button type="button" onClick={() => void updateConversation({ state: view.conversation.state === "open" ? "resolved" : "open" })} disabled={Boolean(busy)}>{view.conversation.state === "open" ? <><Check size={13} /> Resolve</> : <><RefreshCw size={13} /> Reopen</>}</button></div> : null}
          </section>

          <div className="engagement-timeline private-message-timeline" aria-live="polite">
            {view.messages.length === 0 ? <div className="engagement-state"><MessagesSquare size={22} /><strong>No saved messages</strong><p>Refresh the conversation to check the provider.</p></div> : view.messages.map((entry) => <PrivateMessageBubble key={entry.id} message={entry} platform={view.conversation.platform} participant={selectedParticipant} />)}

            {view.replyIntents.map((intent) => <article className={`engagement-action status-${intent.status}`} key={intent.id}>
              <span>{intent.status === "uncertain" || intent.status === "failed" || intent.status === "expired" ? <AlertTriangle size={16} /> : intent.status === "succeeded" ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}</span>
              <div><header><strong>Private reply draft</strong><em>{replyStatusLabel(intent.status)}</em></header><p>{intent.body}</p>{intent.errorSummary ? <small>{intent.errorSummary}</small> : <small>Updated {relativePastTime(intent.updatedAt)} · exact text is versioned</small>}</div>
              <div className="engagement-action-buttons">
                {intent.status === "draft" && intent.requestedBy === auth.user.id ? <button type="button" className="approve" onClick={() => void changeIntent(intent, "submit")} disabled={Boolean(busy)}><Send size={13} /> Submit</button> : null}
                {intent.status === "pending_approval" && capabilities.canSend ? <button type="button" className={eligibility.canReply ? "approve" : "send-blocked"} onClick={() => void changeIntent(intent, "approve")} disabled={Boolean(busy) || !eligibility.canReply}><Send size={13} /> {eligibility.canReply ? "Approve & send" : "Sending unavailable"}</button> : null}
                {(intent.status === "draft" || intent.status === "failed") && capabilities.canDraft ? <button type="button" onClick={() => { setDraftBody(intent.body); setEditingIntent(intent); }} disabled={Boolean(busy)}>Revise</button> : null}
                {intent.status === "uncertain" && capabilities.canSend ? <button type="button" className="approve" onClick={() => setReconcileIntentId((current) => current === intent.id ? "" : intent.id)} disabled={Boolean(busy)}><ShieldCheck size={13} /> Reconcile</button> : null}
                {privateCanCancelIntent(role, auth.user.id, intent) ? <button type="button" onClick={() => void changeIntent(intent, "cancel")} disabled={Boolean(busy)}><X size={13} /> Cancel</button> : null}
              </div>
              {reconcileIntentId === intent.id ? <PrivateReconciliationForm note={reconcileNote} providerEvidenceAvailable={Boolean(intent.providerAcceptedAt || intent.providerEvidenceAvailable)} onNoteChange={setReconcileNote} onConfirmSent={() => void reconcile(intent, "confirmed_sent")} onConfirmNotSent={() => void reconcile(intent, "confirmed_not_sent")} busy={Boolean(busy)} /> : null}
            </article>)}
          </div>

          <footer className="engagement-composer-wrap">
            {activeIntents.some((intent) => intent.status === "uncertain") ? <div className="engagement-uncertain"><AlertTriangle size={15} /><p><strong>Do not send again yet.</strong><span>Meta may have received this message. Check the live conversation before doing anything else.</span></p></div> : null}
            {eligibility.tone !== "ready" ? <div className={eligibility.canReply ? "engagement-action-required" : "engagement-readonly"}><ShieldCheck size={15} /><p><strong>{eligibility.label}</strong><span>{eligibility.detail}</span></p></div> : null}
            {capabilities.canDraft && view.conversation.state === "open" && eligibility.canReply && !replyInFlight ? <form className="engagement-composer" onSubmit={saveReply}><label><span className="sr-only">Private {platformLabel(view.conversation.platform)} reply draft</span><textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} rows={3} maxLength={2000} placeholder="Write a clear private reply…" required /></label><div><p><ShieldCheck size={13} /> {editingIntent ? "Revision resets approval" : "Saved as a draft before manager approval"}</p><span className="private-composer-actions">{editingIntent ? <button type="button" className="secondary-button" onClick={() => { setEditingIntent(null); setDraftBody(""); }}>Discard revision</button> : null}<button className="new-button" disabled={Boolean(busy)}><LockKeyhole size={14} /> {editingIntent ? "Save revision" : "Save private draft"}</button></span></div></form> : <div className="engagement-readonly"><ShieldCheck size={16} /><p><strong>{replyInFlight ? "Another reply still needs a final result" : view.conversation.state === "resolved" ? "This conversation is resolved" : !capabilities.canDraft ? "Read-only access" : eligibility.label}</strong><span>{replyInFlight ? "Wait for a provider result or reconcile an uncertain send before preparing another reply." : view.conversation.state === "resolved" ? "Reopen it before preparing another reply." : !capabilities.canDraft ? "A creator, manager, or owner can prepare replies." : eligibility.detail}</span></p></div>}
          </footer>
        </> : <div className="engagement-state large"><AlertTriangle size={28} /><strong>Conversation unavailable</strong><p>{error || "This private conversation may have been removed or your access changed."}</p></div>}
      </main>
    </div>
  </section>;
}

export function PrivateConversationStatusBanner({ state }: { state: PrivateInboxAvailability }) {
  const copy = privateAvailabilityCopy(state);
  return <div className={`engagement-banner permission private-status-${state.state}`} role="status"><LockKeyhole size={18} /><span><strong>{copy.title}</strong><small>{copy.detail}</small></span></div>;
}

export function PrivateMessageBubble({ message, platform, participant }: { message: PrivateMessage; platform: PrivatePlatform; participant?: { displayName?: string; username?: string } | undefined }) {
  return <article className={`engagement-comment private-message ${message.direction} kind-${message.kind}`}>
    <span>{message.direction === "incoming" ? <LockKeyhole size={14} /> : <Send size={14} />}</span>
    <div><header><strong>{message.direction === "incoming" ? privateParticipantLabel(participant) : "Your account"}</strong><time>{relativeTime(message.providerCreatedAt ?? message.firstSeenAt)}</time></header><p>{privateMessageCopy(message)}</p>{message.attachments?.length ? <div className="private-attachments">{message.attachments.map((attachment, index) => <span key={attachment.id ?? `${message.id}-${index}`}><AttachmentIcon kind={attachment.kind ?? attachment.type} /><b>{privateAttachmentLabel(attachment)}</b><small>{attachment.mimeType ?? "Not downloaded"}</small></span>)}</div> : null}<small>{platformLabel(platform)} private message · {message.source ?? "saved"}</small></div>
  </article>;
}

export function PrivateReconciliationForm({ note, providerEvidenceAvailable, onNoteChange, onConfirmSent, onConfirmNotSent, busy }: { note: string; providerEvidenceAvailable: boolean; onNoteChange: (value: string) => void; onConfirmSent: () => void; onConfirmNotSent: () => void; busy: boolean }) {
  return <div className="private-reconcile-form">
    <strong>Check the live provider conversation first</strong>
    <p>{providerEvidenceAvailable ? "OriginPost has verified hidden provider evidence for this send." : "OriginPost does not have verified send evidence yet. Refresh the conversation; only ‘Confirm not sent’ is available."}</p>
    <label>Operator note <textarea value={note} onChange={(event) => onNoteChange(event.target.value)} minLength={10} maxLength={500} rows={2} placeholder="What did you check?" /></label>
    <div><button type="button" className="approve" onClick={onConfirmSent} disabled={busy || !providerEvidenceAvailable}><Check size={13} /> Confirm sent</button><button type="button" onClick={onConfirmNotSent} disabled={busy}><X size={13} /> Confirm not sent</button></div>
  </div>;
}
