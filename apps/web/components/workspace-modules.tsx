"use client";

import { AlertTriangle, ArrowRight, Bot, Building2, Cable, Camera, Check, CheckSquare, Clock3, Copy, Database, Download, FileAudio, FileImage, FileText, FileVideo, Folder, FolderPlus, HardDrive, LockKeyhole, MessagesSquare, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Share2, ShieldCheck, Star, Tags, Trash2, Upload, Users, X, Zap } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { workspaceInvitationActionPath, workspaceInvitationsPath } from "@/lib/workspace-invitations";
import { AnalyticsDashboard } from "./analytics/analytics-dashboard";
import { EngagementInbox } from "./engagement/engagement-inbox";
import { AutomationGateway } from "./automation/automation-gateway";
import { BatchOperations } from "./batch-operations/batch-operations";
import { SourceSignalDesk } from "./signals/source-signal-desk";
import { ReuseStudio } from "./evergreen/reuse-studio";
import { AudioStudio } from "./audio/audio-studio";
import { AgentRuntimeSettings } from "./agents/agent-runtime-settings";
import { CreativeStudio } from "./creative-studio/creative-studio";
import { connectedAccountStatusPresentation, parseFacebookPageSelection, parseInstagramFacebookSelection, parseMetaMessagingSelection, parseProviderGrantViews, platformAccountKind, platformLabel, type FacebookPageSelection, type InstagramFacebookSelection, type MetaMessagingSelection, type ProviderGrantView, type PublishingPlatform } from "./platform-ui";
import { instagramStoryCapabilityCopy, type InstagramStoryCapabilityView } from "./instagram-story-capability";
import { PostingQueueProfilePanel } from "./posting-queues/posting-queue-profile";
import { mediaMatchesOrganizationFilters, orderedMediaFolders, parseMediaTagInput } from "./media-library/media-organization-utils";
import { BoardsWorkspace } from "./boards/boards-workspace";
import { OperationsHealthPanel } from "./operations/operations-health-panel";

export type WorkspaceModule = "audio" | "boards" | "signals" | "evergreen" | "analytics" | "engagement" | "automations" | "batches" | "organizations" | "channels" | "plugins" | "library" | "creative" | "developer";

type Monitor = {
  id: string;
  name: string;
  query: string;
  intervalMinutes: number;
  languages: string[];
  region?: string;
  enabled: boolean;
  health?: "paused" | "waiting" | "healthy" | "degraded" | "running" | "failed" | "stale" | "coalesced";
  nextExpectedAt?: string | null;
  lastRun?: MonitorRun | null;
  runs?: MonitorRun[];
};

type MonitorRun = { id: string; status: "running" | "completed" | "failed" | "skipped"; trigger: "scheduled" | "manual"; discoveredCount: number; newCount: number; error?: string; reason?: string; startedAt: string; completedAt?: string };
type MonitorStatus = { monitor: Omit<Monitor, "health" | "nextExpectedAt" | "lastRun" | "runs">; health: NonNullable<Monitor["health"]>; nextExpectedAt: string | null; lastRun: MonitorRun | null; runs: MonitorRun[] };

type Connector = {
  id: string;
  name: string;
  platform: string;
  apiMode: string;
  capabilities: { formats: string[]; analytics: boolean; comments: boolean; tokenRefresh: boolean; pendingPublishing: boolean };
  limits: { captionCharacters: number; maxMedia: number };
};

type ConnectionCheck = { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string; action?: string };
type ConnectedAccount = {
  id: string; brandId: string; platform: PublishingPlatform; displayName: string; externalAccountId: string; capabilities: string[];
  status: "setup_required" | "healthy" | "expiring" | "refresh_failed" | "disconnected";
  credentialConfigured: boolean; credentialManaged: boolean; expiresAt?: string; lastCheckedAt?: string; lastErrorCode?: string;
  instagramStory?: InstagramStoryCapabilityView;
  diagnostic: { readiness: "healthy" | "warning" | "blocked"; checkedAt: string; callbackUrl: string; checks: ConnectionCheck[] };
};

type AgentStatus = {
  hermes: { configured: boolean; healthy: boolean };
  sourcing: { mode: string; ready: boolean };
};
type PluginCatalog = {
  configured: boolean;
  entries: Array<{
    id: string; name: string; version: string; description: string; compatibility: { originpost: string };
    permissions: string[]; networkAllowlist: string[]; status: "available";
  }>;
  rejected: Array<{ directory: string; code: string; message: string }>;
};
type OAuthStatus = { instagram: { configured: boolean }; instagramFacebook: { configured: boolean }; facebook: { configured: boolean }; youtube: { configured: boolean }; metaMessaging: { configured: boolean } };

type OutboxStats = { pending: number; processing: number; processed: number; failed: number; oldestPendingAt?: string };
type OutboxMessage = { id: string; topic: string; status: "pending" | "processing" | "processed" | "failed"; attempts: number; availableAt: string; lastError?: string; payload: Record<string, unknown> };
export type BrandView = { id: string; workspaceId: string; name: string; slug: string; description?: string; primaryLanguage: string; timezone: string; status: "active" | "archived"; createdAt: string; updatedAt: string };

function InstagramStoryCapabilityCheck({ capability }: { capability: InstagramStoryCapabilityView | undefined }) {
  const story = instagramStoryCapabilityCopy(capability);
  return <div className={story.status}><span>{story.status === "pass" ? <Check size={13} /> : <AlertTriangle size={13} />}</span><p><strong>{story.label}</strong><small>{story.detail}</small></p></div>;
}

function providerGrantPresentation(grant: ProviderGrantView): { label: string; readiness: "healthy" | "warning" | "blocked"; detail: string } {
  if (grant.status === "active") return { label: "Connected", readiness: "healthy", detail: "Provider access is available to the linked publishing accounts." };
  if (grant.status === "expiring") return { label: "Access expiring", readiness: "warning", detail: "OriginPost will renew or recheck this provider access before it expires." };
  if (grant.status === "refresh_failed") return grant.lastErrorCode && grant.lastErrorCode !== "provider_validation_unavailable"
    ? { label: "Validation needs review", readiness: "warning", detail: "OriginPost kept every credential intact and asked an owner to review the authorization." }
    : { label: "Retrying automatically", readiness: "warning", detail: "The provider was temporarily unavailable. OriginPost will check again automatically." };
  if (grant.status === "deletion_pending") return grant.lastErrorCode === "provider_data_deletion_failed"
    ? { label: "Deletion needs review", readiness: "blocked", detail: "Automatic deletion stopped safely and was retained for operator review." }
    : { label: "Deleting OriginPost data", readiness: "blocked", detail: "Publishing is blocked while provider-derived data is removed." };
  if (grant.status === "deleted") return { label: "Deletion complete", readiness: "blocked", detail: "Provider-derived data was removed; workspace-authored drafts and media remain." };
  if (grant.status === "deauthorized") return { label: "Access removed by provider", readiness: "blocked", detail: "The provider removed this authorization. Reconnect to restore access." };
  if (grant.status === "revoked") return { label: "Disconnected", readiness: "blocked", detail: "Provider access was revoked and local publishing is blocked." };
  if (grant.status === "superseded") return { label: "Replaced", readiness: "warning", detail: "A newer provider authorization replaced this historical record." };
  return { label: "Reconnect needed", readiness: "blocked", detail: "Provider access must be reauthorized before publishing." };
}

export function WorkspaceModules({ module, auth, workspaceId, activeBrandId, brands, creativeContentItemId, onOrganizationChanged, onEngagementUnreadChange, onOpenContent }: { module: WorkspaceModule; auth: AuthView; workspaceId: string; activeBrandId: string; brands: BrandView[]; creativeContentItemId?: string; onOrganizationChanged: (workspaceId?: string) => void | Promise<void>; onEngagementUnreadChange?: (count: number) => void; onOpenContent?: (contentItemId: string) => void }) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([]);
  const [providerGrants, setProviderGrants] = useState<ProviderGrantView[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [pluginCatalog, setPluginCatalog] = useState<PluginCatalog | null>(null);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [outboxStats, setOutboxStats] = useState<OutboxStats>({ pending: 0, processing: 0, processed: 0, failed: 0 });
  const [outboxMessages, setOutboxMessages] = useState<OutboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [monitorFormOpen, setMonitorFormOpen] = useState(false);
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [error, setError] = useState("");
  const [channelMessage, setChannelMessage] = useState("");
  const [facebookSelection, setFacebookSelection] = useState<FacebookPageSelection | null>(null);
  const [selectedFacebookPageIds, setSelectedFacebookPageIds] = useState<string[]>([]);
  const [facebookSelectionBusy, setFacebookSelectionBusy] = useState(false);
  const [instagramFacebookSelection, setInstagramFacebookSelection] = useState<InstagramFacebookSelection | null>(null);
  const [selectedInstagramAccountIds, setSelectedInstagramAccountIds] = useState<string[]>([]);
  const [instagramFacebookSelectionBusy, setInstagramFacebookSelectionBusy] = useState(false);
  const [metaMessagingSelection, setMetaMessagingSelection] = useState<MetaMessagingSelection | null>(null);
  const [selectedMetaMessagingTargetKeys, setSelectedMetaMessagingTargetKeys] = useState<string[]>([]);
  const [metaMessagingSelectionBusy, setMetaMessagingSelectionBusy] = useState(false);
  const membership = auth.memberships.find((entry) => entry.workspaceId === workspaceId) ?? auth.memberships[0];
  const canManageChannels = membership?.role === "owner";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (module === "automations") {
        const [monitorResponse, statsResponse, messagesResponse] = await Promise.all([
          apiFetch(`/v1/monitors/status?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(activeBrandId)}`, { cache: "no-store" }, auth.csrfToken),
          apiFetch(`/v1/operations/outbox?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken),
          apiFetch(`/v1/operations/outbox/messages?workspaceId=${encodeURIComponent(workspaceId)}&limit=8`, { cache: "no-store" }, auth.csrfToken),
        ]);
        if (!monitorResponse.ok || !statsResponse.ok || !messagesResponse.ok) throw new Error("Could not load automation health.");
        const monitorStatuses = await monitorResponse.json() as MonitorStatus[];
        setMonitors(monitorStatuses.map((status) => ({ ...status.monitor, health: status.health, nextExpectedAt: status.nextExpectedAt, lastRun: status.lastRun, runs: status.runs })));
        setOutboxStats(await statsResponse.json() as OutboxStats);
        setOutboxMessages(await messagesResponse.json() as OutboxMessage[]);
      }
      if (module === "channels" || module === "plugins") {
        const [connectorResponse, agentResponse, accountsResponse, oauthResponse, pluginResponse, providerGrantResponse] = await Promise.all([
          apiFetch(`/v1/connectors`, { cache: "no-store" }, auth.csrfToken),
          apiFetch(`/v1/agents/status`, { cache: "no-store" }, auth.csrfToken),
          module === "channels" ? apiFetch(`/v1/channels/accounts?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(activeBrandId)}`, { cache: "no-store" }, auth.csrfToken) : Promise.resolve(null),
          module === "channels" ? apiFetch(`/v1/channels/oauth/status`, { cache: "no-store" }, auth.csrfToken) : Promise.resolve(null),
          module === "plugins" ? apiFetch(`/v1/plugins/catalog`, { cache: "no-store" }, auth.csrfToken) : Promise.resolve(null),
          module === "channels" ? apiFetch(`/v1/channels/provider-grants?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(activeBrandId)}`, { cache: "no-store" }, auth.csrfToken) : Promise.resolve(null),
        ]);
        if (!connectorResponse.ok || !agentResponse.ok || (accountsResponse && !accountsResponse.ok) || (oauthResponse && !oauthResponse.ok) || (pluginResponse && !pluginResponse.ok) || (providerGrantResponse && !providerGrantResponse.ok)) throw new Error("Could not load module status.");
        setConnectors(await connectorResponse.json() as Connector[]);
        setAgentStatus(await agentResponse.json() as AgentStatus);
        if (accountsResponse) setConnectedAccounts(await accountsResponse.json() as ConnectedAccount[]);
        if (oauthResponse) setOauthStatus(await oauthResponse.json() as OAuthStatus);
        if (pluginResponse) setPluginCatalog(await pluginResponse.json() as PluginCatalog);
        if (providerGrantResponse) setProviderGrants(parseProviderGrantViews(await providerGrantResponse.json()));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This module is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [activeBrandId, auth.csrfToken, module, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (module !== "channels" || loading || providerGrants.length === 0) return;
    const grantId = new URLSearchParams(window.location.search).get("grant")?.trim();
    if (!grantId) return;
    const grant = document.getElementById(`provider-grant-${grantId}`);
    grant?.scrollIntoView({ behavior: "smooth", block: "center" });
    grant?.focus({ preventScroll: true });
  }, [loading, module, providerGrants]);

  useEffect(() => {
    if (module !== "channels") return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("channel");
    if (result !== "connected" && result !== "error") return;
    if (result === "connected") setChannelMessage("Provider access connected. OriginPost has loaded the resulting publishing account and authorization.");
    else {
      const reason = url.searchParams.get("reason");
      setError(reason === "provider_denied" ? "The provider connection was cancelled or denied. No existing access was changed." : reason === "no_eligible_instagram_accounts" ? "Meta did not return an eligible professional Instagram account. Check the Page link and permissions, then try again." : "The provider connection could not be completed. No existing access was changed.");
    }
    for (const key of ["channel", "reason", "accountId"]) url.searchParams.delete(key);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [module]);

  useEffect(() => {
    if (module !== "channels") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("channel") !== "select_facebook") return;
    const selectionId = params.get("selectionId")?.trim();
    if (!selectionId) { setError("Facebook Page selection is missing. Start the connection again."); return; }
    let cancelled = false;
    setFacebookSelectionBusy(true);
    setError("");
    void (async () => {
      try {
        const response = await apiFetch(`/v1/channels/oauth/facebook/selections/${encodeURIComponent(selectionId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as { selectionId?: unknown; expiresAt?: unknown; pages?: unknown; message?: string | string[] };
        if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not load eligible Facebook Pages.");
        const selection = parseFacebookPageSelection(body, selectionId);
        if (cancelled) return;
        setFacebookSelection(selection);
        setSelectedFacebookPageIds(selection.pages.length === 1 ? [selection.pages[0]!.externalAccountId] : []);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load eligible Facebook Pages.");
      } finally {
        if (!cancelled) setFacebookSelectionBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, module, workspaceId]);

  useEffect(() => {
    if (module !== "channels") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("channel") !== "select_instagram") return;
    const selectionId = params.get("selectionId")?.trim();
    if (!selectionId) { setError("Instagram selection is missing. Start the connection again."); return; }
    let cancelled = false;
    setInstagramFacebookSelectionBusy(true);
    setError("");
    void (async () => {
      try {
        const response = await apiFetch(`/v1/channels/oauth/instagram-facebook/selections/${encodeURIComponent(selectionId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as Record<string, unknown> & { message?: string | string[] };
        if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not load eligible Instagram accounts.");
        const selection = parseInstagramFacebookSelection(body, selectionId);
        if (cancelled) return;
        setInstagramFacebookSelection(selection);
        setSelectedInstagramAccountIds(selection.accounts.length === 1 ? [selection.accounts[0]!.externalAccountId] : []);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load eligible Instagram accounts.");
      } finally {
        if (!cancelled) setInstagramFacebookSelectionBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, module, workspaceId]);

  useEffect(() => {
    if (module !== "channels") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("channel") !== "select_meta_messaging") return;
    const selectionId = params.get("selectionId")?.trim();
    if (!selectionId) { setError("Meta private-message selection is missing. Start re-consent again."); return; }
    let cancelled = false;
    setMetaMessagingSelectionBusy(true);
    setError("");
    void (async () => {
      try {
        const response = await apiFetch(`/v1/channels/oauth/meta-messaging/selections/${encodeURIComponent(selectionId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as { selectionId?: unknown; expiresAt?: unknown; candidates?: unknown; message?: string | string[] };
        if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not load eligible Meta inboxes.");
        const selection = parseMetaMessagingSelection(body, selectionId);
        if (cancelled) return;
        setMetaMessagingSelection(selection);
        setSelectedMetaMessagingTargetKeys(selection.candidates.length === 1 ? [selection.candidates[0]!.targetKey] : []);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load eligible Meta inboxes.");
      } finally {
        if (!cancelled) setMetaMessagingSelectionBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, module, workspaceId]);

  async function createMonitor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const languages = String(form.get("languages") ?? "English").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 4);
    const response = await apiFetch(`/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        brandId: activeBrandId,
        name: String(form.get("name") ?? "").trim(),
        query: String(form.get("query") ?? "").trim(),
        intervalMinutes: Number(form.get("intervalMinutes") ?? 15),
        depth: "standard",
        languages,
        region: String(form.get("region") ?? "").trim() || undefined,
        sourceLimit: 8,
        freshnessHours: 24,
        enabled: true,
      }),
    }, auth.csrfToken);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not create monitor.");
      return;
    }
    setMonitorFormOpen(false);
    formElement.reset();
    await load();
  }

  async function retryOutbox(message: OutboxMessage) {
    setError("");
    const response = await apiFetch(`/v1/operations/outbox/${encodeURIComponent(message.id)}/retry?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    if (!response.ok) { setError("Could not retry this delivery command."); return; }
    await load();
  }

  async function runMonitor(monitor: Monitor) {
    setError("");
    const response = await apiFetch(`/v1/monitors/${encodeURIComponent(monitor.id)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    if (!response.ok) { setError("Could not start this monitor. Check that it is enabled and Redis is running."); return; }
    await new Promise((resolve) => setTimeout(resolve, 650));
    await load();
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const platform = String(form.get("platform")) as ConnectedAccount["platform"];
    const permissionsGranted = form.get("permissionsGranted") === "on";
    const expiresValue = String(form.get("expiresAt") ?? "");
    const response = await apiFetch(`/v1/channels/accounts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, brandId: activeBrandId, platform, displayName: String(form.get("displayName") ?? "").trim(), externalAccountId: String(form.get("externalAccountId") ?? "").trim(), credentialRef: String(form.get("credentialRef") ?? "").trim() || undefined, capabilities: permissionsGranted ? (platform === "instagram" ? ["profile_read", "media_publish"] : platform === "facebook" ? ["page_read", "media_publish"] : ["channel_read", "video_upload"]) : [], expiresAt: expiresValue ? new Date(expiresValue).toISOString() : undefined }),
    }, auth.csrfToken);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not add this account."); return;
    }
    formElement.reset(); setAccountFormOpen(false); await load();
  }

  async function connectInstagram() {
    setError("");
    try {
      const response = await apiFetch("/v1/channels/oauth/instagram/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId: activeBrandId }) }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        setError(body.message ?? "Could not start Instagram connection."); return;
      }
      const result = await response.json() as { authorizationUrl: string };
      window.location.assign(result.authorizationUrl);
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function connectInstagramFacebook() {
    setError("");
    setChannelMessage("");
    try {
      const response = await apiFetch("/v1/channels/oauth/instagram-facebook/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId: activeBrandId }) }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not start Instagram connection through Facebook Login."); return;
      }
      const result = await response.json() as { authorizationUrl: string };
      window.location.assign(result.authorizationUrl);
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function connectFacebook() {
    setError("");
    setChannelMessage("");
    try {
      const response = await apiFetch("/v1/channels/oauth/facebook/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId: activeBrandId }) }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not start Facebook Page connection."); return;
      }
      const result = await response.json() as { authorizationUrl: string };
      window.location.assign(result.authorizationUrl);
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function connectMetaMessaging() {
    setError("");
    setChannelMessage("");
    try {
      const response = await apiFetch("/v1/channels/oauth/meta-messaging/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId: activeBrandId }) }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string | string[] };
        setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not start Meta private-message re-consent."); return;
      }
      const result = await response.json() as { authorizationUrl: string };
      window.location.assign(result.authorizationUrl);
    } catch { setError("Could not reach the OriginPost API."); }
  }

  function cleanChannelSelectionUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("channel");
    url.searchParams.delete("selectionId");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function finishFacebookSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!facebookSelection || selectedFacebookPageIds.length === 0) { setError("Choose at least one Facebook Page."); return; }
    setFacebookSelectionBusy(true);
    setError("");
    setChannelMessage("");
    try {
      const response = await apiFetch(`/v1/channels/oauth/facebook/selections/${encodeURIComponent(facebookSelection.selectionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, pageIds: selectedFacebookPageIds }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { connected?: boolean; accounts?: unknown; message?: string | string[] };
      if (!response.ok || body.connected !== true) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not connect the selected Facebook Pages.");
      setChannelMessage(`${selectedFacebookPageIds.length} Facebook Page${selectedFacebookPageIds.length === 1 ? "" : "s"} connected.`);
      setFacebookSelection(null);
      setSelectedFacebookPageIds([]);
      cleanChannelSelectionUrl();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect the selected Facebook Pages.");
    } finally {
      setFacebookSelectionBusy(false);
    }
  }

  async function finishInstagramFacebookSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!instagramFacebookSelection || selectedInstagramAccountIds.length === 0) { setError("Choose at least one Instagram account."); return; }
    setInstagramFacebookSelectionBusy(true);
    setError("");
    setChannelMessage("");
    try {
      const response = await apiFetch(`/v1/channels/oauth/instagram-facebook/selections/${encodeURIComponent(instagramFacebookSelection.selectionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, instagramAccountIds: selectedInstagramAccountIds }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { connected?: boolean; accounts?: unknown; message?: string | string[] };
      if (!response.ok || body.connected !== true) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not connect the selected Instagram accounts.");
      setChannelMessage(`${selectedInstagramAccountIds.length} Instagram account${selectedInstagramAccountIds.length === 1 ? "" : "s"} connected through Facebook Login.`);
      setInstagramFacebookSelection(null);
      setSelectedInstagramAccountIds([]);
      cleanChannelSelectionUrl();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect the selected Instagram accounts.");
    } finally {
      setInstagramFacebookSelectionBusy(false);
    }
  }

  async function finishMetaMessagingSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!metaMessagingSelection || selectedMetaMessagingTargetKeys.length === 0) { setError("Choose at least one Meta inbox."); return; }
    setMetaMessagingSelectionBusy(true);
    setError("");
    setChannelMessage("");
    try {
      const response = await apiFetch(`/v1/channels/oauth/meta-messaging/selections/${encodeURIComponent(metaMessagingSelection.selectionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, targetKeys: selectedMetaMessagingTargetKeys }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { connected?: boolean; accounts?: unknown; message?: string | string[] };
      if (!response.ok || body.connected !== true) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not enable the selected Meta inboxes.");
      setChannelMessage(`${selectedMetaMessagingTargetKeys.length} Meta inbox${selectedMetaMessagingTargetKeys.length === 1 ? "" : "es"} enabled and queued for secure sync.`);
      setMetaMessagingSelection(null);
      setSelectedMetaMessagingTargetKeys([]);
      cleanChannelSelectionUrl();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable the selected Meta inboxes.");
    } finally {
      setMetaMessagingSelectionBusy(false);
    }
  }

  async function connectYouTube() {
    setError("");
    try {
      const response = await apiFetch("/v1/channels/oauth/youtube/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId: activeBrandId }) }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        setError(body.message ?? "Could not start YouTube connection."); return;
      }
      const result = await response.json() as { authorizationUrl: string };
      window.location.assign(result.authorizationUrl);
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function checkAccount(account: ConnectedAccount) {
    setError("");
    const response = await apiFetch(`/v1/channels/accounts/${encodeURIComponent(account.id)}/check?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    if (!response.ok) { setError("Could not check this account."); return; }
    await load();
  }

  async function refreshAccount(account: ConnectedAccount) {
    setError("");
    const response = await apiFetch(`/v1/channels/accounts/${encodeURIComponent(account.id)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      setError(body.message ?? `Could not renew ${platformLabel(account.platform)} access. Reconnect the account.`); return;
    }
    await load();
  }

  async function disconnectAccount(account: ConnectedAccount) {
    const retryProviderRevocation = account.platform === "youtube" && account.status === "disconnected" && account.lastErrorCode === "provider_revocation_pending";
    if (!window.confirm(retryProviderRevocation ? `Retry Google access revocation for ${account.displayName}? Local publishing is already blocked.` : `Disconnect ${account.displayName}? Scheduled drafts will stay in OriginPost.`)) return;
    setError("");
    const response = await apiFetch(`/v1/channels/accounts/${encodeURIComponent(account.id)}/disconnect?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" }, auth.csrfToken);
    if (!response.ok) { setError(retryProviderRevocation ? "Google access could not be revoked yet. Local publishing remains blocked; try again later." : "Could not disconnect this account."); return; }
    await load();
  }

  if (module === "organizations") return <OrganizationModule auth={auth} workspaceId={workspaceId} brands={brands} onChanged={onOrganizationChanged} />;
  if (module === "boards") return <BoardsWorkspace auth={auth} workspaceId={workspaceId} brandId={activeBrandId} {...(onOpenContent ? { onOpenContent } : {})} />;
  if (module === "audio") return <AudioStudio key={`${workspaceId}:${activeBrandId}:${auth.user.id}`} auth={auth} workspaceId={workspaceId} brandId={activeBrandId} />;
  if (module === "library") return <MediaLibrary auth={auth} workspaceId={workspaceId} brandId={activeBrandId} />;
  if (module === "creative") return <CreativeStudio auth={auth} workspaceId={workspaceId} brandId={activeBrandId} {...(creativeContentItemId ? { initialContentItemId: creativeContentItemId } : {})} {...(onOpenContent ? { onOpenContent } : {})} />;
  if (module === "analytics") return <AnalyticsDashboard auth={auth} workspaceId={workspaceId} brandId={activeBrandId} brands={brands} />;
  if (module === "signals") return <SourceSignalDesk auth={auth} workspaceId={workspaceId} brandId={activeBrandId} {...(onOpenContent ? { onOpenContent } : {})} />;
  if (module === "evergreen") return <ReuseStudio auth={auth} workspaceId={workspaceId} brandId={activeBrandId} {...(onOpenContent ? { onOpenContent } : {})} />;
  if (module === "engagement") return <EngagementInbox auth={auth} workspaceId={workspaceId} brandId={activeBrandId} {...(onEngagementUnreadChange ? { onUnreadCountChange: onEngagementUnreadChange } : {})} />;
  if (module === "batches") return <BatchOperations auth={auth} workspaceId={workspaceId} brandId={activeBrandId} {...(onOpenContent ? { onOpenContent } : {})} />;
  if (module === "developer") return <AutomationGateway auth={auth} workspaceId={workspaceId} brandId={activeBrandId} />;

  const eligibleMetaMessagingAccounts = connectedAccounts.filter((account) => (account.platform === "facebook" || account.platform === "instagram") && account.status !== "disconnected");
  const enabledMetaMessagingAccounts = eligibleMetaMessagingAccounts.filter((account) => account.capabilities.includes("private_message_read") && account.capabilities.includes("private_message_send"));
  const title = module === "automations" ? "Source monitoring" : module === "channels" ? "Publishing channels" : "Agent plugins";
  const description = module === "automations"
    ? "Check chosen topics on a schedule. New findings arrive in the content inbox with their source links."
    : module === "channels"
      ? "Connect the accounts you publish to. OriginPost checks access, permissions, and account health before anything is scheduled."
      : "Research and writing providers plug into one clear boundary. Workspaces decide which provider may run.";

  return <section className="module-page">
    <div className="module-hero">
      <div><p className="eyebrow">WORKSPACE MODULE</p><h1>{title}</h1><p>{description}</p></div>
      <div className="module-actions">
        <button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>
        {module === "automations" ? <button className="new-button" onClick={() => setMonitorFormOpen((value) => !value)}><Plus size={15} /> New monitor</button> : null}
        {module === "channels" && canManageChannels ? <button className="secondary-button" onClick={() => setAccountFormOpen((value) => !value)}><Plus size={15} /> Add test account</button> : null}
      </div>
    </div>

    {error ? <div className="module-alert" role="alert">{error}</div> : null}
    {channelMessage ? <div className="module-alert success" role="status">{channelMessage}</div> : null}

    {module === "automations" ? <>
      {monitorFormOpen ? <form className="monitor-form panel" onSubmit={createMonitor}>
        <div><label>Monitor name<input name="name" required minLength={2} placeholder="Ahmedabad civic updates" /></label><label>Search every<select name="intervalMinutes" defaultValue="15"><option value="10">10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option></select></label></div>
        <label>What should OriginPost look for?<textarea name="query" required minLength={3} rows={3} placeholder="Latest verified Ahmedabad civic news from primary and trusted sources" /></label>
        <div><label>Languages<input name="languages" defaultValue="Gujarati, Hindi, English" /></label><label>Region<input name="region" defaultValue="Gujarat" /></label></div>
        <div className="monitor-form-actions"><p>Runs are deduplicated. The same source will not create the same suggestion twice.</p><button className="new-button" type="submit"><Zap size={15} /> Start monitor</button></div>
      </form> : null}
      <div className="module-stats">
        <div><span><Zap size={18} /></span><small>Active monitors</small><strong>{monitors.filter((monitor) => monitor.enabled).length}</strong></div>
        <div><span><Clock3 size={18} /></span><small>Fastest check</small><strong>{monitors.length ? `${Math.min(...monitors.map((monitor) => monitor.intervalMinutes))}m` : "—"}</strong></div>
        <div><span><ShieldCheck size={18} /></span><small>Duplicate guard</small><strong>On</strong></div>
      </div>
      <div className="delivery-health panel">
        <div className="module-list-head"><div><h2>Delivery recovery</h2><p>PostgreSQL keeps scheduled commands until a worker safely accepts them.</p></div><span className={outboxStats.failed ? "danger-count" : ""}>{outboxStats.failed ? `${outboxStats.failed} failed` : "Healthy"}</span></div>
        <div className="delivery-summary">
          <div><Database size={17} /><span><small>Waiting</small><strong>{outboxStats.pending}</strong></span></div>
          <div><Clock3 size={17} /><span><small>Dispatching</small><strong>{outboxStats.processing}</strong></span></div>
          <div><Check size={17} /><span><small>Delivered</small><strong>{outboxStats.processed}</strong></span></div>
          <div className={outboxStats.failed ? "has-failure" : ""}><AlertTriangle size={17} /><span><small>Needs retry</small><strong>{outboxStats.failed}</strong></span></div>
        </div>
        {outboxMessages.length ? <div className="delivery-events">{outboxMessages.map((message) => <article key={message.id}>
          <span className={`delivery-dot ${message.status}`} />
          <div><strong>{message.topic === "publish.target.requested" ? "Publish target" : message.topic}</strong><small>{message.status} · attempt {message.attempts} · {new Date(message.availableAt).toLocaleString()}</small>{message.lastError ? <p>{message.lastError}</p> : null}</div>
          {message.status === "failed" ? <button onClick={() => void retryOutbox(message)}><RotateCcw size={13} /> Retry</button> : null}
        </article>)}</div> : <div className="delivery-empty"><ShieldCheck size={18} /> No delivery commands yet.</div>}
      </div>
      <div className="module-list panel">
        <div className="module-list-head"><div><h2>Monitoring schedule</h2><p>Global schedule for this workspace.</p></div><span>{loading ? "Loading…" : `${monitors.length} configured`}</span></div>
        {monitors.map((monitor) => <div className="monitor-block" key={monitor.id}>
          <article className="monitor-row">
            <span className={`module-state ${monitor.health === "healthy" ? "online" : monitor.health === "failed" || monitor.health === "stale" || monitor.health === "degraded" ? "unhealthy" : ""}`}><Zap size={16} /></span>
            <div><strong>{monitor.name}</strong><p>{monitor.query}</p><small>{monitor.languages.join(" · ")}{monitor.region ? ` · ${monitor.region}` : ""}</small></div>
            <div className="monitor-time"><strong>Every {monitor.intervalMinutes}m</strong><small className={`monitor-health ${monitor.health ?? "waiting"}`}>{(monitor.health ?? "waiting").replace("coalesced", "overlap skipped")}</small><button onClick={() => void runMonitor(monitor)} disabled={!monitor.enabled}><RefreshCw size={12} /> Run now</button></div>
          </article>
          {monitor.runs?.length ? <div className="monitor-runs">{monitor.runs.slice(0, 3).map((run) => <div key={run.id}><span className={`run-dot ${run.status}`} /><p><strong>{run.trigger === "manual" ? "Manual check" : "Scheduled check"}</strong><small>{new Date(run.startedAt).toLocaleString()} · {run.status}{run.status === "completed" ? ` · ${run.newCount} new` : ""}</small>{run.error ? <b>{run.error}</b> : run.reason ? <b>{run.reason.replaceAll("_", " ")}</b> : null}</p></div>)}</div> : <div className="monitor-never"><Clock3 size={13} /> No runs yet. Use Run now to test the full path.</div>}
        </div>)}
        {!loading && monitors.length === 0 ? <div className="module-empty"><Zap size={22} /><strong>No monitors yet</strong><p>Add one topic and OriginPost will check it on schedule.</p></div> : null}
      </div>
    </> : null}

    {module === "channels" ? <>
      <article className="panel" style={{padding:20,marginBottom:18}}><h2>One brand, all your publishing accounts</h2><p>Select your project’s brand in the workspace switcher, then connect Instagram, Facebook Pages, and YouTube below. Each connection belongs to that brand. Choose those accounts as destinations when reviewing a post.</p><p>Only the workspace owner can connect or disconnect accounts. Provider secrets stay encrypted on the server. Open <a href="/audio">Audio</a> to create narration for the same brand.</p></article>
      <div className="channel-connect-grid" aria-label="Connect publishing channels">
        <article className="channel-connect-card instagram-card panel">
          <div className="channel-connect-head">
            <span className="channel-platform-icon"><Camera size={22} /></span>
            <span className={`channel-config-state ${oauthStatus?.instagram.configured ? "ready" : "off"}`}><i />{loading ? "Checking setup" : oauthStatus?.instagram.configured ? "Ready to connect" : "OAuth is off"}</span>
          </div>
          <div className="channel-connect-copy"><p className="eyebrow">INSTAGRAM</p><h2>Publish posts, Reels, and Stories</h2><p>Connect a professional account through Meta. OriginPost verifies publishing access and the account type before Story auto publish.</p></div>
          <div className="channel-connect-meta"><span><strong>{connectedAccounts.filter((account) => account.platform === "instagram" && account.status !== "disconnected").length}</strong> connected</span><span>Posts · carousels · Reels · Stories</span></div>
          {!oauthStatus?.instagram.configured ? <div className="channel-off-state"><LockKeyhole size={17} /><div><strong>Server setup needed</strong><p>Add the Meta app ID, app secret, and encryption key. No sign-in is started until then.</p></div></div> : null}
          <button className="channel-connect-button" disabled={!canManageChannels || !oauthStatus?.instagram.configured} onClick={() => void connectInstagram()}>Connect Instagram <ArrowRight size={16} /></button>
          <button className="secondary-button" disabled={!canManageChannels || !oauthStatus?.instagramFacebook.configured} onClick={() => void connectInstagramFacebook()}>Use Facebook Login</button>
        </article>

        <article className="channel-connect-card facebook-card panel">
          <div className="channel-connect-head">
            <span className="channel-platform-icon"><Share2 size={22} /></span>
            <span className={`channel-config-state ${oauthStatus?.facebook.configured ? "ready" : "off"}`}><i />{loading ? "Checking setup" : oauthStatus?.facebook.configured ? "Ready to connect" : "OAuth is off"}</span>
          </div>
          <div className="channel-connect-copy"><p className="eyebrow">FACEBOOK PAGES</p><h2>Publish Page updates</h2><p>Sign in with Meta, then choose the exact Pages this brand may use. Instagram accounts and Facebook Pages stay separate.</p></div>
          <div className="channel-connect-meta"><span><strong>{connectedAccounts.filter((account) => account.platform === "facebook" && account.status !== "disconnected").length}</strong> connected</span><span>Text · single image</span></div>
          {!oauthStatus?.facebook.configured ? <div className="channel-off-state"><LockKeyhole size={17} /><div><strong>Server setup needed</strong><p>Add the Meta app ID, app secret, and encryption key. No Page is selected until sign-in finishes.</p></div></div> : null}
          <button className="channel-connect-button" disabled={!canManageChannels || !oauthStatus?.facebook.configured} onClick={() => void connectFacebook()}>Connect Facebook Pages <ArrowRight size={16} /></button>
        </article>

        <article className="channel-connect-card youtube-card panel">
          <div className="channel-connect-head">
            <span className="channel-platform-icon"><Play size={24} fill="currentColor" /></span>
            <span className={`channel-config-state ${oauthStatus?.youtube.configured ? "ready" : "off"}`}><i />{loading ? "Checking setup" : oauthStatus?.youtube.configured ? "Ready to connect" : "OAuth is off"}</span>
          </div>
          <div className="channel-connect-copy"><p className="eyebrow">YOUTUBE</p><h2>Upload videos and Shorts</h2><p>Connect a YouTube channel through Google. Final title, audience, disclosure, and visibility stay reviewable before scheduling.</p></div>
          <div className="channel-connect-meta"><span><strong>{connectedAccounts.filter((account) => account.platform === "youtube" && account.status !== "disconnected").length}</strong> connected</span><span>Videos · Shorts</span></div>
          {!oauthStatus?.youtube.configured ? <div className="channel-off-state"><LockKeyhole size={17} /><div><strong>Server setup needed</strong><p>Add the Google client ID, client secret, and encryption key. Publishing remains safely unavailable.</p></div></div> : null}
          <button className="channel-connect-button" disabled={!canManageChannels || !oauthStatus?.youtube.configured} onClick={() => void connectYouTube()}>Connect YouTube <ArrowRight size={16} /></button>
        </article>
      </div>
      <article className="private-message-connect panel">
        <div className="private-message-connect-icon"><MessagesSquare size={23} /></div>
        <div className="private-message-connect-copy"><p className="eyebrow">META PRIVATE MESSAGES</p><h2>Bring Facebook and Instagram DMs into one inbox</h2><p>This is a separate, explicit Meta re-consent. OriginPost requests messaging access only for accounts you already connected, checks each Page live, subscribes the approved webhook fields, and then starts an encrypted sync.</p><small>Normal replies are limited to Meta’s 24-hour customer-service window. OriginPost does not send unsolicited messages or enable the Human Agent extension.</small></div>
        <div className="private-message-connect-status">
          <span className={`channel-config-state ${oauthStatus?.metaMessaging.configured ? "ready" : "off"}`}><i />{loading ? "Checking setup" : oauthStatus?.metaMessaging.configured ? `${enabledMetaMessagingAccounts.length} of ${eligibleMetaMessagingAccounts.length} enabled` : "App Review setup needed"}</span>
          {!oauthStatus?.metaMessaging.configured ? <p>Configure official Meta messaging and record the approved App Review evidence before re-consent is available.</p> : eligibleMetaMessagingAccounts.length === 0 ? <p>Connect a Facebook Page or a Page-linked Instagram professional account first.</p> : <p>You will choose the exact inboxes after Meta sign-in. Existing publishing access stays unchanged.</p>}
          <button className="channel-connect-button" disabled={!canManageChannels || !oauthStatus?.metaMessaging.configured || eligibleMetaMessagingAccounts.length === 0} onClick={() => void connectMetaMessaging()}>{enabledMetaMessagingAccounts.length ? "Renew or add inbox access" : "Enable private messages"}<ArrowRight size={16} /></button>
        </div>
      </article>
      {instagramFacebookSelectionBusy && !instagramFacebookSelection ? <div className="facebook-page-selection panel" role="status"><RefreshCw className="analytics-spin" size={22} /><div><strong>Loading eligible Instagram accounts…</strong><p>Only account identity is shown here. Access tokens stay encrypted on the server.</p></div></div> : instagramFacebookSelection ? <form className="facebook-page-selection panel" onSubmit={finishInstagramFacebookSelection}>
        <div className="facebook-selection-head"><span><Camera size={20} /></span><div><p className="eyebrow">CHOOSE INSTAGRAM ACCOUNTS</p><h2>Select professional accounts for this brand</h2><p>Each selected account stays linked to this one Meta authorization. Nothing is connected until you confirm.</p></div></div>
        <div className="facebook-page-options">{instagramFacebookSelection.accounts.map((account) => <label key={account.externalAccountId}><input type="checkbox" checked={selectedInstagramAccountIds.includes(account.externalAccountId)} onChange={() => setSelectedInstagramAccountIds((current) => current.includes(account.externalAccountId) ? current.filter((id) => id !== account.externalAccountId) : [...current, account.externalAccountId])} /><span><strong>{account.displayName}</strong><small>@{account.username} · via {account.pageName}</small></span></label>)}</div>
        {instagramFacebookSelection.accounts.length === 0 ? <div className="channel-off-state"><AlertTriangle size={17} /><div><strong>No eligible Instagram accounts found</strong><p>Check that the Page is linked to a professional Instagram account, then start again.</p></div></div> : null}
        <div className="facebook-selection-actions"><p>{instagramFacebookSelection.expiresAt ? `Selection expires ${new Date(instagramFacebookSelection.expiresAt).toLocaleString()}.` : "This selection is temporary."} No token or secret is shown in the browser.</p><button className="new-button" disabled={instagramFacebookSelectionBusy || selectedInstagramAccountIds.length === 0}>{instagramFacebookSelectionBusy ? "Connecting…" : `Connect ${selectedInstagramAccountIds.length || "selected"} account${selectedInstagramAccountIds.length === 1 ? "" : "s"}`}</button></div>
      </form> : null}
      {metaMessagingSelectionBusy && !metaMessagingSelection ? <div className="facebook-page-selection panel" role="status"><RefreshCw className="analytics-spin" size={22} /><div><strong>Loading eligible Meta inboxes…</strong><p>Only account identity is shown here. Access tokens and Page credentials stay encrypted on the server.</p></div></div> : metaMessagingSelection ? <form className="facebook-page-selection meta-messaging-selection panel" onSubmit={finishMetaMessagingSelection}>
        <div className="facebook-selection-head"><span><MessagesSquare size={20} /></span><div><p className="eyebrow">CHOOSE META INBOXES</p><h2>Confirm private-message access</h2><p>Each choice adds read and reply access to an existing OriginPost account. Publishing permissions are not changed.</p></div></div>
        <div className="facebook-page-options">{metaMessagingSelection.candidates.map((candidate) => <label key={candidate.targetKey}><input type="checkbox" checked={selectedMetaMessagingTargetKeys.includes(candidate.targetKey)} onChange={() => setSelectedMetaMessagingTargetKeys((current) => current.includes(candidate.targetKey) ? current.filter((key) => key !== candidate.targetKey) : [...current, candidate.targetKey])} /><span><strong>{candidate.displayName}</strong><small>{candidate.connectionMode === "facebook_page_messenger" ? "Facebook Page Messenger" : `Instagram via ${candidate.pageName}`}</small></span></label>)}</div>
        {metaMessagingSelection.candidates.length === 0 ? <div className="channel-off-state"><AlertTriangle size={17} /><div><strong>No matching inboxes found</strong><p>Meta did not return messaging access for a currently connected account. Check Page roles and App Review, then start re-consent again.</p></div></div> : null}
        <div className="facebook-selection-actions"><p>{metaMessagingSelection.expiresAt ? `Selection expires ${new Date(metaMessagingSelection.expiresAt).toLocaleString()}.` : "This selection is temporary."} Replies remain policy-window checked on the server.</p><button className="new-button" disabled={metaMessagingSelectionBusy || selectedMetaMessagingTargetKeys.length === 0}>{metaMessagingSelectionBusy ? "Enabling…" : `Enable ${selectedMetaMessagingTargetKeys.length || "selected"} inbox${selectedMetaMessagingTargetKeys.length === 1 ? "" : "es"}`}</button></div>
      </form> : null}
      {facebookSelectionBusy && !facebookSelection ? <div className="facebook-page-selection panel" role="status"><RefreshCw className="analytics-spin" size={22} /><div><strong>Loading eligible Facebook Pages…</strong><p>Only Page names and IDs are shown here. Access tokens stay on the server.</p></div></div> : facebookSelection ? <form className="facebook-page-selection panel" onSubmit={finishFacebookSelection}>
        <div className="facebook-selection-head"><span><Share2 size={20} /></span><div><p className="eyebrow">CHOOSE FACEBOOK PAGES</p><h2>Select Pages for this brand</h2><p>Each Page becomes its own publishing account. Nothing is connected until you confirm.</p></div></div>
        <div className="facebook-page-options">{facebookSelection.pages.map((page) => <label key={page.externalAccountId}><input type="checkbox" checked={selectedFacebookPageIds.includes(page.externalAccountId)} onChange={() => setSelectedFacebookPageIds((current) => current.includes(page.externalAccountId) ? current.filter((id) => id !== page.externalAccountId) : [...current, page.externalAccountId])} /><span><strong>{page.displayName}</strong><small>Page ID {page.externalAccountId}</small></span></label>)}</div>
        {facebookSelection.pages.length === 0 ? <div className="channel-off-state"><AlertTriangle size={17} /><div><strong>No eligible Pages found</strong><p>Ask a Page admin to grant access, then start the Meta connection again.</p></div></div> : null}
        <div className="facebook-selection-actions"><p>{facebookSelection.expiresAt ? `Selection expires ${new Date(facebookSelection.expiresAt).toLocaleString()}.` : "This selection is temporary."} No token or secret is shown in the browser.</p><button className="new-button" disabled={facebookSelectionBusy || selectedFacebookPageIds.length === 0}>{facebookSelectionBusy ? "Connecting…" : `Connect ${selectedFacebookPageIds.length || "selected"} Page${selectedFacebookPageIds.length === 1 ? "" : "s"}`}</button></div>
      </form> : null}
      {accountFormOpen ? <form className="account-form panel" onSubmit={createAccount}>
        <div className="account-form-intro"><div><strong>Add a test or externally managed account</strong><p>This advanced path accepts only a protected secret reference. Never paste an access token.</p></div><ShieldCheck size={22} /></div>
        <div><label>Network<select name="platform" defaultValue="instagram"><option value="instagram">Instagram</option><option value="facebook">Facebook Page</option><option value="youtube">YouTube Shorts</option></select></label><label>Account name<input name="displayName" required maxLength={100} placeholder="Main newsroom account" /></label></div>
        <div><label>Provider account ID<input name="externalAccountId" required maxLength={180} placeholder="ID from the provider" /></label><label>Protected credential reference<input name="credentialRef" maxLength={240} placeholder="env:INSTAGRAM_MAIN_CREDENTIAL" pattern="(env|vault|secret):[A-Za-z0-9._:/-]+" /></label></div>
        <div><label>Access expiry<input name="expiresAt" type="datetime-local" /></label><label className="account-check"><input name="permissionsGranted" type="checkbox" /> Provider granted profile and publishing access</label></div>
        <div className="media-actions"><p>You can save an incomplete setup. Connection Doctor will show what is missing.</p><button className="new-button"><Cable size={15} /> Save and check</button></div>
      </form> : null}
      <div className="module-list panel channel-accounts" aria-label="Provider access">
        <div className="module-list-head"><div><h2>Provider access</h2><p>One authorization can safely own several publishing accounts. Provider authorizations and credentials are never shared between workspaces.</p></div><span>{loading ? "Loading…" : `${providerGrants.length} authorization${providerGrants.length === 1 ? "" : "s"}`}</span></div>
        {providerGrants.map((grant) => {
          const presentation = providerGrantPresentation(grant);
          const linkedAccounts = grant.accountIds.flatMap((id) => { const account = connectedAccounts.find((candidate) => candidate.id === id); return account ? [account] : []; });
          return <article className="channel-account" key={grant.id} id={`provider-grant-${grant.id}`} tabIndex={-1}>
            <div className="channel-account-head"><span className={`connection-health ${presentation.readiness}`}><ShieldCheck size={18} /></span><div><strong>{grant.provider === "meta" ? "Meta access" : "Google access"}</strong><p>{grant.authorizationKind === "instagram_login" ? "Instagram Login" : grant.authorizationKind === "facebook_login" ? "Facebook Login" : "Google OAuth"} · {linkedAccounts.length} linked account{linkedAccounts.length === 1 ? "" : "s"}</p><span className="account-capabilities">{grant.scopes.length ? `${grant.scopes.length} approved scope${grant.scopes.length === 1 ? "" : "s"}` : "No active provider scopes"}</span></div><em className={`account-status ${presentation.readiness === "healthy" ? "healthy" : presentation.readiness === "warning" ? "expiring" : "setup_required"}`}>{presentation.label}</em></div>
            <div className="connection-checks"><div className={presentation.readiness === "healthy" ? "pass" : presentation.readiness === "warning" ? "warn" : "fail"}><span>{presentation.readiness === "healthy" ? <Check size={13} /> : <AlertTriangle size={13} />}</span><p><strong>Authorization health</strong><small>{grant.lastErrorSummary ?? presentation.detail}</small></p></div>{linkedAccounts.map((account) => <div className={account.status === "healthy" ? "pass" : account.status === "expiring" ? "warn" : "fail"} key={account.id}><span>{account.status === "healthy" ? <Check size={13} /> : <AlertTriangle size={13} />}</span><p><strong>{account.displayName}</strong><small>{platformLabel(account.platform)} · {account.status.replaceAll("_", " ")}</small></p></div>)}</div>
            <div className="channel-account-foot"><small>{grant.lastCheckedAt ? `Checked ${new Date(grant.lastCheckedAt).toLocaleString()}` : `Connected ${new Date(grant.updatedAt).toLocaleString()}`}</small><span>{grant.nextValidationAt ? `Next check ${new Date(grant.nextValidationAt).toLocaleString()}` : "Automatic checks paused"}</span></div>
          </article>;
        })}
        {!loading && providerGrants.length === 0 ? <div className="module-empty"><ShieldCheck size={24} /><strong>No managed provider authorizations yet</strong><p>New OAuth connections appear here. Existing test or legacy accounts remain visible under Account health.</p></div> : null}
      </div>
      <PostingQueueProfilePanel auth={auth} workspaceId={workspaceId} brandId={activeBrandId} accounts={connectedAccounts.map(({ id, platform, displayName, status }) => ({ id, platform, displayName, status }))} />
      <div className="module-list panel channel-accounts">
        <div className="module-list-head"><div><h2>Account health</h2><p>Identity, publishing access, expiry, and the exact step that needs attention.</p></div><span>{loading ? "Loading…" : `${connectedAccounts.length} account${connectedAccounts.length === 1 ? "" : "s"}`}</span></div>
        {connectedAccounts.map((account) => {
          const status = connectedAccountStatusPresentation(account.status, account.diagnostic.readiness);
          return <article className="channel-account" key={account.id}>
          <div className="channel-account-head"><span className={`connection-health ${account.diagnostic.readiness}`}>{account.platform === "instagram" ? <Camera size={18} /> : account.platform === "facebook" ? <Share2 size={18} /> : <Play size={19} fill="currentColor" />}</span><div><strong>{account.displayName}</strong><p>{platformLabel(account.platform)} · {platformAccountKind(account.platform)} ID {account.externalAccountId}</p><span className="account-capabilities">{account.capabilities.length ? account.capabilities.map((capability) => capability.replaceAll("_", " ")).join(" · ") : "No publishing permissions yet"}</span></div><em className={`account-status ${status.className}`}>{status.label}</em></div>
          <div className="connection-checks">{account.platform === "instagram" ? <InstagramStoryCapabilityCheck capability={account.instagramStory} /> : null}{account.diagnostic.checks.map((check) => <div className={check.status} key={check.id}><span>{check.status === "pass" ? <Check size={13} /> : <AlertTriangle size={13} />}</span><p><strong>{check.label}</strong><small>{check.detail}</small>{check.action ? <b>{check.action}</b> : null}</p></div>)}</div>
          {account.platform === "youtube" && account.credentialManaged && account.status === "disconnected" && account.lastErrorCode === "provider_revocation_pending" ? <div className="provider-revocation-note" role="status"><ShieldCheck size={15} /><p><strong>Local publishing is blocked</strong><small>Google access could not be revoked yet. Retry the provider cleanup when Google is available.</small></p></div> : null}
          <div className="channel-account-foot"><small>Checked {new Date(account.lastCheckedAt ?? account.diagnostic.checkedAt).toLocaleString()}</small>{canManageChannels ? <div><button onClick={() => void checkAccount(account)}><RefreshCw size={13} /> Check again</button>{account.platform !== "youtube" && account.credentialManaged && account.status !== "disconnected" ? <button onClick={() => void refreshAccount(account)}><RotateCcw size={13} /> Renew Meta access</button> : null}{account.platform === "youtube" && account.credentialManaged && account.status === "disconnected" && account.lastErrorCode === "provider_revocation_pending" ? <button className="disconnect-button" onClick={() => void disconnectAccount(account)}><RotateCcw size={13} /> Retry Google revoke</button> : account.status !== "disconnected" ? <button className="disconnect-button" onClick={() => void disconnectAccount(account)}>Remove account</button> : null}</div> : <span>Owner action required</span>}</div>
        </article>;
        })}
        {!loading && connectedAccounts.length === 0 ? <div className="module-empty"><Cable size={24} /><strong>No publishing accounts yet</strong><p>Use one of the connect cards above. OriginPost will check the account before any post is queued.</p></div> : null}
      </div>
      <div className="module-list-head connector-section-head"><div><h2>Installed connectors</h2><p>Safe adapter boundaries for each network.</p></div></div>
      <div className="connector-grid">{connectors.map((connector) => <article className="connector-card panel" key={connector.id}>
      <div className="connector-title"><span><Cable size={18} /></span><div><h2>{connector.name}</h2><p>{connector.platform} connector</p></div><em>{connector.apiMode}</em></div>
      <div className="capability-list"><p><Check size={14} /> {connector.capabilities.formats.join(", ")}</p><p className={!connector.capabilities.analytics ? "muted-capability" : ""}><Check size={14} /> {connector.capabilities.analytics ? "Analytics available" : "Analytics not available"}</p><p className={!connector.capabilities.tokenRefresh ? "muted-capability" : ""}><Check size={14} /> Token refresh</p></div>
      <div className="connector-foot"><span>{connector.limits.maxMedia} media max</span><span>{connector.limits.captionCharacters.toLocaleString()} caption characters</span></div>
    </article>)}</div></> : null}

    {module === "plugins" ? <>
      <AgentRuntimeSettings auth={auth} workspaceId={workspaceId} brandId={activeBrandId} />
      <div className="module-list panel">
        <div className="module-list-head"><div><h2>Local plugin catalog</h2><p>OriginPost validates manifests and shows requested access. Plugin code is not loaded by this screen.</p></div><span>{loading ? "Loading…" : `${pluginCatalog?.entries.length ?? 0} available`}</span></div>
        {!loading && pluginCatalog?.entries.length === 0 ? <div className="module-empty"><Bot size={22} /><strong>No valid local plugins found</strong><p>Add a signed or reviewed plugin folder to the configured server directory. Invalid manifests stay disabled.</p></div> : null}
        {pluginCatalog?.rejected.length ? <div className="module-alert" role="status"><AlertTriangle size={15} /> {pluginCatalog.rejected.length} plugin manifest{pluginCatalog.rejected.length === 1 ? " was" : "s were"} rejected and kept disabled.</div> : null}
      </div>
      <div className="connector-grid">{pluginCatalog?.entries.map((plugin) => <article className="connector-card panel" key={plugin.id}>
        <div className="connector-title"><span><Bot size={18} /></span><div><h2>{plugin.name}</h2><p>{plugin.description}</p></div><em>{plugin.status}</em></div>
        <div className="capability-list"><p><ShieldCheck size={14} /> {plugin.permissions.length ? plugin.permissions.map((permission) => permission.replaceAll(":", " ")).join(" · ") : "No permissions requested"}</p><p><Check size={14} /> OriginPost {plugin.compatibility.originpost}</p><p className={plugin.networkAllowlist.length ? "" : "muted-capability"}><Cable size={14} /> {plugin.networkAllowlist.length ? `${plugin.networkAllowlist.length} network origin${plugin.networkAllowlist.length === 1 ? "" : "s"}` : "No network access"}</p></div>
        <div className="connector-foot"><span>{plugin.id}</span><span>v{plugin.version}</span></div>
      </article>)}</div>
      <div className="connector-grid">
      <article className="connector-card panel"><div className="connector-title"><span><Bot size={18} /></span><div><h2>External research runtime</h2><p>Optional source-research provider</p></div><em>{agentStatus?.hermes.configured ? "configured" : "optional"}</em></div><div className="capability-list"><p><Check size={14} /> Source research seam</p><p><Check size={14} /> Workspace session keys</p><p><Check size={14} /> Separate from Board intelligence</p></div><div className="connector-foot"><span>{agentStatus?.hermes.healthy ? "Healthy" : "Not connected"}</span><span>Replaceable provider</span></div></article>
      <article className="connector-card panel"><div className="connector-title"><span><ShieldCheck size={18} /></span><div><h2>Safe local provider</h2><p>Development sourcing module</p></div><em className="active-plugin">active</em></div><div className="capability-list"><p><Check size={14} /> No external keys</p><p><Check size={14} /> Test-only source records</p><p><Check size={14} /> Same provider contract</p></div><div className="connector-foot"><span>Mode: {agentStatus?.sourcing.mode ?? "mock"}</span><span>{agentStatus?.sourcing.ready ? "Ready" : "Unavailable"}</span></div></article>
    </div></> : null}
  </section>;
}

type MediaAsset = {
  id: string;
  version: number;
  kind: "image" | "video" | "audio" | "document";
  purpose: "creative" | "evidence" | "source";
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  status: "pending" | "ready" | "rejected" | "trashed" | "expired" | "deleted" | "cleanup_failed";
  rights: "unknown" | "reference-only" | "cleared" | "owned";
  altText?: string;
  lastError?: string;
  createdAt: string;
  uploadExpiresAt: string;
  trashExpiresAt?: string;
  cleanupAfter?: string;
  cleanupAttempts?: number;
  deletedAt?: string;
  inspectionStatus?: "pending" | "ready" | "unavailable" | "failed" | "not_applicable";
  malwareScanStatus?: "pending" | "clean" | "infected" | "unavailable" | "disabled";
  malwareScannedAt?: string;
  malwareThreatName?: string;
  malwareScanErrorSummary?: string;
  widthPixels?: number;
  heightPixels?: number;
  durationMs?: number;
  detectedContentType?: string;
  inspectedAt?: string;
  organization: { folderId?: string; tags: string[]; favorite: boolean; version: number; updatedAt?: string };
};

type MediaStorageSummary = { totalAssets: number; storedBytes: number; reclaimableBytes: number; pendingBytes: number; counts: Partial<Record<MediaAsset["status"], number>> };
type MediaView = "active" | "trash" | "history";
type MediaFolderView = { id: string; parentId?: string; name: string; version: number; directAssetCount: number; childFolderCount: number };

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function measuredMedia(asset: MediaAsset) {
  const dimensions = asset.widthPixels && asset.heightPixels ? `${asset.widthPixels}×${asset.heightPixels}` : "";
  const duration = typeof asset.durationMs === "number" ? `${(asset.durationMs / 1000).toFixed(asset.durationMs % 1000 ? 1 : 0)}s` : "";
  return [dimensions, duration].filter(Boolean).join(" · ");
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function kindFor(file: File): MediaAsset["kind"] | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type === "application/pdf") return "document";
  return null;
}

function MediaLibrary({ auth, workspaceId, brandId }: { auth: AuthView; workspaceId: string; brandId: string }) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [folders, setFolders] = useState<MediaFolderView[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [summary, setSummary] = useState<MediaStorageSummary>({ totalAssets: 0, storedBytes: 0, reclaimableBytes: 0, pendingBytes: 0, counts: {} });
  const [view, setView] = useState<MediaView>("active");
  const [folderFilter, setFolderFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [actingId, setActingId] = useState("");
  const [pendingTrashId, setPendingTrashId] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [folderFormOpen, setFolderFormOpen] = useState(false);
  const [pendingFolderDelete, setPendingFolderDelete] = useState("");
  const [error, setError] = useState("");
  const membership = auth.memberships.find((entry) => entry.workspaceId === workspaceId) ?? auth.memberships[0];
  const canManage = membership?.role === "owner" || membership?.role === "manager";
  const canUpload = canManage || membership?.role === "creator";

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
      const [assetsResponse, summaryResponse, foldersResponse] = await Promise.all([
        apiFetch(`/v1/media-assets/library?${query}&view=${view}&limit=200`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/media-assets/summary?${query}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/media-assets/folders?${query}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!assetsResponse.ok || !summaryResponse.ok || !foldersResponse.ok) throw new Error("Could not load the media library.");
      const page = await assetsResponse.json() as { items: Array<{ asset: Omit<MediaAsset, "organization">; organization: MediaAsset["organization"] }>; availableTags: string[] };
      setAssets(page.items.map((entry) => ({ ...entry.asset, organization: entry.organization })));
      setAvailableTags(page.availableTags);
      setSummary(await summaryResponse.json() as MediaStorageSummary);
      setFolders(await foldersResponse.json() as MediaFolderView[]);
      setSelectedAssetIds([]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the media library."); }
    finally { setLoading(false); }
  }, [auth.csrfToken, brandId, view, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  async function uploadMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) { setError("Choose a file first."); return; }
    const kind = kindFor(file);
    if (!kind) { setError("Use JPEG, PNG, WebP, GIF, MP4, MOV, WebM, MP3, WAV, or PDF."); return; }
    setUploading(true); setError("");
    try {
      const sha256 = await sha256Hex(file);
      const request = await apiFetch(`/v1/media-assets/uploads`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, brandId, kind, purpose: form.get("purpose"), fileName: file.name, contentType: file.type, sizeBytes: file.size, sha256, rights: form.get("rights"), altText: String(form.get("altText") ?? "").trim() || undefined }),
      }, auth.csrfToken);
      const created = await request.json() as { asset?: MediaAsset; upload?: { url: string; headers: Record<string, string> }; message?: string | string[] };
      if (!request.ok || !created.asset || !created.upload) throw new Error(Array.isArray(created.message) ? created.message.join(" ") : created.message ?? "Could not start the upload.");
      const uploaded = await fetch(created.upload.url, { method: "PUT", headers: created.upload.headers, body: file });
      if (!uploaded.ok) throw new Error("Private storage did not accept the file.");
      const completed = await apiFetch(`/v1/media-assets/${created.asset.id}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }, auth.csrfToken);
      if (!completed.ok) throw new Error("The uploaded file did not pass the size and hash check.");
      formElement.reset(); setFormOpen(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed."); }
    finally { setUploading(false); }
  }

  async function download(asset: MediaAsset) {
    const response = await apiFetch(`/v1/media-assets/${asset.id}/download-url?workspaceId=${encodeURIComponent(workspaceId)}`, {}, auth.csrfToken);
    if (!response.ok) { setError("Could not open this private file."); return; }
    const result = await response.json() as { url: string };
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function mutate(asset: MediaAsset, action: "trash" | "restore") {
    setActingId(asset.id); setError("");
    try {
      const response = await apiFetch(`/v1/media-assets/${asset.id}/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, version: asset.version }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? `Could not ${action} this file.`);
      setPendingTrashId(""); await load();
    } catch (cause) { setPendingTrashId(""); setError(cause instanceof Error ? cause.message : `Could not ${action} this file.`); }
    finally { setActingId(""); }
  }

  async function runCleanup() {
    setActingId("cleanup"); setError("");
    try {
      const response = await apiFetch("/v1/media-assets/cleanup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not run cleanup.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not run cleanup."); }
    finally { setActingId(""); }
  }

  async function createFolderFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      const response = await apiFetch("/v1/media-assets/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, name: form.get("name"), ...(form.get("parentId") ? { parentId: form.get("parentId") } : {}) }) }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not create the folder.");
      formElement.reset(); setFolderFormOpen(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the folder."); }
  }

  async function renameFolder(folder: MediaFolderView) {
    const name = window.prompt("Rename this media folder", folder.name)?.trim();
    if (!name || name === folder.name) return;
    setError("");
    const response = await apiFetch(`/v1/media-assets/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, version: folder.version, name }) }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as { message?: string | string[] };
    if (!response.ok) { setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not rename the folder."); return; }
    await load();
  }

  async function deleteFolder(folder: MediaFolderView) {
    if (pendingFolderDelete !== folder.id) { setPendingFolderDelete(folder.id); return; }
    setError("");
    const response = await apiFetch(`/v1/media-assets/folders/${encodeURIComponent(folder.id)}?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&version=${folder.version}`, { method: "DELETE" }, auth.csrfToken);
    const body = await response.json().catch(() => ({})) as { message?: string | string[] };
    if (!response.ok) { setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not delete the folder."); setPendingFolderDelete(""); return; }
    if (folderFilter === folder.id) setFolderFilter("all"); setPendingFolderDelete(""); await load();
  }

  async function organizeAssets(selected: MediaAsset[], change: { folderId?: string | null; addTags?: string[]; removeTags?: string[]; favorite?: boolean }) {
    if (!selected.length) return;
    setActingId("organize"); setError("");
    try {
      const response = await apiFetch("/v1/media-assets/organize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, assets: selected.map((asset) => ({ assetId: asset.id, expectedVersion: asset.organization.version })), ...change }) }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not organize the selected files.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not organize the selected files."); }
    finally { setActingId(""); }
  }

  async function bulkOrganize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const folderValue = String(form.get("folder") ?? "unchanged"); const favoriteValue = String(form.get("favorite") ?? "unchanged");
    const addTags = parseMediaTagInput(String(form.get("addTags") ?? "")); const removeTags = parseMediaTagInput(String(form.get("removeTags") ?? ""));
    const change: { folderId?: string | null; addTags?: string[]; removeTags?: string[]; favorite?: boolean } = {};
    if (folderValue !== "unchanged") change.folderId = folderValue === "unfiled" ? null : folderValue;
    if (favoriteValue !== "unchanged") change.favorite = favoriteValue === "yes";
    if (addTags.length) change.addTags = addTags; if (removeTags.length) change.removeTags = removeTags;
    if (!Object.keys(change).length) { setError("Choose a folder, favorite state, or tag change first."); return; }
    await organizeAssets(assets.filter((asset) => selectedAssetIds.includes(asset.id)), change);
  }

  function toggleSelection(id: string) { setSelectedAssetIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]); }
  const orderedFolders = orderedMediaFolders(folders);

  const visibleAssets = assets.filter((asset) => view === "active"
    ? asset.status === "ready" || asset.status === "pending"
    : view === "trash" ? asset.status === "trashed" || asset.status === "cleanup_failed"
      : asset.status === "rejected" || asset.status === "expired" || asset.status === "deleted")
    .filter((asset) => mediaMatchesOrganizationFilters(asset, { search, folder: folderFilter, tag: tagFilter, kind: kindFilter }));
  const allVisibleSelected = visibleAssets.length > 0 && visibleAssets.every((asset) => selectedAssetIds.includes(asset.id));
  const activeCollectionLabel = folderFilter === "all" ? "All files" : folderFilter === "unfiled" ? "Unfiled" : folderFilter === "favorites" ? "Favorites" : folders.find((folder) => folder.id === folderFilter)?.name ?? "Files";

  function toggleVisibleSelection() {
    const visibleIds = new Set(visibleAssets.map((asset) => asset.id));
    setSelectedAssetIds((current) => allVisibleSelected ? current.filter((id) => !visibleIds.has(id)) : [...new Set([...current, ...visibleIds])]);
  }

  return <section className="module-page">
    <div className="module-hero media-library-hero"><div><p className="eyebrow">ASSET LIBRARY</p><h1>Files &amp; media</h1><p>Upload, find, organize, and reuse every source, proof, image, video, audio file, and document.</p></div><div className="module-actions"><button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>{canUpload ? <button className="new-button" onClick={() => setFormOpen((value) => !value)}><Upload size={15} /> Upload files</button> : null}</div></div>
    {error ? <div className="module-alert">{error}</div> : null}
    {formOpen ? <form className="media-upload panel" onSubmit={uploadMedia}>
      <label className="file-drop"><Upload size={22} /><strong>Choose an image, video, audio file, or PDF</strong><small>The file stays private. OriginPost checks its exact size and SHA-256 after upload.</small><input name="file" type="file" required accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/webm,application/pdf" /></label>
      <div><label>Use for<select name="purpose" defaultValue="creative"><option value="creative">Creative</option><option value="evidence">Evidence</option><option value="source">Source</option></select></label><label>Rights<select name="rights" defaultValue="owned"><option value="owned">Owned</option><option value="cleared">Cleared</option><option value="reference-only">Reference only</option><option value="unknown">Unknown</option></select></label></div>
      <label>Alt text<input name="altText" placeholder="Describe what is visible" maxLength={500} /></label>
      <div className="media-actions"><p>Reference-only files cannot be treated as cleared publishing media.</p><button className="new-button" disabled={uploading}>{uploading ? "Checking and uploading…" : "Upload privately"}</button></div>
    </form> : null}
    <div className="media-summary-grid" aria-label="Media storage summary">
      <article><span><HardDrive size={17} /></span><div><small>Used storage</small><strong>{formatBytes(summary.storedBytes)}</strong></div></article>
      <article><span><FileImage size={17} /></span><div><small>Ready files</small><strong>{summary.counts.ready ?? 0}</strong></div></article>
      <article><span><Trash2 size={17} /></span><div><small>In Trash</small><strong>{formatBytes(summary.reclaimableBytes)}</strong></div></article>
      <article><span><Clock3 size={17} /></span><div><small>Processing</small><strong>{formatBytes(summary.pendingBytes)}</strong></div></article>
    </div>
    <div className="media-toolbar"><div className="media-tabs" role="tablist" aria-label="Media views">{(["active", "trash", "history"] as MediaView[]).map((tab) => <button role="tab" aria-selected={view === tab} className={view === tab ? "active" : ""} key={tab} onClick={() => { setView(tab); setPendingTrashId(""); }}>{tab === "active" ? "Active" : tab === "trash" ? `Trash (${(summary.counts.trashed ?? 0) + (summary.counts.cleanup_failed ?? 0)})` : "History"}</button>)}</div>{canManage ? <button className="secondary-button" disabled={actingId === "cleanup"} onClick={() => void runCleanup()}><RefreshCw size={14} className={actingId === "cleanup" ? "spin" : ""} /> {actingId === "cleanup" ? "Cleaning…" : "Run cleanup"}</button> : null}</div>
    <div className="media-organizer-layout">
      <aside className="media-folder-panel panel" aria-label="Media folders">
        <div className="media-folder-head"><div><Folder size={17} /><strong>Folders</strong></div>{canUpload ? <button aria-label="Create media folder" onClick={() => setFolderFormOpen((value) => !value)}><FolderPlus size={15} /></button> : null}</div>
        {folderFormOpen ? <form className="media-folder-form" onSubmit={createFolderFromForm}><input name="name" required maxLength={80} placeholder="Folder name" aria-label="Folder name" /><select name="parentId" aria-label="Parent folder"><option value="">Top level</option>{orderedFolders.map((folder) => <option value={folder.id} key={folder.id}>{"— ".repeat(Math.min(folder.depth, 4))}{folder.name}</option>)}</select><div><button className="new-button">Create</button><button type="button" onClick={() => setFolderFormOpen(false)}>Cancel</button></div></form> : null}
        <nav className="media-folder-list">
          {[{ id: "all", name: "All files", icon: FileImage }, { id: "unfiled", name: "Unfiled", icon: Folder }, { id: "favorites", name: "Favorites", icon: Star }].map((item) => <button className={folderFilter === item.id ? "active" : ""} key={item.id} onClick={() => setFolderFilter(item.id)}><item.icon size={14} /><span>{item.name}</span></button>)}
          {orderedFolders.map((folder) => <div className={`media-folder-row ${folderFilter === folder.id ? "active" : ""}`} key={folder.id} style={{ paddingLeft: `${8 + Math.min(folder.depth, 4) * 14}px` }} onDragOver={(event) => { if (canUpload) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const asset = assets.find((entry) => entry.id === event.dataTransfer.getData("text/plain")); if (asset) void organizeAssets([asset], { folderId: folder.id }); }}>
            <button className="media-folder-select" onClick={() => setFolderFilter(folder.id)} title={`Show ${folder.name}`}><Folder size={14} /><span>{folder.name}</span><small>{folder.directAssetCount}</small></button>
            {canUpload ? <span className="media-folder-actions"><button aria-label={`Rename ${folder.name}`} onClick={() => void renameFolder(folder)}><Pencil size={12} /></button><button className={pendingFolderDelete === folder.id ? "danger-confirm" : ""} aria-label={pendingFolderDelete === folder.id ? `Confirm deleting ${folder.name}` : `Delete ${folder.name}`} onClick={() => void deleteFolder(folder)}><Trash2 size={12} /></button></span> : null}
          </div>)}
        </nav>
        <p className="media-folder-help">Drag one file onto a folder, or select many files and move them together.</p>
      </aside>
      <div className="media-library-main">
        <div className="media-filter-bar panel"><label><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files, alt text, or tags" aria-label="Search media" /></label><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} aria-label="Filter by media kind"><option value="">All types</option><option value="image">Images</option><option value="video">Videos</option><option value="audio">Audio</option><option value="document">Documents</option></select><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Filter by tag"><option value="">All tags</option>{availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></div>
        <div className="media-results-head">
          <div><strong>{activeCollectionLabel}</strong><span>{visibleAssets.length} {visibleAssets.length === 1 ? "file" : "files"}</span></div>
          {canUpload && visibleAssets.length ? <button type="button" onClick={toggleVisibleSelection}>{allVisibleSelected ? <X size={14} /> : <CheckSquare size={14} />}{allVisibleSelected ? "Clear selection" : "Select all"}</button> : null}
        </div>
        {canUpload && selectedAssetIds.length ? <form className="media-bulk-bar panel" onSubmit={bulkOrganize}><span><CheckSquare size={16} /><strong>{selectedAssetIds.length} selected</strong><button type="button" onClick={() => setSelectedAssetIds([])} aria-label="Clear media selection"><X size={13} /></button></span><select name="folder" defaultValue="unchanged" aria-label="Move selected files"><option value="unchanged">Keep folder</option><option value="unfiled">Move to Unfiled</option>{orderedFolders.map((folder) => <option key={folder.id} value={folder.id}>{"— ".repeat(Math.min(folder.depth, 4))}{folder.name}</option>)}</select><input name="addTags" placeholder="Add tags, comma separated" aria-label="Add tags" /><input name="removeTags" placeholder="Remove tags" aria-label="Remove tags" /><select name="favorite" defaultValue="unchanged" aria-label="Change favorite state"><option value="unchanged">Keep favorite</option><option value="yes">Mark favorite</option><option value="no">Remove favorite</option></select><button className="new-button" disabled={actingId === "organize"}>{actingId === "organize" ? "Applying…" : "Apply"}</button></form> : null}
        <div className="media-grid">
          {visibleAssets.map((asset) => <article className={`media-card panel media-card-${asset.status} ${selectedAssetIds.includes(asset.id) ? "selected" : ""}`} key={asset.id} draggable={canUpload} onDragStart={(event) => event.dataTransfer.setData("text/plain", asset.id)}>
            <div className="media-card-leading">
              <span className={`media-icon ${asset.status}`}>{asset.kind === "video" ? <FileVideo size={21} /> : asset.kind === "audio" ? <FileAudio size={21} /> : asset.kind === "document" ? <FileText size={21} /> : <FileImage size={21} />}</span>
              {canUpload ? <label className="media-select-check"><input type="checkbox" checked={selectedAssetIds.includes(asset.id)} onChange={() => toggleSelection(asset.id)} aria-label={`Select ${asset.fileName}`} /></label> : null}
            </div>
            <div className="media-card-copy"><div className="media-card-name"><strong title={asset.fileName}>{asset.fileName}</strong><span>{asset.kind}</span></div><p>{asset.purpose} · {formatBytes(asset.sizeBytes)}{measuredMedia(asset) ? ` · ${measuredMedia(asset)}` : ""}</p><small>{asset.rights.replace("-", " ")} · {asset.status.replace("_", " ")} · SHA {asset.sha256.slice(0, 10)}…</small>{asset.organization.tags.length ? <span className="media-tag-list">{asset.organization.tags.map((tag) => <button type="button" key={tag} onClick={() => setTagFilter(tag)}>#{tag}</button>)}</span> : null}{asset.malwareScanStatus === "clean" ? <em>Malware scan passed{asset.malwareScannedAt ? ` · ${new Date(asset.malwareScannedAt).toLocaleString()}` : ""}</em> : asset.malwareScanStatus === "pending" ? <em>Waiting for malware scan…</em> : asset.malwareScanStatus === "infected" ? <em>Quarantined{asset.malwareThreatName ? ` · ${asset.malwareThreatName}` : ""}</em> : asset.malwareScanStatus === "unavailable" ? <em>{asset.malwareScanErrorSummary ?? "Malware scan unavailable. This file cannot be published."}</em> : asset.malwareScanStatus === "disabled" ? <em>Malware scan disabled for this non-live runtime.</em> : null}{asset.inspectionStatus === "ready" ? <em>Server checked{asset.detectedContentType ? ` · ${asset.detectedContentType}` : ""}{asset.inspectedAt ? ` · ${new Date(asset.inspectedAt).toLocaleString()}` : ""}</em> : asset.inspectionStatus === "pending" ? <em>Checking trusted media details…</em> : asset.inspectionStatus === "failed" ? <em>Media inspection failed. Re-upload a valid file.</em> : asset.inspectionStatus === "unavailable" ? <em>Trusted measurements are unavailable for this older file.</em> : null}{asset.status === "pending" ? <em>Upload link ends {new Date(asset.uploadExpiresAt).toLocaleString()}</em> : null}{asset.trashExpiresAt ? <em>Can be restored until {new Date(asset.trashExpiresAt).toLocaleString()}</em> : null}{asset.cleanupAfter && asset.status === "cleanup_failed" ? <em>Cleanup retry {new Date(asset.cleanupAfter).toLocaleString()}</em> : null}{asset.lastError ? <em>{asset.lastError}</em> : null}</div>
            <div className="media-card-actions">{canUpload ? <button className={asset.organization.favorite ? "favorite" : ""} aria-label={asset.organization.favorite ? `Remove ${asset.fileName} from favorites` : `Mark ${asset.fileName} as favorite`} title="Favorite" onClick={() => void organizeAssets([asset], { favorite: !asset.organization.favorite })}><Star size={15} fill={asset.organization.favorite ? "currentColor" : "none"} /></button> : null}{asset.status === "ready" ? <button aria-label={`Download ${asset.fileName}`} title="Download" onClick={() => void download(asset)}><Download size={15} /></button> : null}{canManage && (asset.status === "ready" || asset.status === "pending") ? <button className={pendingTrashId === asset.id ? "danger-confirm" : ""} disabled={actingId === asset.id} aria-label={pendingTrashId === asset.id ? `Confirm moving ${asset.fileName} to Trash` : `Move ${asset.fileName} to Trash`} title={pendingTrashId === asset.id ? "Click again to confirm" : "Move to Trash"} onClick={() => pendingTrashId === asset.id ? void mutate(asset, "trash") : setPendingTrashId(asset.id)}><Trash2 size={15} /></button> : null}{canManage && asset.status === "trashed" ? <button disabled={actingId === asset.id} aria-label={`Restore ${asset.fileName}`} title="Restore" onClick={() => void mutate(asset, "restore")}><RotateCcw size={15} /></button> : null}</div>
          </article>)}
          {!loading && visibleAssets.length === 0 ? <div className="module-empty panel media-empty"><FileImage size={24} /><strong>{search || folderFilter !== "all" || tagFilter || kindFilter ? "No files match these filters" : view === "active" ? "No active media" : view === "trash" ? "Trash is empty" : "No cleanup history"}</strong><p>{search || folderFilter !== "all" || tagFilter || kindFilter ? "Try another folder, tag, type, or search phrase." : view === "active" ? "Upload a file to create the first private, checked asset." : view === "trash" ? "Files moved to Trash stay recoverable for seven days." : "Expired uploads and permanently removed files appear here."}</p></div> : null}
        </div>
      </div>
    </div>
  </section>;
}

type WorkspaceMember = { workspaceId: string; userId: string; email: string; displayName: string; role: "owner" | "manager" | "creator" | "viewer"; status: "active" | "disabled"; createdAt: string; updatedAt: string };
type WorkspaceInvitation = { id: string; workspaceId: string; workspaceName: string; email: string; role: WorkspaceMember["role"]; status: "pending" | "accepted" | "revoked" | "expired"; deliveryState: "link_ready"; expiresAt: string; invitedBy: string; createdAt: string; updatedAt: string; acceptedAt?: string; acceptedBy?: string; revokedAt?: string; revokedBy?: string };

function OrganizationModule({ auth, workspaceId, brands, onChanged }: { auth: AuthView; workspaceId: string; brands: BrandView[]; onChanged: (workspaceId?: string) => void | Promise<void> }) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(auth.mode === "sessions");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [inviteLinkMessage, setInviteLinkMessage] = useState("");
  const [error, setError] = useState("");
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [brandFormOpen, setBrandFormOpen] = useState(false);
  const currentMembership = auth.memberships.find((entry) => entry.workspaceId === workspaceId) ?? auth.memberships[0];
  const isOwner = currentMembership?.role === "owner";
  const isOperator = isOwner || currentMembership?.role === "manager";

  const load = useCallback(async () => {
    if (auth.mode !== "sessions") { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      if (!isOwner) { setMembers([]); setInvitations([]); return; }
      const [membersResponse, invitationsResponse] = await Promise.all([
        apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(workspaceInvitationsPath(workspaceId), { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!membersResponse.ok || !invitationsResponse.ok) { setError("Could not load workspace access."); return; }
      setMembers(await membersResponse.json() as WorkspaceMember[]);
      setInvitations(await invitationsResponse.json() as WorkspaceInvitation[]);
    } catch { setError("Could not reach the OriginPost API."); }
    finally { setLoading(false); }
  }, [auth.csrfToken, auth.mode, isOwner, workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setInviteLink(""); setInviteLinkMessage(""); setInviteOpen(false); }, [workspaceId]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await apiFetch(workspaceInvitationsPath(workspaceId), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), role: form.get("role"), expiresInDays: Number(form.get("expiresInDays")) }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { url?: string; message?: string | string[] };
      if (!response.ok) {
        setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not create this invitation."); return;
      }
      formElement.reset(); setInviteOpen(false); setInviteLink(body.url ?? ""); setInviteLinkMessage("Copy this link now. OriginPost will not show this exact link again."); await load();
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setInviteLinkMessage("Invitation link copied."); }
    catch { setInviteLinkMessage("Copy the link manually from the field."); }
  }

  async function resendInvitation(invitation: WorkspaceInvitation) {
    setError(""); setInviteLink(""); setInviteLinkMessage("");
    try {
      const response = await apiFetch(workspaceInvitationActionPath(workspaceId, invitation.id, "resend"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresInDays: 7 }) }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { url?: string; message?: string | string[] };
      if (!response.ok) { setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not renew this invitation."); return; }
      setInviteLink(body.url ?? ""); setInviteLinkMessage("The old link is invalid. Copy this replacement link now."); await load();
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function revokeInvitation(invitation: WorkspaceInvitation) {
    setError("");
    try {
      const response = await apiFetch(workspaceInvitationActionPath(workspaceId, invitation.id, "revoke"), { method: "POST" }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) { setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not revoke this invitation."); return; }
      setInviteLink(""); setInviteLinkMessage(""); await load();
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function changeRole(member: WorkspaceMember, role: WorkspaceMember["role"]) {
    setError("");
    try {
      const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(member.userId)}/role`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }),
      }, auth.csrfToken);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        setError(body.message ?? "Could not change this role."); return;
      }
      await load();
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await apiFetch("/v1/workspaces", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), defaultBrandName: form.get("defaultBrandName"), primaryLanguage: form.get("primaryLanguage"), timezone: form.get("timezone") }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { workspace?: { id: string }; message?: string | string[] };
      if (!response.ok || !body.workspace) { setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not create the workspace."); return; }
      formElement.reset(); setWorkspaceFormOpen(false); await onChanged(body.workspace.id);
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function createNewBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/brands`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), description: form.get("description"), primaryLanguage: form.get("primaryLanguage"), timezone: form.get("timezone") }),
      }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[] };
      if (!response.ok) { setError(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not create the brand."); return; }
      formElement.reset(); setBrandFormOpen(false); await onChanged();
    } catch { setError("Could not reach the OriginPost API."); }
  }

  async function archiveBrand(brand: BrandView) {
    if (!window.confirm(`Archive ${brand.name}? Its existing content stays in OriginPost.`)) return;
    setError("");
    const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/brands/${encodeURIComponent(brand.id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived" }),
    }, auth.csrfToken);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      setError(body.message ?? "Could not archive this brand."); return;
    }
    await onChanged();
  }

  const shownMembers = auth.mode === "sessions" ? members : [{ workspaceId, userId: auth.user.id, email: auth.user.email, displayName: auth.user.displayName, role: "owner" as const, status: "active" as const, createdAt: "", updatedAt: "" }];
  return <section className="module-page">
    <div className="module-hero"><div><p className="eyebrow">WORKSPACE MODULE</p><h1>Organization</h1><p>Keep brands, people, channels, approval rules, and agent access inside one workspace boundary.</p></div><div className="module-actions"><button className="secondary-button" onClick={() => setWorkspaceFormOpen((value) => !value)}><Building2 size={15} /> New workspace</button>{isOwner ? <button className="new-button" onClick={() => setBrandFormOpen((value) => !value)}><Plus size={15} /> Add brand</button> : null}{auth.mode === "sessions" && isOwner ? <button className="secondary-button" onClick={() => setInviteOpen((value) => !value)}><Users size={15} /> Invite member</button> : null}</div></div>
    {error ? <div className="module-alert">{error}</div> : null}
    {auth.mode === "single-user" ? <div className="module-alert neutral">Session login is off. Enable it in your self-hosted settings before adding team members.</div> : null}
    {workspaceFormOpen ? <form className="account-form panel" onSubmit={createWorkspace}><div className="account-form-intro"><div><strong>Create a separate workspace</strong><p>Content, media, channels, monitors, proof, and members stay isolated from this workspace.</p></div><Building2 size={22} /></div><div><label>Workspace name<input name="name" required minLength={2} maxLength={100} placeholder="Regional newsroom" /></label><label>First brand<input name="defaultBrandName" required minLength={2} maxLength={100} placeholder="Main publishing brand" /></label></div><div><label>Primary language<input name="primaryLanguage" defaultValue="English" required /></label><label>Time zone<input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} required /></label></div><div className="media-actions"><p>You become the owner. A default brand is created with the workspace.</p><button className="new-button">Create workspace</button></div></form> : null}
    {brandFormOpen ? <form className="account-form panel" onSubmit={createNewBrand}><div className="account-form-intro"><div><strong>Add a publishing brand</strong><p>Use this identity to separate its voice and content inside the active workspace.</p></div><Building2 size={22} /></div><div><label>Brand name<input name="name" required minLength={2} maxLength={100} /></label><label>Primary language<input name="primaryLanguage" defaultValue="English" required /></label></div><div><label>Time zone<input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} required /></label><label>Short description<input name="description" maxLength={500} /></label></div><div className="media-actions"><p>Brand slugs are generated safely from the name.</p><button className="new-button">Create brand</button></div></form> : null}
    {inviteOpen ? <form className="account-form panel" onSubmit={invite}><div className="account-form-intro"><div><strong>Invite a workspace member</strong><p>Create an expiring link bound to this exact workspace, email, and role.</p></div><ShieldCheck size={22} /></div><div><label>Email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label><label>Role<select name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="creator">Creator</option><option value="manager">Manager</option><option value="owner">Owner</option></select></label></div><div><label>Link expires<select name="expiresInDays" defaultValue="7"><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label></div><div className="media-actions"><p>OriginPost does not send email in this release. Copy the one-time link and share it through a trusted channel.</p><button className="new-button">Create invitation</button></div></form> : null}
    {inviteLink ? <div className="account-form panel" role="status"><div className="account-form-intro"><div><strong>Invitation link ready</strong><p>{inviteLinkMessage}</p></div><ShieldCheck size={22} /></div><label>One-time invitation link<input value={inviteLink} readOnly onFocus={(event) => event.currentTarget.select()} /></label><div className="media-actions"><p>The raw token exists only in this response and your browser memory.</p><button type="button" className="new-button" onClick={() => void copyInviteLink()}><Copy size={14} /> Copy link</button><button type="button" className="secondary-button" onClick={() => { setInviteLink(""); setInviteLinkMessage(""); }}>Hide link</button></div></div> : null}
    <div className="org-grid">
      <article className="org-card panel"><span className="org-mark">MW</span><div><p className="eyebrow">ACTIVE WORKSPACE</p><h2>{currentMembership?.workspaceName ?? "My workspace"}</h2><p>Self-hosted Community alpha</p></div><em>{currentMembership?.role ?? "owner"}</em></article>
      <article className="org-card panel"><span className="module-state online"><Users size={18} /></span><div><p className="eyebrow">ACCESS MODEL</p><h2>Simple team roles</h2><p>Owner, manager, creator, and viewer</p></div><em>4 roles</em></article>
      <article className="org-card panel"><span className="module-state"><Building2 size={18} /></span><div><p className="eyebrow">BRAND BOUNDARY</p><h2>Workspace scoped</h2><p>Content, monitors, channels, and proof stay separated.</p></div><em>Protected</em></article>
    </div>
    {isOperator ? <OperationsHealthPanel auth={auth} workspaceId={workspaceId} /> : null}
    <div className="module-list panel"><div className="module-list-head"><div><h2>Brands</h2><p>Publishing identities in the active workspace.</p></div><span>{brands.length} active</span></div>{brands.map((brand) => <article className="monitor-row" key={brand.id}><span className="org-mark small">{brand.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{brand.name}</strong><p>{brand.description || `${brand.primaryLanguage} publishing identity`}</p><small>{brand.slug} · {brand.timezone}</small></div><div className="monitor-time"><strong>{brand.primaryLanguage}</strong>{isOwner && brands.length > 1 ? <button onClick={() => void archiveBrand(brand)}>Archive</button> : <small>Active</small>}</div></article>)}</div>
    <div className="module-list panel"><div className="module-list-head"><div><h2>Members</h2><p>Current access for this self-hosted instance.</p></div><span>{loading ? "Loading…" : `${shownMembers.length} member${shownMembers.length === 1 ? "" : "s"}`}</span></div>{shownMembers.map((member) => <article className="monitor-row" key={member.userId}><span className="org-mark small">{member.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{member.displayName}</strong><p>{member.email}</p><small>{member.userId}</small></div><div className="monitor-time">{auth.mode === "sessions" && isOwner ? <select className="role-select" value={member.role} aria-label={`Role for ${member.displayName}`} onChange={(event) => void changeRole(member, event.target.value as WorkspaceMember["role"])}><option value="owner">Owner</option><option value="manager">Manager</option><option value="creator">Creator</option><option value="viewer">Viewer</option></select> : <strong>{member.role}</strong>}<small>{member.status}</small></div></article>)}</div>
    {auth.mode === "sessions" && isOwner ? <div className="module-list panel"><div className="module-list-head"><div><h2>Invitations</h2><p>Pending access and immutable acceptance history. Delivery is manual.</p></div><span>{invitations.filter((entry) => entry.status === "pending").length} pending</span></div>{invitations.length ? invitations.map((invitation) => <article className="monitor-row" key={invitation.id}><span className="org-mark small">{invitation.email.slice(0, 2).toUpperCase()}</span><div><strong>{invitation.email}</strong><p>{invitation.role} · {invitation.deliveryState === "link_ready" ? "manual link" : invitation.deliveryState}</p><small>{invitation.status === "pending" ? `Expires ${new Date(invitation.expiresAt).toLocaleString()}` : invitation.status}</small></div><div className="monitor-time"><strong>{invitation.status}</strong>{invitation.status === "pending" || invitation.status === "expired" ? <span className="media-actions"><button type="button" onClick={() => void resendInvitation(invitation)}>New link</button>{invitation.status === "pending" ? <button type="button" onClick={() => void revokeInvitation(invitation)}>Revoke</button> : null}</span> : null}</div></article>) : <div className="module-empty"><ShieldCheck size={22} /><strong>No invitations yet</strong><p>Create a time-limited link when someone needs workspace access.</p></div>}</div> : null}
  </section>;
}
