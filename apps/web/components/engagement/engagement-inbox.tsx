"use client";

import {
  AlertTriangle,
  ArrowLeft,
  AtSign,
  Camera,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Reply,
  Search,
  Send,
  Share2,
  ShieldCheck,
  UserCheck,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { platformBadge, platformLabel } from "../platform-ui";
import { EngagementTypeTabs, type EngagementInboxType } from "./engagement-type-tabs";
import { PrivateConversationPane } from "./private-conversation-pane";
import {
  apiMessage,
  engagementActionRequiredMessage,
  engagementCanCancelAction,
  engagementCanSendReply,
  engagementCapabilities,
  engagementNeedsTerminalPoll,
  engagementPlatform,
  engagementPlatformMatches,
  engagementProviderObjectId,
  engagementProviderState,
  engagementReplyActionCopy,
  engagementSyncState,
  relativeTime,
  relativePastTime,
  type EngagementFilter,
  type EngagementPlatform,
  type EngagementPlatformFilter,
  type EngagementReconciliationStatus,
  type EngagementSubscriptionStatus,
} from "./engagement-utils";

type Thread = {
  id: string; workspaceId: string; brandId: string; contentItemId: string; proofId: string; accountId: string;
  platform?: EngagementPlatform; externalMediaId?: string; externalPostId?: string; externalObjectId?: string;
  replySupported?: boolean; subscriptionStatus?: EngagementSubscriptionStatus; reconciliationStatus?: EngagementReconciliationStatus;
  state: "open" | "resolved"; assignedTo?: string;
  lastActivityAt: string; lastSyncedAt?: string; resolvedAt?: string; version: number;
};
type Comment = {
  id: string; threadId: string; externalCommentId: string; parentExternalCommentId?: string; authorUsername?: string;
  body: string; direction: "incoming" | "outgoing"; visibility: "visible" | "hidden" | "deleted";
  providerCreatedAt?: string; firstSeenAt: string; source: "webhook" | "reconcile" | "action"; platform?: EngagementPlatform;
};
type Action = {
  id: string; commentId: string; body: string; status: "draft" | "pending_approval" | "queued" | "processing" | "succeeded" | "failed" | "uncertain" | "cancelled" | "action_required";
  requestedBy: string; approvedBy?: string; errorSummary?: string; createdAt: string; updatedAt: string; version: number;
  platform?: EngagementPlatform;
};
type ThreadSummary = { thread: Thread; latestComment?: Comment; unreadCount: number; needsReply: boolean };
type InboxResponse = { brandId: string; items: ThreadSummary[]; nextCursor?: string };
type ThreadView = { thread: Thread; comments: Comment[]; actions: Action[] };
type ContentContext = { title: string; proofs: Array<{ id: string; platform: string; liveUrl: string }> };

const filters: Array<{ id: EngagementFilter; label: string }> = [
  { id: "new", label: "New" },
  { id: "needs_reply", label: "Needs reply" },
  { id: "mine", label: "Assigned to me" },
  { id: "resolved", label: "Resolved" },
];

const platformFilters: Array<{ id: EngagementPlatformFilter; label: string }> = [
  { id: "all", label: "All platforms" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook Page" },
];

function actionLabel(status: Action["status"]) {
  return ({ draft: "Draft", pending_approval: "Needs approval", queued: "Queued", processing: "Sending", succeeded: "Sent", failed: "Failed", uncertain: "Check before retry", cancelled: "Cancelled", action_required: "Action required" } satisfies Record<Action["status"], string>)[status];
}

function syncCopy(thread: Thread) {
  const state = engagementSyncState(thread.lastSyncedAt);
  const label = platformLabel(engagementPlatform(thread.platform));
  if (state === "waiting") return { state, title: "Waiting for first sync", detail: "OriginPost has not saved a provider sync for this proof yet." };
  if (state === "stale") return { state, title: "Sync may be delayed", detail: `Last checked ${relativePastTime(thread.lastSyncedAt!)}. Refresh before replying.` };
  return { state, title: `${label} is synced`, detail: `Checked ${relativePastTime(thread.lastSyncedAt!)}.` };
}

function PlatformIcon({ platform, size = 16 }: { platform: EngagementPlatform; size?: number }) {
  return platform === "facebook" ? <Share2 size={size} /> : <Camera size={size} />;
}

type EngagementInboxProps = { auth: AuthView; workspaceId: string; brandId: string; onUnreadCountChange?: (count: number) => void };

export function EngagementInbox(props: EngagementInboxProps) {
  const [inboxType, setInboxType] = useState<EngagementInboxType>("comments");
  return inboxType === "messages"
    ? <PrivateConversationPane {...props} onShowComments={() => setInboxType("comments")} />
    : <PublicCommentsInbox {...props} onShowMessages={() => setInboxType("messages")} />;
}

function PublicCommentsInbox({ auth, workspaceId, brandId, onUnreadCountChange, onShowMessages }: EngagementInboxProps & { onShowMessages: () => void }) {
  const membership = auth.memberships.find((entry) => entry.workspaceId === workspaceId) ?? auth.memberships[0];
  const capabilities = engagementCapabilities(membership?.role ?? "viewer");
  const [filter, setFilter] = useState<EngagementFilter>("new");
  const [platformFilter, setPlatformFilter] = useState<EngagementPlatformFilter>("all");
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [items, setItems] = useState<ThreadSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [view, setView] = useState<ThreadView | null>(null);
  const [context, setContext] = useState<ContentContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadThreads = useCallback(async (quiet = false) => {
    if (!workspaceId || !brandId) return;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ workspaceId, brandId, limit: "100" });
      if (filter === "resolved") params.set("state", "resolved"); else params.set("state", "open");
      if (filter === "mine") params.set("assignedTo", auth.user.id);
      if (settledQuery) params.set("query", settledQuery);
      const response = await apiFetch(`/v1/engagement?${params}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, "Could not load community conversations."));
      const data = body as InboxResponse;
      const byAttention = filter === "new" ? data.items.filter((item) => item.unreadCount > 0) : filter === "needs_reply" ? data.items.filter((item) => item.needsReply) : data.items;
      const filtered = byAttention.filter((item) => engagementPlatformMatches(item.thread.platform ?? item.latestComment?.platform, platformFilter));
      setItems(filtered);
      onUnreadCountChange?.(data.items.reduce((sum, item) => sum + item.unreadCount, 0));
      const linked = new URLSearchParams(window.location.search).get("thread") ?? "";
      setSelectedId((current) => filtered.some((item) => item.thread.id === current) ? current : filtered.some((item) => item.thread.id === linked) ? linked : filtered[0]?.thread.id ?? "");
      if (linked && filtered.some((item) => item.thread.id === linked)) setMobileThreadOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load community conversations.");
    } finally { if (!quiet) setLoading(false); }
  }, [auth.csrfToken, auth.user.id, brandId, filter, onUnreadCountChange, platformFilter, settledQuery, workspaceId]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);

  const loadThread = useCallback(async (id: string, markRead = true) => {
    if (!id) { setView(null); setContext(null); return; }
    setThreadLoading(true);
    setError("");
    try {
      const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
      const response = await apiFetch(`/v1/engagement/threads/${encodeURIComponent(id)}?${scope}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, "Could not open this conversation."));
      const next = body as ThreadView;
      setView(next);
      const contentResponse = await apiFetch(`/v1/content-items/${encodeURIComponent(next.thread.contentItemId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      setContext(contentResponse.ok ? await contentResponse.json() as ContentContext : null);
      if (markRead) {
        const readResponse = await apiFetch(`/v1/engagement/threads/${encodeURIComponent(id)}/read?${scope}`, { method: "POST" }, auth.csrfToken);
        if (readResponse.ok) {
          setItems((current) => current.map((item) => item.thread.id === id ? { ...item, unreadCount: 0 } : item));
          onUnreadCountChange?.(items.filter((item) => item.thread.id !== id).reduce((sum, item) => sum + item.unreadCount, 0));
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this conversation.");
    } finally { setThreadLoading(false); }
  }, [auth.csrfToken, brandId, items, onUnreadCountChange, workspaceId]);

  const loadThreadRef = useRef(loadThread);
  useEffect(() => { loadThreadRef.current = loadThread; }, [loadThread]);

  useEffect(() => { void loadThread(selectedId); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeReplyId = view?.actions.find((action) => engagementNeedsTerminalPoll([action]))?.id ?? "";
  useEffect(() => {
    if (!selectedId || !activeReplyId) return;
    let attempts = 0;
    let running = false;
    const timer = window.setInterval(() => {
      if (running) return;
      if (attempts >= 15) {
        window.clearInterval(timer);
        return;
      }
      attempts += 1;
      running = true;
      void loadThreadRef.current(selectedId, false).finally(() => { running = false; });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeReplyId, selectedId]);

  async function refreshInbox() {
    await loadThreads();
    if (selectedId) await loadThread(selectedId, false);
  }

  function selectThread(id: string) {
    setSelectedId(id);
    setMobileThreadOpen(true);
    const url = new URL(window.location.href);
    url.pathname = "/engagement";
    url.searchParams.delete("module");
    url.searchParams.set("brand", brandId);
    url.searchParams.set("thread", id);
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }

  async function mutate(path: string, init: RequestInit, success: string, providerInput: Thread | null = view?.thread ?? null) {
    setBusy(path); setError(""); setMessage("");
    try {
      const response = await apiFetch(path, init, auth.csrfToken);
      const body = await response.json().catch(() => ({}));
      const actionRequired = providerInput ? engagementActionRequiredMessage(body, providerInput) : null;
      if (!response.ok) throw new Error(actionRequired ?? apiMessage(body, "The engagement action could not be saved."));
      if (actionRequired) {
        setError(actionRequired);
        if (selectedId) await loadThread(selectedId, false);
        await loadThreads(true);
        return false;
      }
      setMessage(success);
      if (selectedId) await loadThread(selectedId, false);
      await loadThreads(true);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engagement action could not be saved.");
      return false;
    } finally { setBusy(""); }
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form).get("body")?.toString().normalize("NFC").trim() ?? "";
    const target = [...(view?.comments ?? [])].reverse().find((comment) => comment.direction === "incoming" && comment.visibility === "visible");
    if (!target || !body) return;
    const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
    if (await mutate(`/v1/engagement/comments/${encodeURIComponent(target.id)}/reply-drafts?${scope}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) }, "Reply saved for approval.")) form.reset();
  }

  async function updateThread(input: { state?: "open" | "resolved"; assignedTo?: string }) {
    if (!view) return;
    const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
    await mutate(`/v1/engagement/threads/${encodeURIComponent(view.thread.id)}?${scope}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: view.thread.version, ...input }) }, input.state === "resolved" ? "Conversation resolved." : input.state === "open" ? "Conversation reopened." : "Conversation assigned.");
  }

  async function changeAction(action: Action, operation: "approve" | "cancel") {
    if (operation === "approve" && selectedProvider && !engagementCanSendReply(selectedProvider)) {
      setMessage("");
      setError(engagementReplyActionCopy(selectedProvider)?.detail ?? "A person must complete this reply on the platform.");
      return;
    }
    const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
    const label = platformLabel(selectedPlatform);
    await mutate(`/v1/engagement/actions/${encodeURIComponent(action.id)}/${operation}?${scope}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: action.version }) }, operation === "approve" ? `Reply approved and queued for ${label}.` : "Reply cancelled.", selectedProvider);
  }

  async function reconcileAction(action: Action, outcome: "confirmed_sent" | "confirmed_not_sent") {
    const providerReplyId = outcome === "confirmed_sent" ? window.prompt(`Paste the ${platformLabel(selectedPlatform)} reply ID after checking the live conversation.`)?.trim() : undefined;
    if (outcome === "confirmed_sent" && !providerReplyId) return;
    const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
    await mutate(`/v1/engagement/actions/${encodeURIComponent(action.id)}/reconcile?${scope}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: action.version, outcome, ...(providerReplyId ? { providerReplyId } : {}) }),
    }, outcome === "confirmed_sent" ? "Reply confirmed as sent." : "Reply confirmed as not sent; it may now be reviewed again.", selectedProvider);
  }

  async function refreshProof() {
    if (!view) return;
    const scope = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
    await mutate(`/v1/engagement/proofs/${encodeURIComponent(view.thread.proofId)}/refresh?${scope}`, { method: "POST" }, `${platformLabel(selectedPlatform)} refresh queued.`);
  }

  const selectedPlatform = engagementPlatform(view?.thread.platform ?? view?.comments[0]?.platform ?? view?.actions[0]?.platform);
  const selectedProvider = view ? { ...view.thread, platform: selectedPlatform } : null;
  const sync = selectedProvider ? syncCopy(selectedProvider) : null;
  const providerState = selectedProvider ? engagementProviderState(selectedProvider, selectedProvider.lastSyncedAt) : null;
  const replyAction = selectedProvider ? engagementReplyActionCopy(selectedProvider) : null;
  const replyCanSend = selectedProvider ? engagementCanSendReply(selectedProvider) : false;
  const liveProof = context?.proofs.find((proof) => proof.id === view?.thread.proofId);
  const pendingActions = view?.actions.filter((action) => !["cancelled", "succeeded"].includes(action.status)) ?? [];
  const replyInFlight = pendingActions.some((action) => ["queued", "processing", "uncertain"].includes(action.status));
  const permissionError = /permission|reconnect|access/i.test(error);
  const actionRequiredError = /action required|not available|send it from|complete this reply/i.test(error);

  return <section className="engagement-page">
    <header className="engagement-hero">
      <div><p className="eyebrow">COMMUNITY INBOX</p><h1>Conversations tied to proof</h1><p>Read Instagram and Facebook Page comments, keep replies reviewed by a person, and see the account and published proof behind every conversation.</p></div>
      <button className="secondary-button" onClick={() => void refreshInbox()} disabled={loading}><RefreshCw className={loading ? "engagement-spin" : ""} size={15} /> Refresh inbox</button>
    </header>

    <EngagementTypeTabs value="comments" onChange={(value) => { if (value === "messages") onShowMessages(); }} />

    {error ? <div className={`engagement-banner ${permissionError || actionRequiredError ? "permission" : "error"}`} role="alert">{permissionError ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}<span><strong>{actionRequiredError ? "Action required" : permissionError ? "Channel access needs attention" : "Engagement could not update"}</strong><small>{error}</small></span></div> : null}
    {message ? <div className="engagement-banner success" role="status"><CheckCircle2 size={18} /><span><strong>Saved</strong><small>{message}</small></span></div> : null}

    <div className={`engagement-shell panel ${mobileThreadOpen ? "mobile-thread-open" : ""}`}>
      <aside className="engagement-list-pane" aria-label="Community conversations">
        <div className="engagement-list-tools">
          <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search comments or people" aria-label="Search community conversations" /></label>
          <div className="engagement-platform-filters" aria-label="Platform filters">{platformFilters.map((entry) => <button key={entry.id} className={platformFilter === entry.id ? "active" : ""} onClick={() => setPlatformFilter(entry.id)} aria-pressed={platformFilter === entry.id}>{entry.id === "all" ? null : <span>{platformBadge(entry.id)}</span>}{entry.label}</button>)}</div>
          <div className="engagement-filters" aria-label="Conversation filters">{filters.map((entry) => <button key={entry.id} className={filter === entry.id ? "active" : ""} onClick={() => setFilter(entry.id)} aria-pressed={filter === entry.id}>{entry.label}</button>)}</div>
        </div>
        <div className="engagement-thread-list">
          {loading ? <div className="engagement-state"><LoaderCircle className="engagement-spin" size={24} /><strong>Loading conversations…</strong><p>Reading saved comments for this brand.</p></div> : items.length === 0 ? <div className="engagement-state"><MessageCircle size={25} /><strong>{filter === "resolved" ? "No resolved conversations" : "Nothing needs attention"}</strong><p>{permissionError ? "Reconnect the channel in Channels to read comments." : `New ${platformFilter === "all" ? "Instagram and Facebook Page" : platformLabel(platformFilter)} comments tied to proof will appear here.`}</p></div> : items.map((item) => {
            const itemPlatform = engagementPlatform(item.thread.platform ?? item.latestComment?.platform);
            return <button className={`engagement-thread-row platform-${itemPlatform} ${selectedId === item.thread.id ? "active" : ""}`} key={item.thread.id} onClick={() => selectThread(item.thread.id)}>
            <span className="engagement-avatar"><PlatformIcon platform={itemPlatform} size={16} /></span>
            <span className="engagement-thread-copy"><span><strong>@{item.latestComment?.authorUsername ?? `${platformLabel(itemPlatform)} user`}</strong><time>{relativeTime(item.thread.lastActivityAt)}</time></span><b>{item.latestComment?.body ?? "Published post conversation"}</b><small><b>{platformBadge(itemPlatform)}</b> {platformLabel(itemPlatform)} · Account {item.thread.accountId.slice(0, 8)} · Proof {item.thread.proofId.slice(0, 8)} {item.needsReply ? <em>Needs reply</em> : null}</small></span>
            {item.unreadCount ? <i aria-label={`${item.unreadCount} unread comment${item.unreadCount === 1 ? "" : "s"}`}>{item.unreadCount}</i> : <Check size={14} />}
          </button>;})}
        </div>
      </aside>

      <main className="engagement-conversation">
        {!selectedId ? <div className="engagement-state large"><MessageCircle size={30} /><strong>Choose a conversation</strong><p>Open a proof-linked platform thread to read comments and prepare a reply.</p></div> : threadLoading && !view ? <div className="engagement-state large"><LoaderCircle className="engagement-spin" size={27} /><strong>Opening conversation…</strong></div> : view ? <>
          <header className="engagement-conversation-head">
            <button className="engagement-mobile-back" onClick={() => setMobileThreadOpen(false)} aria-label="Back to conversations"><ArrowLeft size={18} /></button>
            <span className={`engagement-proof-icon platform-${selectedPlatform}`}><PlatformIcon platform={selectedPlatform} size={19} /></span>
            <div><p>{context?.title ?? `Published ${platformLabel(selectedPlatform)} post`}</p><span><b>{platformBadge(selectedPlatform)}</b> {platformLabel(selectedPlatform)} · <ShieldCheck size={12} /> Proof {view.thread.proofId.slice(0, 10)} · {view.thread.state}</span></div>
            <div className="engagement-head-actions">
              {liveProof?.liveUrl ? <a href={liveProof.liveUrl} target="_blank" rel="noopener noreferrer">View post <ExternalLink size={13} /></a> : null}
              <button onClick={() => void refreshProof()} disabled={Boolean(busy)} title={`Check ${platformLabel(selectedPlatform)} for new comments`} aria-label={`Refresh ${platformLabel(selectedPlatform)} comments`}><RefreshCw className={busy.includes("refresh") ? "engagement-spin" : ""} size={14} /></button>
            </div>
          </header>

          {sync ? <div className={`engagement-sync ${sync.state}`}><span>{sync.state === "current" ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}</span><p><strong>{sync.title}</strong><small>{sync.detail}</small></p></div> : null}

          <section className="engagement-proof-context" aria-label="Published proof context">
            <div><small>Content</small><strong>{context?.title ?? view.thread.contentItemId}</strong></div>
            <div><small>{platformLabel(selectedPlatform)} post</small><strong>{engagementProviderObjectId(view.thread)}</strong></div>
            <div><small>{platformLabel(selectedPlatform)} account</small><strong>{view.thread.accountId}</strong></div>
            {capabilities.canManageThread ? <div className="engagement-thread-controls"><button onClick={() => void updateThread({ assignedTo: auth.user.id })} disabled={Boolean(busy)}><UserCheck size={13} /> {view.thread.assignedTo === auth.user.id ? "Assigned to you" : "Assign to me"}</button><button onClick={() => void updateThread({ state: view.thread.state === "open" ? "resolved" : "open" })} disabled={Boolean(busy)}>{view.thread.state === "open" ? <><Check size={13} /> Resolve</> : <><RefreshCw size={13} /> Reopen</>}</button></div> : null}
          </section>

          {providerState ? <section className="engagement-provider-state" aria-label="Channel health">
            {(["permission", "subscription", "reconciliation"] as const).map((key) => <div className={providerState[key].tone} key={key}><small>{key}</small><strong>{providerState[key].label}</strong><span>{providerState[key].detail}</span></div>)}
          </section> : null}

          <div className="engagement-timeline" aria-live="polite">
            {view.comments.length === 0 ? <div className="engagement-state"><MessageCircle size={22} /><strong>No saved comments</strong><p>Refresh this proof to check {platformLabel(selectedPlatform)}.</p></div> : view.comments.map((comment) => <article key={comment.id} className={`engagement-comment ${comment.direction} visibility-${comment.visibility}`}>
              <span>{comment.direction === "incoming" ? <AtSign size={15} /> : <Reply size={15} />}</span>
              <div><header><strong>{comment.direction === "incoming" ? `@${comment.authorUsername ?? `${platformLabel(selectedPlatform)} user`}` : "Your account"}</strong><time>{relativeTime(comment.providerCreatedAt ?? comment.firstSeenAt)}</time></header><p>{comment.visibility === "deleted" ? `This comment was deleted on ${platformLabel(selectedPlatform)}.` : comment.body}</p><small>{comment.direction === "incoming" ? `${platformLabel(selectedPlatform)} comment` : "Public reply"} · {comment.source}</small></div>
            </article>)}

            {view.actions.map((action) => <article className={`engagement-action status-${action.status}`} key={action.id}>
              <span>{action.status === "uncertain" || action.status === "failed" || action.status === "action_required" ? <AlertTriangle size={16} /> : action.status === "succeeded" ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}</span>
              <div><header><strong>Reply preview</strong><em>{actionLabel(action.status)}</em></header><p>{action.body}</p>{action.errorSummary ? <small>{action.errorSummary}</small> : <small>Saved {relativePastTime(action.updatedAt)} · exact text is locked for approval</small>}</div>
              <div className="engagement-action-buttons">
                {action.status === "pending_approval" && capabilities.canSend ? <button className={replyCanSend ? "approve" : "send-blocked"} onClick={() => void changeAction(action, "approve")} disabled={Boolean(busy) || !replyCanSend} title={!replyCanSend ? replyAction?.detail : undefined}><Send size={13} /> {replyCanSend ? "Approve & send" : "Sending unavailable"}</button> : null}
                {action.status === "uncertain" && capabilities.canSend ? <><button className="approve" onClick={() => void reconcileAction(action, "confirmed_sent")} disabled={Boolean(busy)}><Check size={13} /> Confirm sent</button><button onClick={() => void reconcileAction(action, "confirmed_not_sent")} disabled={Boolean(busy)}><X size={13} /> Confirm not sent</button></> : null}
                {engagementCanCancelAction(membership?.role ?? "viewer", auth.user.id, action) ? <button onClick={() => void changeAction(action, "cancel")} disabled={Boolean(busy)}><X size={13} /> Cancel</button> : null}
              </div>
            </article>)}
          </div>

          <footer className="engagement-composer-wrap">
            {pendingActions.some((action) => action.status === "uncertain") ? <div className="engagement-uncertain"><AlertTriangle size={15} /><p><strong>Do not send again yet.</strong><span>{platformLabel(selectedPlatform)} may already have received this reply. A person must check the live post first.</span></p></div> : null}
            {replyAction ? <div className="engagement-action-required"><AlertTriangle size={15} /><p><strong>{replyAction.title}</strong><span>{replyAction.detail} You can still save drafts and keep the approval history in OriginPost.</span></p></div> : null}
            {capabilities.canDraft && view.thread.state === "open" && !replyInFlight ? <form className="engagement-composer" onSubmit={submitReply}><label><span className="sr-only">Public {platformLabel(selectedPlatform)} reply draft</span><textarea name="body" rows={3} maxLength={2200} placeholder="Write a clear public reply…" required /></label><div><p><ShieldCheck size={13} /> Saved for human approval before sending</p><button className="new-button" disabled={Boolean(busy)}><Reply size={14} /> Save for approval</button></div></form> : <div className="engagement-readonly"><ShieldCheck size={16} /><p><strong>{replyInFlight ? "Another reply is still in progress" : view.thread.state === "resolved" ? "This conversation is resolved" : "Read-only access"}</strong><span>{replyInFlight ? "Resolve or verify that reply before preparing another one." : view.thread.state === "resolved" ? "Reopen it before preparing another reply." : "A creator, manager, or owner can prepare replies."}</span></p></div>}
          </footer>
        </> : null}
      </main>
    </div>
  </section>;
}
