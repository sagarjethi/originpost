"use client";

import {
  Archive,
  AlertCircle,
  Bot,
  BarChart3,
  Blocks,
  Building2,
  CalendarDays,
  Cable,
  Check,
  CircleCheck,
  Clock3,
  Columns3,
  FileText,
  Home,
  Inbox,
  Library,
  KeyRound,
  Menu,
  MessagesSquare,
  MoreHorizontal,
  Newspaper,
  Palette,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Share2,
  Settings,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiBasePath, apiFetch, type AuthMode, type AuthView } from "@/lib/api-client";
import { WorkspaceModules, type BrandView, type WorkspaceModule } from "./workspace-modules";
import { YouTubePublishReview } from "./youtube-publish-review";
import { ContentStudio } from "./content-studio/content-studio";
import { ContentCalendar } from "./calendar/content-calendar";
import { NotificationActionCenter, type WorkspaceNotification } from "./notifications/notification-action-center";
import { externalPostIdPlaceholder, liveUrlPlaceholder, platformBadge, platformLabel } from "./platform-ui";

type Status = "inbox" | "researching" | "drafting" | "review" | "approved" | "scheduled" | "action_required" | "publishing" | "published" | "failed" | "archived";
const workspaceModuleRoutes: Record<WorkspaceModule, string> = {
  boards: "Boards", signals: "Signals", evergreen: "Reuse", analytics: "Analytics", engagement: "Engagement",
  automations: "Automations", batches: "Batches", organizations: "Organizations", channels: "Channels",
  plugins: "Agent plugins", library: "Library", creative: "Creative Studio", developer: "Developer API",
};

function workspaceModuleFromQuery(value: string | null): { module: WorkspaceModule; nav: string } | null {
  const module = value?.toLowerCase() as WorkspaceModule | undefined;
  return module && module in workspaceModuleRoutes ? { module, nav: workspaceModuleRoutes[module] } : null;
}
type ContentItem = {
  id: string;
  brandId?: string;
  version?: number;
  title: string;
  summary: string;
  status: Status;
  researchDepth: "quick" | "standard" | "deep";
  riskLevel: "low" | "medium" | "high" | "sensitive";
  tags?: string[];
  sources: Array<{ id: string; title: string; url?: string; publisher?: string; publishedAt?: string; confidence: number }>;
  claims: Array<{ id: string; text: string; status: string; sourceIds: string[] }>;
  researchRuns: Array<{
    id: string;
    query: string;
    status: "queued" | "running" | "completed" | "failed";
    provider?: string;
    toolsUsed: string[];
    sourceCount: number;
    claimCount: number;
    error?: string;
  }>;
  drafts: Array<{ id: string; revision?: number; contentSha256?: string; platform: string; format: string; title?: string; caption: string; mediaIds?: string[]; createdAt?: string }>;
  approvals: Array<{ id: string; draftId?: string; draftSha256?: string; decision: string; actorName: string; note?: string; createdAt?: string }>;
  targets: Array<{
    id: string;
    platform: string;
    accountId: string;
    draftId: string;
    deliveryMode?: "auto_publish" | "manual_handoff";
    status: string;
    scheduledFor: string;
    timezone?: string;
    actionRequiredAt?: string;
    acknowledgedAt?: string;
    acknowledgedBy?: string;
    settings?: { isAiGenerated?: boolean };
  }>;
  proofs: Array<{ id: string; platform: string; liveUrl: string; instagramAiDisclosure?: { requested: boolean; observed: boolean; label: "ai_info" } }>;
  reviewLinks?: Array<{ id: string; draftId: string; expiresAt: string; allowComment: boolean; revokedAt?: string }>;
  updatedAt: string;
};

class ApiRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function apiError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string | string[] };
  const message = Array.isArray(body.message) ? body.message.join(" ") : body.message ?? fallback;
  return new ApiRequestError(message, body.error);
}

function versionHeaders(item: ContentItem): Record<string, string> {
  return item.version ? { "if-match": String(item.version) } : {};
}

const fallbackItems: ContentItem[] = [
  {
    id: "demo-1",
    title: "Local climate update needs review",
    summary: "A monitored suggestion is waiting for a source and editor decision.",
    status: "researching",
    researchDepth: "standard",
    riskLevel: "medium",
    sources: [{ id: "s1", title: "Official weather bulletin", publisher: "Primary source", confidence: 92 }],
    claims: [], researchRuns: [],
    drafts: [],
    approvals: [],
    targets: [],
    proofs: [],
    updatedAt: new Date().toISOString(),
  },
  {
    id: "demo-2",
    title: "Product launch carousel",
    summary: "Instagram carousel prepared from the approved launch brief.",
    status: "review",
    researchDepth: "quick",
    riskLevel: "low",
    sources: [{ id: "s2", title: "Approved launch brief", publisher: "Internal", confidence: 100 }],
    claims: [], researchRuns: [],
    drafts: [{ id: "d1", platform: "instagram", format: "carousel", caption: "Launch caption ready for review." }],
    approvals: [],
    targets: [],
    proofs: [],
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "demo-3",
    title: "Founder interview short",
    summary: "One approved short is scheduled for tomorrow morning.",
    status: "scheduled",
    researchDepth: "standard",
    riskLevel: "low",
    sources: [{ id: "s3", title: "Recorded interview", publisher: "Owned media", confidence: 100 }],
    claims: [], researchRuns: [],
    drafts: [{ id: "d2", platform: "youtube", format: "short", caption: "Three lessons from the build." }],
    approvals: [{ id: "a1", decision: "approved", actorName: "Local Owner" }],
    targets: [{ id: "t1", platform: "youtube", accountId: "youtube-main", draftId: "d2", deliveryMode: "auto_publish", status: "queued", scheduledFor: new Date(Date.now() + 86400000).toISOString() }],
    proofs: [],
    updatedAt: new Date(Date.now() - 7200000).toISOString(),
  },
];

const nav = [
  { label: "Home", icon: Home },
  { label: "Boards", icon: Columns3 },
  { label: "Inbox", icon: Inbox },
  { label: "Research", icon: Search, count: 3 },
  { label: "Signals", icon: Radar },
  { label: "Create", icon: WandSparkles },
  { label: "Reuse", icon: RotateCcw },
  { label: "Calendar", icon: CalendarDays },
  { label: "Engagement", icon: MessagesSquare },
  { label: "Analytics", icon: BarChart3 },
  { label: "Library", icon: Library },
  { label: "Creative Studio", icon: Palette },
  { label: "Batches", icon: FileText },
  { label: "Proof", icon: ShieldCheck },
  { label: "Automations", icon: Zap },
  { label: "Organizations", icon: Building2 },
  { label: "Channels", icon: Cable },
  { label: "Agent plugins", icon: Blocks },
  { label: "Developer API", icon: KeyRound },
];

const statusLabel: Record<Status, string> = {
  inbox: "Inbox",
  researching: "Researching",
  drafting: "Drafting",
  review: "Needs approval",
  approved: "Approved",
  scheduled: "Scheduled",
  action_required: "Action required",
  publishing: "Publishing",
  published: "Published",
  failed: "Needs attention",
  archived: "Archived",
};

function timeAgo(value: string) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function OriginPostApp() {
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [auth, setAuth] = useState<AuthView | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [oidcConfig, setOidcConfig] = useState<{ enabled: boolean; displayName: string }>({ enabled: false, displayName: "Single sign-on" });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [activeBrandId, setActiveBrandId] = useState("");
  const [brands, setBrands] = useState<BrandView[]>([]);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [items, setItems] = useState<ContentItem[]>(fallbackItems);
  const [selectedId, setSelectedId] = useState(fallbackItems[0]!.id);
  const [filter, setFilter] = useState<"all" | "review" | "scheduled" | "action">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [connection, setConnection] = useState<"loading" | "api" | "demo">("loading");
  const [activeNav, setActiveNav] = useState("Home");
  const [activeModule, setActiveModule] = useState<WorkspaceModule | null>(null);
  const [creativeContentItemId, setCreativeContentItemId] = useState("");
  const [engagementUnreadCount, setEngagementUnreadCount] = useState(0);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffMessage, setHandoffMessage] = useState("");
  const [reviewShareUrl, setReviewShareUrl] = useState("");
  const [reviewShareBusy, setReviewShareBusy] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarWasOpen = useRef(false);

  function navigate(label: string) {
    setActiveNav(label);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (label === "Create") { setComposerOpen(true); return; }
    if (label === "Boards") { setActiveModule("boards"); return; }
    if (label === "Signals") { setActiveModule("signals"); return; }
    if (label === "Automations") { setActiveModule("automations"); return; }
    if (label === "Analytics") { setActiveModule("analytics"); return; }
    if (label === "Reuse") { setActiveModule("evergreen"); return; }
    if (label === "Engagement") { setActiveModule("engagement"); return; }
    if (label === "Library") { setActiveModule("library"); return; }
    if (label === "Creative Studio") { setActiveModule("creative"); return; }
    if (label === "Batches") { setActiveModule("batches"); return; }
    if (label === "Organizations") { setActiveModule("organizations"); return; }
    if (label === "Channels") { setActiveModule("channels"); return; }
    if (label === "Agent plugins") { setActiveModule("plugins"); return; }
    if (label === "Developer API") { setActiveModule("developer"); return; }
    setActiveModule(null);
    if (label === "Calendar") setFilter("scheduled");
    else if (label === "Inbox" || label === "Research" || label === "Proof" || label === "Home") setFilter("all");
  }

  async function openNotificationAction(notification: WorkspaceNotification) {
    if (notification.contentItemId) {
      await openContentItem(notification.contentItemId);
      return;
    }
    if (notification.actionUrl) {
      const target = new URL(notification.actionUrl, window.location.origin);
      if (target.origin === window.location.origin && target.searchParams.get("module") === "signals") { navigate("Signals"); return; }
    }
    if (notification.monitorId) { navigate("Automations"); return; }
    if (notification.accountId) { navigate("Channels"); return; }
    if (notification.targetId) { navigate("Calendar"); return; }
    if (notification.actionUrl) {
      const target = new URL(notification.actionUrl, window.location.origin);
      if (target.origin === window.location.origin) window.location.assign(`${target.pathname}${target.search}${target.hash}`);
      else window.open(target.toString(), "_blank", "noopener,noreferrer");
      return;
    }
    navigate("Home");
  }

  async function openContentItem(contentItemId: string) {
    await refresh();
    setSelectedId(contentItemId);
    setActiveNav("Home");
    setActiveModule(null);
    setFilter("all");
    setSearchQuery("");
    window.requestAnimationFrame(() => document.querySelector(".detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function refresh(activeAuth = auth, workspaceId = activeWorkspaceId || activeAuth?.memberships[0]?.workspaceId || "default", requestedBrandId = activeBrandId) {
    if (!activeAuth) return;
    try {
      const brandResponse = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/brands`, { cache: "no-store" }, activeAuth.csrfToken);
      if (!brandResponse.ok) throw new Error("Could not load workspace brands.");
      const availableBrands = await brandResponse.json() as BrandView[];
      const storedBrandId = typeof window === "undefined" ? "" : window.localStorage.getItem(`originpost:brand:${workspaceId}`) ?? "";
      const brandId = availableBrands.some((brand) => brand.id === requestedBrandId) ? requestedBrandId : availableBrands.some((brand) => brand.id === storedBrandId) ? storedBrandId : availableBrands[0]?.id ?? "";
      const response = await apiFetch(`/v1/content-items?workspaceId=${encodeURIComponent(workspaceId)}${brandId ? `&brandId=${encodeURIComponent(brandId)}` : ""}`, { cache: "no-store" }, activeAuth.csrfToken);
      if (response.status === 401 && activeAuth.mode === "sessions") { setAuth(null); return; }
      if (!response.ok) throw new Error("API unavailable");
      const data = await response.json() as ContentItem[];
      setActiveWorkspaceId(workspaceId);
      setBrands(availableBrands);
      setActiveBrandId(brandId);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("originpost:workspace", workspaceId);
        if (brandId) window.localStorage.setItem(`originpost:brand:${workspaceId}`, brandId);
      }
      setItems(data);
      setSelectedId((current) => data.some((item) => item.id === current) ? current : data[0]?.id ?? current);
      setConnection("api");
    } catch {
      if (activeAuth.mode === "sessions") setConnection("loading"); else setConnection("demo");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (new URLSearchParams(window.location.search).get("auth") === "error") setLoginError("Single sign-on could not be completed. Try again or contact your workspace owner.");
        const configResponse = await apiFetch("/v1/auth/config", { cache: "no-store" });
        if (!configResponse.ok) throw new Error("OriginPost API is unavailable.");
        const config = await configResponse.json() as { mode: AuthMode; oidc?: { enabled?: boolean; displayName?: string } };
        if (cancelled) return;
        setAuthMode(config.mode);
        setOidcConfig({ enabled: config.oidc?.enabled === true, displayName: config.oidc?.displayName?.trim() || "Single sign-on" });
        const meResponse = await apiFetch("/v1/auth/me", { cache: "no-store" });
        if (meResponse.ok) {
          const view = await meResponse.json() as AuthView;
          if (!cancelled) {
            setAuth(view);
            const stored = window.localStorage.getItem("originpost:workspace") ?? "";
            const workspaceId = view.memberships.some((membership) => membership.workspaceId === stored) ? stored : view.memberships[0]?.workspaceId ?? "default";
            await refresh(view, workspaceId, window.localStorage.getItem(`originpost:brand:${workspaceId}`) ?? "");
          }
        }
      } catch (error) {
        if (!cancelled) setLoginError(error instanceof Error ? error.message : "OriginPost API is unavailable.");
      } finally { if (!cancelled) setAuthLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setHandoffMessage(""); setReviewShareUrl(""); }, [selectedId]);
  useEffect(() => { setHandoffMessage(""); setReviewShareUrl(""); setComposerOpen(false); }, [activeWorkspaceId, activeBrandId]);
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("channel");
    if (result === "connected" || result === "error" || result === "select_facebook" || result === "select_instagram" || result === "select_meta_messaging") { setActiveNav("Channels"); setActiveModule("channels"); }
    const requestedModule = workspaceModuleFromQuery(new URLSearchParams(window.location.search).get("module"));
    if (requestedModule) { setActiveNav(requestedModule.nav); setActiveModule(requestedModule.module); }
    const contentItemId = new URLSearchParams(window.location.search).get("item")?.trim();
    if (contentItemId) { setSelectedId(contentItemId); setActiveNav("Home"); setActiveModule(null); setFilter("all"); }
  }, []);
  useEffect(() => {
    if (!auth || !activeWorkspaceId || !activeBrandId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const response = await apiFetch(`/v1/engagement?workspaceId=${encodeURIComponent(activeWorkspaceId)}&brandId=${encodeURIComponent(activeBrandId)}&state=open&limit=100`, { cache: "no-store" }, auth.csrfToken);
        if (!response.ok) return;
        const data = await response.json() as { items?: Array<{ unreadCount?: number }> };
        if (!cancelled) setEngagementUnreadCount((data.items ?? []).reduce((sum, item) => sum + (item.unreadCount ?? 0), 0));
      } catch { /* Engagement is optional until an Instagram account is connected. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeBrandId, activeWorkspaceId, auth]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sync = () => setMobileSidebar(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!mobileSidebar) return;
    if (sidebarOpen) sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (sidebarWasOpen.current) menuButtonRef.current?.focus();
    sidebarWasOpen.current = sidebarOpen;
  }, [mobileSidebar, sidebarOpen]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const hasActiveResearch = items.some((item) => item.researchRuns?.some((run) => run.status === "queued" || run.status === "running"));
  useEffect(() => {
    if (!hasActiveResearch) return;
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveResearch]);

  const visible = useMemo(() => items.filter((item) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (query) {
      const searchable = [item.title, item.summary, ...item.sources.flatMap((source) => [source.title, source.publisher ?? ""]), ...item.proofs.map((proof) => proof.liveUrl)].join(" ").toLocaleLowerCase();
      if (!searchable.includes(query)) return false;
    }
    if (filter === "review") return item.status === "review";
    if (filter === "scheduled") return item.status === "scheduled" || item.status === "publishing";
    if (filter === "action") return item.status === "action_required";
    return item.status !== "archived";
  }), [filter, items, searchQuery]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const youtubeDraft = selected?.drafts.filter((draft) => draft.platform === "youtube").at(-1);
  const recentResearch = selected?.researchRuns?.at(-1);
  const reviewCount = items.filter((item) => item.status === "review").length;
  const scheduledCount = items.filter((item) => item.status === "scheduled").length;
  const actionCount = items.filter((item) => item.status === "action_required").length;
  const manualTarget = selected?.targets.find((target) => target.deliveryMode === "manual_handoff" && (target.status === "action_required" || target.status === "acknowledged"));
  const manualDraft = manualTarget ? selected?.drafts.find((draft) => draft.id === manualTarget.draftId) : undefined;
  const providerReviewTarget = selected?.targets.find((target) => target.deliveryMode === "auto_publish" && ["instagram", "facebook", "youtube"].includes(target.platform) && target.status === "action_required");
  const manualAiDisclosureRequested = manualTarget?.platform === "instagram" && manualTarget.settings?.isAiGenerated === true;
  const providerAiDisclosureRequested = providerReviewTarget?.platform === "instagram" && providerReviewTarget.settings?.isAiGenerated === true;
  const providerReviewPlatform = platformLabel(providerReviewTarget?.platform ?? "");
  const manualPlatform = platformLabel(manualTarget?.platform ?? "");
  const sourcePublishers = new Set(selected?.sources.map((source) => source.publisher?.trim()).filter(Boolean));
  const supportedClaims = selected?.claims.filter((claim) => claim.status === "supported").length ?? 0;
  const crossCheckLabel = (selected?.sources.length ?? 0) >= 2 && sourcePublishers.size >= 2 && supportedClaims > 0 ? "Cross-checked" : (selected?.sources.length ?? 0) >= 2 ? "Check the claims" : "Needs a second source";
  const newestSourceDate = selected?.sources.map((source) => source.publishedAt ? new Date(source.publishedAt).getTime() : 0).filter(Boolean).sort((a, b) => b - a)[0];

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoginBusy(true); setLoginError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await apiFetch("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
      if (!response.ok) throw await apiError(response, "Could not sign in.");
      const view = { ...(await response.json() as Omit<AuthView, "mode">), mode: "sessions" as const };
      const stored = window.localStorage.getItem("originpost:workspace") ?? "";
      const workspaceId = view.memberships.some((membership) => membership.workspaceId === stored) ? stored : view.memberships[0]?.workspaceId ?? "default";
      setAuth(view); await refresh(view, workspaceId, window.localStorage.getItem(`originpost:brand:${workspaceId}`) ?? "");
    } catch (error) { setLoginError(error instanceof Error ? error.message : "Could not sign in."); }
    finally { setLoginBusy(false); }
  }

  async function signOut() {
    if (!auth) return;
    await apiFetch("/v1/auth/logout", { method: "POST" }, auth.csrfToken);
    setAuth(null); setItems([]); setActiveModule(null);
  }

  async function switchWorkspace(workspaceId: string) {
    if (!auth || workspaceId === activeWorkspaceId) return;
    setConnection("loading"); setItems([]); setSelectedId(""); setActiveWorkspaceId(workspaceId); setActiveBrandId(""); setBrands([]);
    await refresh(auth, workspaceId, "");
  }

  async function switchBrand(brandId: string) {
    if (!auth || !activeWorkspaceId || brandId === activeBrandId) return;
    setConnection("loading"); setItems([]); setSelectedId(""); setActiveBrandId(brandId);
    await refresh(auth, activeWorkspaceId, brandId);
  }

  async function reloadOrganization(preferredWorkspaceId?: string) {
    if (!auth) return;
    const response = await apiFetch("/v1/auth/me", { cache: "no-store" }, auth.csrfToken);
    if (!response.ok) return;
    const view = await response.json() as AuthView;
    setAuth(view);
    const workspaceId = preferredWorkspaceId && view.memberships.some((membership) => membership.workspaceId === preferredWorkspaceId) ? preferredWorkspaceId : activeWorkspaceId;
    await refresh(view, workspaceId || view.memberships[0]?.workspaceId || "default", preferredWorkspaceId ? "" : activeBrandId);
  }

  async function acknowledgeHandoff() {
    if (!selected || !manualTarget) return;
    setHandoffBusy(true);
    setHandoffMessage("");
    try {
      const response = await apiFetch(`/v1/content-items/${selected.id}/targets/${manualTarget.id}/acknowledge?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, { method: "POST", headers: versionHeaders(selected) }, auth?.csrfToken);
      if (!response.ok) throw await apiError(response, "Could not acknowledge this handoff.");
      const updated = await response.json() as ContentItem;
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setHandoffMessage(`Handoff accepted. Post it on ${manualPlatform}, then save the live link below.`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "content_version_conflict") await refresh();
      setHandoffMessage(error instanceof Error ? error.message : "Could not acknowledge this handoff.");
    } finally {
      setHandoffBusy(false);
    }
  }

  async function confirmManualPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !manualTarget) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const liveUrl = String(form.get("liveUrl") ?? "").trim();
    const externalPostId = String(form.get("externalPostId") ?? "").trim();
    setHandoffBusy(true);
    setHandoffMessage("");
    try {
      const response = await apiFetch(`/v1/content-items/${selected.id}/targets/${manualTarget.id}/manual-confirm?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders(selected) },
        body: JSON.stringify({ liveUrl, externalPostId, publishedAt: new Date().toISOString(), disclosure: manualAiDisclosureRequested && form.get("aiDisclosureObserved") === "yes" ? "ai-assisted" : "none" }),
      }, auth?.csrfToken);
      if (!response.ok) {
        throw await apiError(response, "Could not save publish proof.");
      }
      const updated = await response.json() as ContentItem;
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setHandoffMessage("Published and saved with proof.");
      formElement.reset();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "content_version_conflict") await refresh();
      setHandoffMessage(error instanceof Error ? error.message : "Could not save publish proof.");
    } finally {
      setHandoffBusy(false);
    }
  }

  async function confirmProviderPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !providerReviewTarget) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setHandoffBusy(true);
    setHandoffMessage("");
    try {
      const response = await apiFetch(`/v1/content-items/${selected.id}/targets/${providerReviewTarget.id}/provider-confirm?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders(selected) },
        body: JSON.stringify({ liveUrl: String(form.get("liveUrl") ?? "").trim(), externalPostId: String(form.get("externalPostId") ?? "").trim(), publishedAt: new Date().toISOString(), disclosure: providerAiDisclosureRequested ? "ai-assisted" : "none" }),
      }, auth?.csrfToken);
      if (!response.ok) throw await apiError(response, "Could not save recovered publish proof.");
      const updated = await response.json() as ContentItem;
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setHandoffMessage(`${providerReviewPlatform} result checked and saved with proof.`);
      formElement.reset();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "content_version_conflict") await refresh();
      setHandoffMessage(error instanceof Error ? error.message : "Could not save recovered publish proof.");
    } finally {
      setHandoffBusy(false);
    }
  }

  async function createReviewShare() {
    const draft = selected?.drafts.at(-1);
    if (!selected || !draft) return;
    setReviewShareBusy(true);
    try {
      const response = await apiFetch(`/v1/content-items/${selected.id}/review-links?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders(selected) },
        body: JSON.stringify({ draftId: draft.id, expiresInHours: 72, allowComment: true }),
      }, auth?.csrfToken);
      if (!response.ok) throw await apiError(response, "Could not create a review link.");
      const result = await response.json() as { url: string };
      setReviewShareUrl(result.url);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "content_version_conflict") await refresh();
      setReviewShareUrl(error instanceof Error ? error.message : "Could not create a review link.");
    } finally {
      setReviewShareBusy(false);
    }
  }

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const summary = String(form.get("summary") ?? "").trim();
    const researchNow = form.get("researchNow") === "on";
    if (!title) return;
    try {
      const response = await apiFetch(`/v1/content-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: activeWorkspaceId, brandId: activeBrandId, title, summary, researchDepth: "standard", riskLevel: "low" }),
      }, auth?.csrfToken);
      if (!response.ok) throw new Error("Create failed");
      let item = await response.json() as ContentItem;
      if (researchNow) {
        const researchResponse = await apiFetch(`/v1/content-items/${item.id}/research?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...versionHeaders(item) },
          body: JSON.stringify({ query: title, depth: "standard", languages: ["English", "Gujarati", "Hindi"], region: "India", sourceLimit: 8, freshnessHours: 168 }),
        }, auth?.csrfToken);
        if (!researchResponse.ok) throw await apiError(researchResponse, "Research could not start");
        item = await researchResponse.json() as ContentItem;
      }
      setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
      setSelectedId(item.id);
      setConnection("api");
    } catch {
      const item: ContentItem = {
        id: `local-${Date.now()}`,
        title,
        summary,
        status: "inbox",
        researchDepth: "standard",
        riskLevel: "low",
        sources: [], claims: [], researchRuns: [], drafts: [], approvals: [], targets: [], proofs: [],
        updatedAt: new Date().toISOString(),
      };
      setItems((current) => [item, ...current]);
      setSelectedId(item.id);
      setConnection("demo");
    }
    setComposerOpen(false);
  }

  async function researchItem(item: ContentItem) {
    try {
      const response = await apiFetch(`/v1/content-items/${item.id}/research?workspaceId=${encodeURIComponent(activeWorkspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders(item) },
        body: JSON.stringify({ query: item.title, depth: item.researchDepth, languages: ["English", "Gujarati", "Hindi"], region: "India", sourceLimit: 8, freshnessHours: 168 }),
      }, auth?.csrfToken);
      if (!response.ok) throw await apiError(response, "Research could not start");
      const updated = await response.json() as ContentItem;
      setItems((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setConnection("api");
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "content_version_conflict") {
        await refresh();
        return;
      }
      setConnection("demo");
    }
  }

  if (authLoading) return <main className="login-shell"><section className="login-card panel"><div className="brand-mark"><span>O</span></div><h1>Opening OriginPost…</h1><p>Checking your private self-hosted workspace.</p></section></main>;
  if (!auth && authMode === "sessions") return <main className="login-shell"><form className="login-card panel" onSubmit={signIn}><div className="brand-mark"><span>O</span></div><p className="eyebrow">SELF-HOSTED WORKSPACE</p><h1>Sign in to OriginPost</h1><p>Use the account created by your workspace owner.</p>{loginError ? <div className="module-alert">{loginError}</div> : null}{oidcConfig.enabled ? <a className="secondary-button" href={`${apiBasePath}/auth/oidc/start`}>Continue with {oidcConfig.displayName}</a> : null}<label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required minLength={12} /></label><button className="new-button" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in with password"}</button></form></main>;
  if (!auth) return <main className="login-shell"><section className="login-card panel"><div className="brand-mark"><span>O</span></div><h1>OriginPost is unavailable</h1><p>{loginError || "Check that the API is running."}</p></section></main>;

  const activeMembership = auth.memberships.find((membership) => membership.workspaceId === activeWorkspaceId) ?? auth.memberships[0];
  const activeBrand = brands.find((brand) => brand.id === activeBrandId) ?? brands[0];
  return (
    <div className="app-shell">
      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`} aria-hidden={mobileSidebar && !sidebarOpen} inert={mobileSidebar && !sidebarOpen}>
        <div className="brand-row">
          <div className="brand-mark"><span>O</span></div>
          <div><strong>OriginPost</strong><small>Source to proof</small></div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close menu"><X size={18} /></button>
        </div>

        <div className="workspace-switcher">
          <span className="workspace-avatar">{(activeMembership?.workspaceName ?? "Workspace").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
          <span className="workspace-picker"><label><span className="sr-only">Active workspace</span><select value={activeWorkspaceId} onChange={(event) => void switchWorkspace(event.target.value)}>{auth.memberships.map((membership) => <option value={membership.workspaceId} key={membership.workspaceId}>{membership.workspaceName}</option>)}</select></label><label><span className="sr-only">Active brand</span><select value={activeBrandId} onChange={(event) => void switchBrand(event.target.value)} disabled={!brands.length}>{brands.map((brand) => <option value={brand.id} key={brand.id}>{brand.name}</option>)}</select></label></span>
        </div>

        <nav className="main-nav" aria-label="Primary navigation">
          {nav.map(({ label, icon: Icon, count }) => {
            const badge = label === "Engagement" ? engagementUnreadCount : count;
            return (
            <button key={label} className={activeNav === label ? "nav-item active" : "nav-item"} onClick={() => navigate(label)} aria-current={activeNav === label ? "page" : undefined}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>
              {badge ? <em>{badge > 99 ? "99+" : badge}</em> : null}
            </button>
          )})}
        </nav>

        <div className="sidebar-bottom">
          <div className="safety-card">
            <span><ShieldCheck size={18} /> Safe test mode</span>
            <p>Real publishing is switched off.</p>
          </div>
          <button className="nav-item" disabled title="Settings are not available yet"><Settings size={18} /><span>Settings</span></button>
          {auth.mode === "sessions" ? <button className="user-row" onClick={() => void signOut()} aria-label={`Sign out ${auth.user.displayName}`}><span>{auth.user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{auth.user.displayName}</strong><small>{activeMembership?.role ?? "owner"} · Sign out</small></div><MoreHorizontal size={17} /></button> : <div className="user-row user-row-static"><span>{auth.user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{auth.user.displayName}</strong><small>{activeMembership?.role ?? "owner"}</small></div></div>}
        </div>
      </aside>

      {sidebarOpen ? <button className="scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} /> : null}

      <main className="main-area">
        <header className="topbar">
          <button ref={menuButtonRef} className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open menu" aria-expanded={sidebarOpen}><Menu size={20} /></button>
          <div className="search-box"><Search size={17} /><input ref={searchInputRef} aria-label="Search content, sources, or proof" placeholder="Search content, sources, or proof…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /><kbd>⌘ K</kbd></div>
          <div className={`connection-pill ${connection}`}><span />{connection === "api" ? "API connected" : connection === "demo" ? "Demo data" : "Connecting"}</div>
          <NotificationActionCenter auth={auth} workspaceId={activeWorkspaceId} onNavigate={(notification) => void openNotificationAction(notification)} />
          <button className="new-button" onClick={() => setComposerOpen(true)}><Plus size={17} /> New content</button>
        </header>

        {activeModule ? <WorkspaceModules module={activeModule} auth={auth} workspaceId={activeWorkspaceId} activeBrandId={activeBrandId} brands={brands} {...(creativeContentItemId ? { creativeContentItemId } : {})} onOrganizationChanged={reloadOrganization} onEngagementUnreadChange={setEngagementUnreadCount} onOpenContent={(contentItemId) => void openContentItem(contentItemId)} /> : activeNav === "Calendar" ? <ContentCalendar auth={auth} workspaceId={activeWorkspaceId} brandId={activeBrandId} brandName={activeBrand?.name ?? activeBrandId} items={items} loading={connection === "loading"} dataMode={connection} onChanged={() => refresh()} /> : <>
        <section className="hero-shell">
          <div className="page-head">
            <div><p className="eyebrow">TODAY IN ORIGINPOST</p><h1>Your publishing workspace</h1><p>See what needs review, what is ready to publish, and what has already gone live.</p></div>
            <div className="head-actions"><button className="hero-secondary" onClick={() => navigate("Agent plugins")}><Bot size={17} /> Ask Origin</button><button className="hero-primary" onClick={() => setComposerOpen(true)}><Plus size={17} /> Add content</button></div>
          </div>
          <div className="metrics-grid">
            <button className="metric-card" onClick={() => setFilter("all")} aria-pressed={filter === "all"}><span className="metric-icon coral"><Inbox size={19} /></span><div><small>New items</small><strong>{items.filter((item) => item.status === "inbox" || item.status === "researching").length}</strong></div></button>
            <button className="metric-card" onClick={() => setFilter("review")} aria-pressed={filter === "review"}><span className="metric-icon gold"><CircleCheck size={19} /></span><div><small>Needs review</small><strong>{reviewCount}</strong></div></button>
            <button className="metric-card" onClick={() => setFilter("action")} aria-pressed={filter === "action"}><span className="metric-icon red"><AlertCircle size={19} /></span><div><small>Needs action</small><strong>{actionCount}</strong></div></button>
            <button className="metric-card" onClick={() => setFilter("scheduled")} aria-pressed={filter === "scheduled"}><span className="metric-icon blue"><CalendarDays size={19} /></span><div><small>Scheduled</small><strong>{scheduledCount}</strong></div></button>
            <button className="metric-card" onClick={() => navigate("Proof")}><span className="metric-icon green"><ShieldCheck size={19} /></span><div><small>Published</small><strong>{items.reduce((sum, item) => sum + item.proofs.length, 0)}</strong></div></button>
          </div>
        </section>

        <section className="workspace-grid">
          <div className="panel feed-panel">
            <div className="panel-title"><div><h2>Content pipeline</h2><p>Choose an item to see its sources, status, and next step.</p></div><div className="tabs" aria-label="Filter content pipeline"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")} aria-pressed={filter === "all"}>All</button><button className={filter === "review" ? "selected" : ""} onClick={() => setFilter("review")} aria-pressed={filter === "review"}>Review</button><button className={filter === "action" ? "selected" : ""} onClick={() => setFilter("action")} aria-pressed={filter === "action"}>Action</button><button className={filter === "scheduled" ? "selected" : ""} onClick={() => setFilter("scheduled")} aria-pressed={filter === "scheduled"}>Scheduled</button></div></div>
            <div className="content-list">
              {visible.map((item) => (
                <button key={item.id} className={`content-row ${selected?.id === item.id ? "selected-row" : ""}`} onClick={() => setSelectedId(item.id)} aria-pressed={selected?.id === item.id}>
                  <span className={`type-icon ${item.status}`}>
                    {item.status === "review" ? <CircleCheck size={19} /> : item.status === "action_required" ? <AlertCircle size={19} /> : item.status === "scheduled" ? <Clock3 size={19} /> : <Newspaper size={19} />}
                  </span>
                  <span className="content-copy"><strong>{item.title}</strong><small>{item.summary || "No summary yet."}</small><span><b className={`status ${item.status}`}>{statusLabel[item.status]}</b><i>{item.sources.length} source{item.sources.length === 1 ? "" : "s"}</i><i>{timeAgo(item.updatedAt)}</i></span></span>
                  <span className="row-platform">{platformBadge(item.drafts[0]?.platform ?? "")}</span>
                  <MoreHorizontal size={18} />
                </button>
              ))}
              {visible.length === 0 ? <div className="empty-state"><Check size={22} /><strong>Nothing waiting here</strong><p>Change the filter or add content to the inbox.</p></div> : null}
            </div>
          </div>

          <aside className="detail-panel panel">
            {selected ? <>
              <div className="detail-head"><div><p className="eyebrow">CONTENT ITEM</p><h2>{selected.title}</h2></div><button className="icon-button" disabled aria-label="More actions are not available yet" title="More actions are not available yet"><MoreHorizontal size={18} /></button></div>
              <p className="detail-summary">{selected.summary || "Add a short summary so the team understands this item."}</p>
              <div className="flow-line">
                {["Source", "Verify", "Create", "Approve", "Publish", "Proof"].map((step, index) => {
                  const progress = selected.status === "published" ? 6 : selected.status === "scheduled" || selected.status === "action_required" || selected.status === "publishing" ? 5 : selected.status === "approved" ? 4 : selected.status === "review" ? 3 : selected.status === "drafting" ? 2 : 1;
                  return <span key={step} className={index < progress ? "done" : ""}><i>{index < progress ? <Check size={11} /> : index + 1}</i><small>{step}</small></span>;
                })}
              </div>
              <div className="fact-grid">
                <div><small>Research</small><strong>{selected.researchDepth}</strong></div>
                <div><small>Risk</small><strong>{selected.riskLevel}</strong></div>
                <div><small>Sources</small><strong>{selected.sources.length}</strong></div>
                <div><small>Drafts</small><strong>{selected.drafts.length}</strong></div>
              </div>
              {selected.tags?.includes("monitor") ? <div className={`evidence-status ${crossCheckLabel === "Cross-checked" ? "checked" : "waiting"}`}><ShieldCheck size={16} /><div><strong>{crossCheckLabel}</strong><small>{sourcePublishers.size || selected.sources.length} publisher{(sourcePublishers.size || selected.sources.length) === 1 ? "" : "s"} · {supportedClaims} supported claim{supportedClaims === 1 ? "" : "s"}{newestSourceDate ? ` · newest ${new Date(newestSourceDate).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}</small></div></div> : null}
              <div className="detail-section"><div className="section-label"><span>Evidence</span></div>{selected.sources.length ? selected.sources.slice(0, 2).map((source) => <div className="source-card" key={source.id}><FileText size={17} /><div><strong>{source.title}</strong><small>{source.publisher ?? "Saved source"} · {source.confidence}% confidence</small></div><ShieldCheck size={16} /></div>) : <div className="dashed-action dashed-action-static"><FileText size={16} /> No sources yet</div>}</div>
              <div className="detail-section">
                <div className="section-label"><span>Source research</span><button onClick={() => void researchItem(selected)} disabled={recentResearch?.status === "queued" || recentResearch?.status === "running"}>{recentResearch?.status === "queued" || recentResearch?.status === "running" ? "Working…" : "Run again"}</button></div>
                {recentResearch ? <div className={`research-card ${recentResearch.status}`}><Bot size={18} /><div><strong>{recentResearch.status === "completed" ? `${recentResearch.sourceCount} sources and ${recentResearch.claimCount} claims saved` : recentResearch.status === "failed" ? "Research needs attention" : "Checking sources and dates"}</strong><small>{recentResearch.provider ? `${recentResearch.provider} · ` : ""}{recentResearch.toolsUsed.length ? recentResearch.toolsUsed.join(", ") : recentResearch.query}</small>{recentResearch.error ? <em>{recentResearch.error}</em> : null}</div></div> : <button className="dashed-action" onClick={() => void researchItem(selected)}><Search size={16} /> Research with the sourcing agent</button>}
              </div>
              {selected.drafts.length ? <div className="detail-section">
                <div className="section-label"><span>External review</span><button onClick={() => void createReviewShare()} disabled={reviewShareBusy}>{reviewShareBusy ? "Creating…" : "New link"}</button></div>
                {reviewShareUrl ? <div className="review-share"><Share2 size={16} /><div><strong>Review link ready for 72 hours</strong><a href={reviewShareUrl} target="_blank" rel="noreferrer">{reviewShareUrl.startsWith("http") ? "Open reviewer page" : reviewShareUrl}</a></div>{reviewShareUrl.startsWith("http") ? <button onClick={() => void navigator.clipboard.writeText(reviewShareUrl)}>Copy</button> : null}</div> : <button className="dashed-action" onClick={() => void createReviewShare()}><Share2 size={16} /> Share the exact draft for review</button>}
              </div> : null}
              {manualTarget && manualDraft ? <div className="detail-section manual-handoff">
                <div className="handoff-title"><span><AlertCircle size={17} /></span><div><small>MANUAL {manualPlatform.toUpperCase()} HANDOFF</small><strong>{manualTarget.status === "acknowledged" ? "Post this now" : "Ready for you"}</strong></div></div>
                <div className="handoff-meta"><span>{platformBadge(manualTarget.platform)}</span><div><small>{manualTarget.platform === "facebook" ? "Page" : "Account"}</small><strong>{manualTarget.accountId}</strong></div><div><small>Due</small><strong>{new Date(manualTarget.scheduledFor).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</strong></div></div>
                <label className="caption-box"><span>Approved caption</span><textarea readOnly value={manualDraft.caption} rows={5} /></label>
                {manualTarget.status === "action_required" ? <button className="handoff-button" onClick={() => void acknowledgeHandoff()} disabled={handoffBusy}><Check size={15} /> {handoffBusy ? "Saving…" : "I’m posting this"}</button> : <form className="proof-form" onSubmit={confirmManualPost}>
                  <label>{manualPlatform} post link<input name="liveUrl" type="url" placeholder={liveUrlPlaceholder(manualTarget.platform)} required /></label>
                  <label>{manualPlatform} post ID<input name="externalPostId" placeholder={externalPostIdPlaceholder(manualTarget.platform)} required /></label>
                  {manualAiDisclosureRequested ? <label className="proof-attestation"><input name="aiDisclosureObserved" type="checkbox" value="yes" required /><span>I checked this exact Instagram post and its native AI info label is visible.</span></label> : null}
                  <button className="handoff-button" disabled={handoffBusy}><ShieldCheck size={15} /> {handoffBusy ? "Saving…" : "Save publish proof"}</button>
                </form>}
                {handoffMessage ? <p className="handoff-message" role="status">{handoffMessage}</p> : null}
              </div> : null}
              {providerReviewTarget ? <div className="detail-section manual-handoff">
                <div className="handoff-title"><span><AlertCircle size={17} /></span><div><small>CHECK {providerReviewPlatform.toUpperCase()} RESULT</small><strong>Was this post published?</strong></div></div>
                <p className="detail-summary">OriginPost stopped before it could safely confirm the result. Check {providerReviewPlatform} first. Do not publish it again.</p>
                <form className="proof-form" onSubmit={confirmProviderPost}>
                  <label>Real {providerReviewPlatform} post link<input name="liveUrl" type="url" placeholder={liveUrlPlaceholder(providerReviewTarget.platform)} required /></label>
                  <label>{providerReviewPlatform} post ID<input name="externalPostId" placeholder={externalPostIdPlaceholder(providerReviewTarget.platform)} required /></label>
                  {providerAiDisclosureRequested ? <p className="handoff-message">OriginPost will read this exact Instagram media item and verify the native AI info label before saving proof.</p> : null}
                  <button className="handoff-button" disabled={handoffBusy}><ShieldCheck size={15} /> {handoffBusy ? "Saving…" : "Save recovered proof"}</button>
                </form>
                {handoffMessage ? <p className="handoff-message" role="status">{handoffMessage}</p> : null}
              </div> : null}
              <div className="detail-section"><div className="section-label"><span>Next action</span></div><div className="next-action"><Sparkles size={18} /><div><strong>{selected.status === "review" ? "Review and approve this draft" : providerReviewTarget ? `Check the result on ${providerReviewPlatform}` : selected.status === "action_required" ? "Complete the manual publish step" : selected.status === "scheduled" ? "Waiting for publish time" : "Continue the content workflow"}</strong><p>OriginPost keeps every source, decision, and platform result connected.</p></div></div></div>
              <button className="primary-wide" onClick={() => document.getElementById("content-studio")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Open Content Studio <WandSparkles size={16} /></button>
            </> : null}
          </aside>
        </section>

        {selected ? <ContentStudio auth={auth} workspaceId={activeWorkspaceId} brandId={activeBrandId} item={selected} onChanged={() => refresh()} onOpenLibrary={() => navigate("Library")} onOpenChannels={() => navigate("Channels")} onOpenCreative={() => { setCreativeContentItemId(selected.id); navigate("Creative Studio"); }} /> : null}

        {selected?.status === "approved" && youtubeDraft ? <section className="youtube-review-shell panel">
          <YouTubePublishReview
            auth={auth}
            workspaceId={activeWorkspaceId}
            brandId={activeBrandId}
            contentItemId={selected.id}
            contentVersion={selected.version}
            draft={youtubeDraft}
            fallbackTitle={selected.title}
            onScheduled={() => refresh()}
          />
        </section> : null}

        <section className="suggestions-section">
          <div className="section-heading"><div><p className="eyebrow">WORKSPACE TOOLS</p><h2>Connected tools and settings</h2></div><button className="secondary-button" onClick={() => navigate("Agent plugins")}><Blocks size={16} /> Manage plugins</button></div>
          <div className="suggestion-grid">
            <article className="suggestion-card"><div className="suggestion-top"><span className="trend-chip"><Bot size={13} /> Agent provider</span><small>Optional module</small></div><h3>External source research</h3><p>Find sources, check dates, and save claim links through a workspace provider that is separate from each Board's internal intelligence.</p><div className="reason-row"><span>Workspace scoped</span><span>Audited</span><span>Replaceable</span></div><button onClick={() => navigate("Agent plugins")}>Configure provider <Cable size={15} /></button></article>
            <article className="suggestion-card warm"><div className="suggestion-top"><span className="trend-chip"><Building2 size={13} /> Organization</span><small>{auth.memberships.length} workspace{auth.memberships.length === 1 ? "" : "s"}</small></div><h3>{activeBrand?.name ?? activeMembership?.workspaceName ?? "Workspace"}</h3><p>Manage people, brands, channels, approval rules, and agent access together.</p><div className="reason-row"><span>{activeMembership?.role ?? "owner"}</span><span>{brands.length} brand{brands.length === 1 ? "" : "s"}</span><span>Safe mode</span></div><button onClick={() => navigate("Organizations")}>Manage organization <Settings size={15} /></button></article>
          </div>
        </section>
        </>}
      </main>

      {composerOpen ? <div className="modal-layer" role="dialog" aria-modal="true" aria-label="Add content"><button className="modal-scrim" aria-label="Close add content dialog" onClick={() => setComposerOpen(false)} /><form className="composer" onSubmit={createItem}><div className="composer-head"><div><p className="eyebrow">NEW CONTENT</p><h2>Add something to the inbox</h2></div><button type="button" className="icon-button" onClick={() => setComposerOpen(false)} aria-label="Close add content dialog"><X size={18} /></button></div><label>What is it about?<input name="title" autoFocus placeholder="Example: New local policy announcement" required /></label><label>Notes<textarea name="summary" placeholder="Paste a note, short brief, or what you already know." rows={5} /></label><label className="check-row"><input type="checkbox" name="researchNow" defaultChecked /><span><strong>Research it now</strong><small>Check fresh sources, dates, and claims after saving.</small></span></label><div className="intake-types"><span><FileText size={15} /> Note</span><span><Search size={15} /> Link</span><span><Newspaper size={15} /> News</span><span><Sparkles size={15} /> AI suggestion</span></div><div className="composer-actions"><button type="button" className="secondary-button" onClick={() => setComposerOpen(false)}>Cancel</button><button className="new-button" type="submit"><Plus size={16} /> Add to inbox</button></div></form></div> : null}
    </div>
  );
}
