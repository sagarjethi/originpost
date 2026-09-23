"use client";

import { WorkspaceLoading } from "./loading/workspace-loading";
import { requestDeadline } from "@/lib/request-deadline";
import { SourceEvidenceCard, type SourceEvidenceView } from "./source-evidence-card";
import {
  AlertCircle,
  Bot,
  CalendarDays,
  Check,
  ChevronDown,
  CircleCheck,
  Clock3,
  FileText,
  HelpCircle,
  Inbox,
  Menu,
  MoreHorizontal,
  Newspaper,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ActivitySparkIcon,
  ApiIcon,
  Building02Icon,
  Calendar03Icon,
  ChartBreakoutSquareIcon,
  ContentWritingIcon,
  DashboardCircleIcon,
  FolderLibraryIcon,
  GlobalSearchIcon,
  HelpCircleIcon as HugeHelpCircleIcon,
  Message02Icon,
  MoreHorizontalCircle01Icon,
  PackageOpenIcon,
  PaintBoardIcon,
  Plug02Icon,
  Recycle03Icon,
  ShieldCheckIcon as HugeShieldCheckIcon,
  SquareKanbanIcon,
  StackStarIcon,
  WorkflowSquare06Icon,
  ZapIcon as HugeZapIcon,
} from "@hugeicons/core-free-icons";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBasePath, apiFetch, type AuthMode, type AuthView } from "@/lib/api-client";
import { resolveWorkspaceLocation, workspaceHref, workspaceRouteForNav, type WorkspaceContentFilter } from "@/lib/workspace-route";
import { WorkspaceModules, type BrandView, type WorkspaceModule } from "./workspace-modules";
import { YouTubePublishReview } from "./youtube-publish-review";
import { belongsToContentWorkspace } from "@/lib/content-workspace";
import { saveContentIntake } from "@/lib/content-intake";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { ContentStudio } from "./content-studio/content-studio";
import { ContentCalendar } from "./calendar/content-calendar";
import { NotificationActionCenter, type WorkspaceNotification } from "./notifications/notification-action-center";
import { externalPostIdPlaceholder, liveUrlPlaceholder, platformBadge, platformLabel } from "./platform-ui";
import { HelpCenter } from "./help/help-center";
import { NewsPostWorkspace } from "./agent-chat/news-post-workspace";
import { InstallationSettings } from "./onboarding/installation-settings";
import { GenerationLauncher } from "./generation/generation-launcher";

type Status = "inbox" | "researching" | "drafting" | "review" | "approved" | "scheduled" | "action_required" | "publishing" | "published" | "failed" | "archived";
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
  sources: SourceEvidenceView[];
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

const primaryNavGroups = [
  { label: "Publish", items: [
    { label: "Home", icon: DashboardCircleIcon },
    { label: "Agent", icon: ActivitySparkIcon },
    { label: "Content", icon: ContentWritingIcon },
    { label: "Calendar", icon: Calendar03Icon },
    { label: "Channels", icon: Plug02Icon },
  ] },
  { label: "Create", items: [
    { label: "Library", icon: FolderLibraryIcon },
    { label: "Audio", icon: ActivitySparkIcon },
  ] },
];

const secondaryNav = [
  { label: "Boards", icon: SquareKanbanIcon },
  { label: "Engagement", icon: Message02Icon },
  { label: "Analytics", icon: ChartBreakoutSquareIcon },
  { label: "Research", icon: GlobalSearchIcon },
  { label: "Signals", icon: ActivitySparkIcon },
  { label: "Reuse", icon: Recycle03Icon },
  { label: "Creative Studio", icon: PaintBoardIcon },
  { label: "Batches", icon: StackStarIcon },
  { label: "Proof", icon: HugeShieldCheckIcon },
  { label: "Automations", icon: HugeZapIcon },
  { label: "Agent plugins", icon: PackageOpenIcon },
  { label: "Developer API", icon: ApiIcon },
];

const navigationLabel = (label: string) => (({ Channels: "Social accounts", Content: "Posts", Agent: "Create with AI", Proof: "Published posts", Organizations: "Team & projects", Setup: "App setup", Library: "Media library" } as Record<string, string>)[label] ?? label);

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
  const [bootstrapUnavailable, setBootstrapUnavailable] = useState(false);
  const [oidcConfig, setOidcConfig] = useState<{ enabled: boolean; displayName: string }>({ enabled: false, displayName: "Single sign-on" });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [activeBrandId, setActiveBrandId] = useState("");
  const [brands, setBrands] = useState<BrandView[]>([]);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [items, setItems] = useState<ContentItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<WorkspaceContentFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [connection, setConnection] = useState<"loading" | "api" | "error">("loading");
  const [activeNav, setActiveNav] = useState("Home");
  const [moreNavOpen, setMoreNavOpen] = useState(false);
  const [activeModule, setActiveModule] = useState<WorkspaceModule | null>(null);
  const [creativeContentItemId, setCreativeContentItemId] = useState("");
  const [engagementUnreadCount, setEngagementUnreadCount] = useState(0);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffMessage, setHandoffMessage] = useState("");
  const [reviewShareUrl, setReviewShareUrl] = useState("");
  const [reviewShareBusy, setReviewShareBusy] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const scopeSwitcherRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const createBusyRef = useRef(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const closeComposer = useCallback(() => { if (!createBusyRef.current) setComposerOpen(false); }, []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  useModalFocus(composerOpen, composerRef, closeComposer);
  useModalFocus(mobileSidebar && sidebarOpen, sidebarRef, closeSidebar);
  const showContentSearch = ["Home", "Content", "Research", "Proof"].includes(activeNav);

  function applyWorkspaceLocation(label: string, nextFilter: WorkspaceContentFilter, itemId?: string) {
    const route = workspaceRouteForNav(label) ?? workspaceRouteForNav("Home")!;
    setActiveNav(route.nav);
    setMoreNavOpen(secondaryNav.some(item => item.label === route.nav));
    setActiveModule(route.module as WorkspaceModule | null);
    setFilter(nextFilter);
    if (itemId) setSelectedId(itemId);
    if (route.nav === "Creative Studio") setCreativeContentItemId(itemId ?? "");
    document.title = route.nav === "Home" ? "OriginPost — From source to published proof" : `${navigationLabel(route.nav)} — OriginPost`;
  }

  function navigate(label: string, options: { filter?: WorkspaceContentFilter; itemId?: string; replace?: boolean } = {}) {
    const route = workspaceRouteForNav(label) ?? workspaceRouteForNav("Home")!;
    const itemId = options.itemId ?? (route.nav === "Create" ? selectedId : route.nav === "Creative Studio" ? creativeContentItemId : undefined);
    const nextFilter = options.filter ?? route.defaultFilter;
    const href = workspaceHref(route.nav, { filter: nextFilter, ...(itemId ? { itemId } : {}) });
    if (`${window.location.pathname}${window.location.search}` !== href) window.history[options.replace ? "replaceState" : "pushState"]({}, "", href);
    applyWorkspaceLocation(route.nav, nextFilter, itemId);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openContentFilter(nextFilter: WorkspaceContentFilter) {
    navigate(["Research", "Proof"].includes(activeNav) ? activeNav : "Content", { filter: nextFilter });
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
    navigate("Content", { itemId: contentItemId });
    setSearchQuery("");
    window.requestAnimationFrame(() => document.querySelector(".detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function refresh(activeAuth = auth, workspaceId = activeWorkspaceId || activeAuth?.memberships[0]?.workspaceId || "default", requestedBrandId = activeBrandId, signal?: AbortSignal) {
    if (!activeAuth) return;
    try {
      const brandResponse = await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/brands`, { cache: "no-store", signal: signal ?? null }, activeAuth.csrfToken);
      if (!brandResponse.ok) throw new Error("Could not load workspace brands.");
      const availableBrands = await brandResponse.json() as BrandView[];
      const storedBrandId = typeof window === "undefined" ? "" : window.localStorage.getItem(`originpost:brand:${workspaceId}`) ?? "";
      const brandId = availableBrands.some((brand) => brand.id === requestedBrandId) ? requestedBrandId : availableBrands.some((brand) => brand.id === storedBrandId) ? storedBrandId : availableBrands[0]?.id ?? "";
      const response = await apiFetch(`/v1/content-items?workspaceId=${encodeURIComponent(workspaceId)}${brandId ? `&brandId=${encodeURIComponent(brandId)}` : ""}`, { cache: "no-store", signal: signal ?? null }, activeAuth.csrfToken);
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
      setWorkspaceError("");
    } catch (error) {
      if (signal) throw error;
      setConnection("error");
      setWorkspaceError("Could not refresh this workspace. Previously loaded items may be out of date.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    const deadline = requestDeadline();
    void (async () => {
      try {
        if (new URLSearchParams(window.location.search).get("auth") === "error") setLoginError("Single sign-on could not be completed. Try again or contact your workspace owner.");
        const configResponse = await apiFetch("/v1/auth/config", { cache: "no-store", signal: deadline.signal });
        if (!configResponse.ok) throw new Error("OriginPost API is unavailable.");
        const config = await configResponse.json() as { mode: AuthMode; oidc?: { enabled?: boolean; displayName?: string } };
        if (cancelled) return;
        setAuthMode(config.mode);
        setOidcConfig({ enabled: config.oidc?.enabled === true, displayName: config.oidc?.displayName?.trim() || "Single sign-on" });
        const meResponse = await apiFetch("/v1/auth/me", { cache: "no-store", signal: deadline.signal });
        if (!meResponse.ok && meResponse.status !== 401) throw new Error("OriginPost API is unavailable.");
        if (meResponse.ok) {
          const view = await meResponse.json() as AuthView;
          if (!cancelled) {
            setAuth(view);
            const stored = window.localStorage.getItem("originpost:workspace") ?? "";
            const workspaceId = view.memberships.some((membership) => membership.workspaceId === stored) ? stored : view.memberships[0]?.workspaceId ?? "default";
            await refresh(view, workspaceId, window.localStorage.getItem(`originpost:brand:${workspaceId}`) ?? "", deadline.signal);
          }
        }
      } catch {
        if (!cancelled) setBootstrapUnavailable(true);
      } finally { deadline.dispose(); if (!cancelled) setAuthLoading(false); }
    })();
    return () => { cancelled = true; deadline.cancel(); };
  }, []);
  useEffect(() => { setHandoffMessage(""); setReviewShareUrl(""); }, [selectedId]);
  useEffect(() => { setHandoffMessage(""); setReviewShareUrl(""); setComposerOpen(false); }, [activeWorkspaceId, activeBrandId]);
  useEffect(() => {
    if (!activeWorkspaceId || !activeBrandId || activeNav !== "Create" || new URLSearchParams(window.location.search).get("compose") !== "new") return;
    setComposerError("");
    setComposerOpen(true);
    window.history.replaceState({}, "", workspaceHref("Create"));
  }, [activeWorkspaceId, activeBrandId, activeNav]);
  useEffect(() => {
    const syncFromUrl = (canonicalizeLegacy = false) => {
      const resolved = resolveWorkspaceLocation(window.location.pathname, window.location.search);
      applyWorkspaceLocation(resolved.route.nav, resolved.filter, resolved.itemId);
      if (canonicalizeLegacy && resolved.legacy) {
        const url = new URL(window.location.href);
        url.pathname = resolved.route.path;
        url.searchParams.delete("module");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      }
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    syncFromUrl(true);
    const onPopState = () => syncFromUrl(false);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
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
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!showContentSearch) navigate("Content");
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [showContentSearch]);
  useEffect(() => {
    if (!scopeMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!scopeSwitcherRef.current?.contains(event.target as Node)) setScopeMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setScopeMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [scopeMenuOpen]);

  const hasActiveResearch = items.some((item) => item.researchRuns?.some((run) => run.status === "queued" || run.status === "running"));
  useEffect(() => {
    if (!hasActiveResearch) return;
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveResearch]);

  const visible = useMemo(() => items.filter((item) => {
    if (!belongsToContentWorkspace(activeNav, item)) return false;
    const query = searchQuery.trim().toLocaleLowerCase();
    if (query) {
      const searchable = [item.title, item.summary, ...item.sources.flatMap((source) => [source.title, source.publisher ?? ""]), ...item.proofs.map((proof) => proof.liveUrl)].join(" ").toLocaleLowerCase();
      if (!searchable.includes(query)) return false;
    }
    if (filter === "new") return item.status === "inbox" || item.status === "researching";
    if (filter === "review") return item.status === "review";
    if (filter === "scheduled") return item.status === "scheduled" || item.status === "publishing";
    if (filter === "action") return item.status === "action_required";
    return item.status !== "archived";
  }), [activeNav, filter, items, searchQuery]);
  const selectionItems = ["Content", "Research", "Proof"].includes(activeNav) ? visible : items;
  const selected = selectionItems.find((item) => item.id === selectedId) ?? selectionItems[0];
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
  const crossCheckLabel = (selected?.sources.length ?? 0) >= 2 && sourcePublishers.size >= 2 && supportedClaims > 0 ? "Multiple publishers — check independence" : (selected?.sources.length ?? 0) >= 2 ? "Check the claims" : "Needs a second source";
  const newestSourceDate = selected?.sources.map((source) => source.publishedAt ? new Date(source.publishedAt).getTime() : 0).filter(Boolean).sort((a, b) => b - a)[0];
  const homeQueue = [...items]
    .filter((item) => item.status !== "archived" && item.status !== "published")
    .sort((a, b) => {
      const priority: Partial<Record<Status, number>> = { failed: 0, action_required: 1, review: 2, researching: 3, inbox: 4, drafting: 5, approved: 6, scheduled: 7, publishing: 8 };
      return (priority[a.status] ?? 10) - (priority[b.status] ?? 10) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 5);
  const nextUp = homeQueue[0];
  const showSecondaryNav = moreNavOpen;

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
    if (createBusyRef.current) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    createBusyRef.current = true; setCreateBusy(true); setComposerError("");
    try {
      const result = await saveContentIntake<ContentItem>({workspaceId:activeWorkspaceId,brandId:activeBrandId,title,summary:String(form.get("summary") ?? "").trim(),researchNow:form.get("researchNow")==="on",...(auth?.csrfToken ? {csrfToken:auth.csrfToken} : {})});
      setItems(current => [result.item,...current.filter(item=>item.id!==result.item.id)]);
      setSelectedId(result.item.id); setConnection("api");
      setWorkspaceError(result.warning ?? ""); setComposerOpen(false);
      navigate("Create", {itemId:result.item.id});
    } catch(error) {
      setComposerError(error instanceof Error ? error.message : "Content could not be saved. Your input is still here.");
    } finally { createBusyRef.current=false; setCreateBusy(false); }
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
      setWorkspaceError(error instanceof Error ? error.message : "Research could not start.");
    }
  }

  if (authLoading) return <WorkspaceLoading />;
  if (bootstrapUnavailable) return <WorkspaceLoading unavailable />;
  if (!auth && authMode === "sessions") return <main className="login-shell"><form className="login-card panel" onSubmit={signIn}><div className="brand-mark"><span>O</span></div><p className="eyebrow">SELF-HOSTED WORKSPACE</p><h1>Sign in to OriginPost</h1><p>Use the account created by your workspace owner.</p>{loginError ? <div className="module-alert">{loginError}</div> : null}{oidcConfig.enabled ? <a className="secondary-button" href={`${apiBasePath}/auth/oidc/start`}>Continue with {oidcConfig.displayName}</a> : null}<label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required minLength={12} /></label><button className="new-button" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in with password"}</button></form></main>;
  if (!auth) return <main className="login-shell"><section className="login-card panel"><div className="brand-mark"><span>O</span></div><h1>OriginPost is unavailable</h1><p>{loginError || "Check that the API is running."}</p></section></main>;

  const activeMembership = auth.memberships.find((membership) => membership.workspaceId === activeWorkspaceId) ?? auth.memberships[0];
  const activeBrand = brands.find((brand) => brand.id === activeBrandId) ?? brands[0];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`} aria-hidden={mobileSidebar && !sidebarOpen} inert={composerOpen || (mobileSidebar && !sidebarOpen)}>
        <div className="brand-row">
          <div className="brand-mark"><span>O</span></div>
          <div><strong>OriginPost</strong><small>Editorial intelligence</small></div>
          <span className="brand-mode">DESK</span>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close menu"><X size={18} /></button>
        </div>

        <div className="scope-switcher" ref={scopeSwitcherRef}>
          <button className="scope-switcher-trigger" type="button" onClick={() => setScopeMenuOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={scopeMenuOpen}>
            <span className="workspace-avatar">{(activeMembership?.workspaceName ?? "Workspace").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
            <span className="scope-switcher-copy"><strong>{activeMembership?.workspaceName ?? "Workspace"}</strong><small>{activeBrand?.name ?? "Choose a brand"}</small></span>
            <ChevronDown className={scopeMenuOpen ? "scope-switcher-chevron open" : "scope-switcher-chevron"} size={16} />
          </button>
          {scopeMenuOpen ? <div className="scope-menu" role="dialog" aria-label="Switch workspace or brand">
            <div className="scope-menu-heading"><span>Workspace</span><small>{auth.memberships.length}</small></div>
            <div className="scope-option-list" role="listbox" aria-label="Choose workspace">
              {auth.memberships.map((membership) => {
                const selectedWorkspace = membership.workspaceId === activeWorkspaceId;
                return <button type="button" role="option" aria-selected={selectedWorkspace} className={selectedWorkspace ? "scope-option selected" : "scope-option"} key={membership.workspaceId} onClick={() => { setScopeMenuOpen(false); void switchWorkspace(membership.workspaceId); }}>
                  <span className="scope-option-avatar">{membership.workspaceName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>
                  <span><strong>{membership.workspaceName}</strong><small>{membership.role}</small></span>
                  {selectedWorkspace ? <Check size={15} /> : null}
                </button>;
              })}
            </div>
            <div className="scope-menu-divider" />
            <div className="scope-menu-heading"><span>Brand</span><small>{brands.length}</small></div>
            <div className="scope-option-list" role="listbox" aria-label="Choose brand">
              {brands.map((brand) => {
                const selectedBrand = brand.id === activeBrandId;
                return <button type="button" role="option" aria-selected={selectedBrand} className={selectedBrand ? "scope-option selected" : "scope-option"} key={brand.id} onClick={() => { setScopeMenuOpen(false); void switchBrand(brand.id); }}>
                  <span className="scope-option-dot" />
                  <span><strong>{brand.name}</strong><small>{brand.primaryLanguage} · {brand.timezone}</small></span>
                  {selectedBrand ? <Check size={15} /> : null}
                </button>;
              })}
              {!brands.length ? <p className="scope-option-empty">No brand is available in this workspace.</p> : null}
            </div>
          </div> : null}
        </div>

        <nav className="main-nav" aria-label="Primary navigation">
          {primaryNavGroups.map((group) => <div className="nav-cluster" key={group.label}>
            <div className="nav-section-label"><span>{group.label}</span></div>
            {group.items.map(({ label, icon }) => {
              const badge = label === "Engagement" ? engagementUnreadCount : 0;
              return <a href={workspaceHref(label)} key={label} className={activeNav === label ? "nav-item active" : "nav-item"} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(label); }} aria-current={activeNav === label ? "page" : undefined}>
                <span className="nav-glyph"><HugeiconsIcon icon={icon} size={19} strokeWidth={1.55} /></span><span className="nav-label">{navigationLabel(label)}</span>
                {badge ? <em>{badge > 99 ? "99+" : badge}</em> : null}
              </a>;
            })}
          </div>)}
          <div className="nav-section-rule" />
          <button className="nav-item nav-more" type="button" onClick={() => setMoreNavOpen((open) => !open)} aria-expanded={showSecondaryNav} aria-controls="secondary-navigation"><span className="nav-glyph"><HugeiconsIcon icon={WorkflowSquare06Icon} size={19} strokeWidth={1.55} /></span><span className="nav-label">More tools</span><ChevronDown className={showSecondaryNav ? "nav-chevron open" : "nav-chevron"} size={15} /></button>
          {showSecondaryNav ? <div id="secondary-navigation" className="secondary-navigation">
            {secondaryNav.map(({ label, icon }) => <a href={workspaceHref(label)} key={label} className={activeNav === label ? "nav-item active" : "nav-item"} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(label); }} aria-current={activeNav === label ? "page" : undefined}><span className="nav-glyph"><HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} /></span><span className="nav-label">{navigationLabel(label)}</span>{label === "Engagement" && engagementUnreadCount > 0 ? <em>{engagementUnreadCount > 99 ? "99+" : engagementUnreadCount}</em> : null}</a>)}
          </div> : null}
        </nav>

        <div className="sidebar-bottom">
          {activeMembership?.role === "owner" ? <a href="/setup" className={activeNav === "Setup" ? "nav-item active" : "nav-item"} aria-current={activeNav === "Setup" ? "page" : undefined}><span className="nav-glyph"><HugeiconsIcon icon={Building02Icon} size={18} strokeWidth={1.55} /></span><span className="nav-label">App setup</span></a> : null}
          <a href={workspaceHref("Help")} className={activeNav === "Help" ? "nav-item active" : "nav-item"} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate("Help"); }} aria-current={activeNav === "Help" ? "page" : undefined}><span className="nav-glyph"><HugeiconsIcon icon={HugeHelpCircleIcon} size={18} strokeWidth={1.55} /></span><span className="nav-label">Help</span></a>
          <a href={workspaceHref("Organizations")} className="nav-item" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate("Organizations"); }}><span className="nav-glyph"><HugeiconsIcon icon={Building02Icon} size={18} strokeWidth={1.55} /></span><span className="nav-label">Team &amp; projects</span></a>
          {auth.mode === "sessions" ? <button className="user-row" onClick={() => void signOut()} aria-label={`Sign out ${auth.user.displayName}`}><span>{auth.user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{auth.user.displayName}</strong><small>{activeMembership?.role ?? "owner"} · Sign out</small></div><HugeiconsIcon icon={MoreHorizontalCircle01Icon} size={17} strokeWidth={1.5} /></button> : <div className="user-row user-row-static"><span>{auth.user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><strong>{auth.user.displayName}</strong><small>{activeMembership?.role ?? "owner"}</small></div></div>}
        </div>
      </aside>

      {sidebarOpen ? <button className="scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} /> : null}

      <main id="main-content" tabIndex={-1} inert={composerOpen || (mobileSidebar && sidebarOpen)} className={`main-area ${activeNav === "Agent" ? "agent-main-area" : ""}`}>
        <header className="topbar">
          <button ref={menuButtonRef} className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open menu" aria-expanded={sidebarOpen}><Menu size={20} /></button>
          {!showContentSearch ? <div className="agent-topbar-title"><span>Workspace</span><span aria-hidden="true">/</span><strong>{navigationLabel(activeNav)}</strong></div> : <div className="search-box"><Search size={17} /><input ref={searchInputRef} aria-label="Search content, sources, or proof" placeholder="Search content, sources, or proof…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if(event.key==="Enter") navigate("Content"); if(event.key==="Escape")setSearchQuery(""); }} /><kbd>⌘ K</kbd></div>}
          {activeNav !== "Agent" && <div className={`connection-pill ${connection}`}><span />{connection === "api" ? "Workspace online" : connection === "error" ? "Workspace offline" : "Loading workspace"}</div>}
          <button className="topbar-help" onClick={() => navigate("Help")}><HelpCircle size={17} /> Help</button>
          <NotificationActionCenter auth={auth} workspaceId={activeWorkspaceId} onNavigate={(notification) => void openNotificationAction(notification)} />
          <GenerationLauncher key={`${activeWorkspaceId}:${activeBrandId}:${activeNav}`} brandName={activeBrand?.name ?? ""} canConfigure={activeMembership?.role === "owner"} content={["Content", "Create"].includes(activeNav) ? selected : undefined} />
        </header>

        {workspaceError && <div className="workspace-error" role="alert"><AlertCircle size={18}/><p>{workspaceError}</p><button type="button" onClick={() => void refresh()}>Refresh</button></div>}
        {activeNav === "Setup" ? <InstallationSettings key={`${auth.user.id}:${activeWorkspaceId}`} auth={auth} workspaceId={activeWorkspaceId} /> : activeNav === "Agent" ? <NewsPostWorkspace key={`${auth.user.id}:${activeWorkspaceId}:${activeBrandId}`} auth={auth} workspaceId={activeWorkspaceId} brandId={activeBrandId} brandName={activeBrand?.name ?? ""} onNavigate={navigate} /> : activeModule ? <WorkspaceModules module={activeModule} auth={auth} workspaceId={activeWorkspaceId} activeBrandId={activeBrandId} brands={brands} {...(creativeContentItemId ? { creativeContentItemId } : {})} onOrganizationChanged={reloadOrganization} onEngagementUnreadChange={setEngagementUnreadCount} onOpenContent={(contentItemId) => void openContentItem(contentItemId)} /> : activeNav === "Calendar" ? <ContentCalendar auth={auth} workspaceId={activeWorkspaceId} brandId={activeBrandId} brandName={activeBrand?.name ?? activeBrandId} items={items} loading={connection === "loading"} dataMode={connection} onChanged={() => refresh()} /> : activeNav === "Help" ? <HelpCenter onNavigate={navigate} auth={auth} workspaceId={activeWorkspaceId} /> : activeNav === "Create" ? <section className="studio-page">
          <header className="content-page-head"><div><p className="eyebrow">CREATE</p><h1>Build the exact post</h1><p>Draft, review, prepare media, and schedule one selected Content Item without losing its evidence.</p></div><button className="secondary-button" onClick={() => navigate("Content")}><Inbox size={16} /> Choose another item</button></header>
          {selected ? <ContentStudio auth={auth} workspaceId={activeWorkspaceId} brandId={activeBrandId} item={selected} onChanged={() => refresh()} onOpenLibrary={() => navigate("Library")} onOpenChannels={() => navigate("Channels")} onOpenCreative={() => navigate("Creative Studio", { itemId: selected.id })} /> : <div className="panel empty-state"><WandSparkles size={23} /><strong>Choose a Content Item first</strong><p>Add a title and short brief, then generate your text. You can also choose an existing post.</p><button className="new-button" onClick={() => { setComposerOpen(true); setComposerError(""); }}>Add a post</button><button className="secondary-button" onClick={() => navigate("Content")}>Choose an existing post</button></div>}
          {selected?.status === "approved" && youtubeDraft ? <section className="youtube-review-shell panel"><YouTubePublishReview auth={auth} workspaceId={activeWorkspaceId} brandId={activeBrandId} contentItemId={selected.id} contentVersion={selected.version} draft={youtubeDraft} fallbackTitle={selected.title} onScheduled={() => refresh()} /></section> : null}
        </section> : <>
        {activeNav === "Home" ? <section className="hero-shell home-hero">
          <div className="page-head">
            <div><p className="eyebrow">TODAY IN ORIGINPOST</p><h1>Your publishing workspace.</h1><p>Create a post, review it with your team, and publish to your connected accounts.</p></div>
            <div className="head-actions"><button className="hero-secondary" onClick={() => navigate("Agent")}><Sparkles size={17} /> Create with AI</button><button className="hero-primary" onClick={() => { setComposerOpen(true); setComposerError(""); }}><Plus size={17} /> Add content</button></div>
          </div>
          <div className="metrics-grid">
            <button className="metric-card" onClick={() => openContentFilter("new")}><span className="metric-icon coral"><Inbox size={19} /></span><div><small>New items</small><strong>{items.filter((item) => item.status === "inbox" || item.status === "researching").length}</strong></div></button>
            <button className="metric-card" onClick={() => openContentFilter("review")}><span className="metric-icon gold"><CircleCheck size={19} /></span><div><small>Needs review</small><strong>{reviewCount}</strong></div></button>
            <button className="metric-card" onClick={() => openContentFilter("action")}><span className="metric-icon red"><AlertCircle size={19} /></span><div><small>Needs action</small><strong>{actionCount}</strong></div></button>
            <button className="metric-card" onClick={() => openContentFilter("scheduled")}><span className="metric-icon blue"><CalendarDays size={19} /></span><div><small>Scheduled</small><strong>{scheduledCount}</strong></div></button>
            <button className="metric-card" onClick={() => navigate("Proof")}><span className="metric-icon green"><ShieldCheck size={19} /></span><div><small>Published</small><strong>{items.reduce((sum, item) => sum + item.proofs.length, 0)}</strong></div></button>
          </div>
        </section> : <header className="content-page-head"><div><p className="eyebrow">{activeNav.toUpperCase()}</p><h1>{activeNav === "Research" ? "Check the facts behind each story" : activeNav === "Proof" ? "See what actually went live" : "Your posts"}</h1><p>{activeNav === "Research" ? "Review source evidence and research runs before creating a post." : activeNav === "Proof" ? "Published receipts and live links, attached to the exact content item." : "Open a post to edit, review, or choose where to publish it."}</p></div><button className="secondary-button" onClick={() => { setComposerOpen(true); setComposerError(""); }}><Plus size={16} /> Add content</button></header>}

        <section className={`workspace-grid ${activeNav === "Home" ? "home-workspace" : ""}`}>
          <div className="panel feed-panel">
            <div className="panel-title"><div><h2>{activeNav === "Home" ? "Your queue" : activeNav === "Research" ? "Source research" : activeNav === "Proof" ? "Published proof" : "Posts"}</h2><p>{activeNav === "Home" ? "Five highest-priority items, ranked by what needs attention." : "Choose an item to see its sources, status, and next step."}</p></div>{activeNav === "Home" ? <button className="secondary-button" onClick={() => navigate("Content")}>View all posts</button> : <div className="tabs" aria-label="Filter content pipeline"><button className={filter === "all" ? "selected" : ""} onClick={() => openContentFilter("all")} aria-pressed={filter === "all"}>All</button><button className={filter === "new" ? "selected" : ""} onClick={() => openContentFilter("new")} aria-pressed={filter === "new"}>New</button><button className={filter === "review" ? "selected" : ""} onClick={() => openContentFilter("review")} aria-pressed={filter === "review"}>Review</button><button className={filter === "action" ? "selected" : ""} onClick={() => openContentFilter("action")} aria-pressed={filter === "action"}>Action</button><button className={filter === "scheduled" ? "selected" : ""} onClick={() => openContentFilter("scheduled")} aria-pressed={filter === "scheduled"}>Scheduled</button></div>}</div>
            <div className="content-list">
              {(activeNav === "Home" ? homeQueue : visible).map((item) => (
                <button key={item.id} className={`content-row ${activeNav !== "Home" && selected?.id === item.id ? "selected-row" : ""}`} onClick={() => navigate(["Research", "Proof"].includes(activeNav) ? activeNav : "Content", { filter, itemId: item.id })} aria-pressed={activeNav !== "Home" && selected?.id === item.id}>
                  <span className={`type-icon ${item.status}`}>
                    {item.status === "review" ? <CircleCheck size={19} /> : item.status === "action_required" ? <AlertCircle size={19} /> : item.status === "scheduled" ? <Clock3 size={19} /> : <Newspaper size={19} />}
                  </span>
                  <span className="content-copy"><strong>{item.title}</strong><small>{item.summary || "No summary yet."}</small><span><b className={`status ${item.status}`}>{statusLabel[item.status]}</b><i>{item.sources.length} source{item.sources.length === 1 ? "" : "s"}</i><i>{timeAgo(item.updatedAt)}</i></span></span>
                  <span className="row-platform">{platformBadge(item.drafts[0]?.platform ?? "")}</span>
                  <MoreHorizontal size={18} />
                </button>
              ))}
              {(activeNav === "Home" ? homeQueue : visible).length === 0 ? <div className="empty-state"><Check size={22} /><strong>{activeNav === "Home" ? (items.length ? "You're caught up" : "Start your first post") : "Nothing matches this view"}</strong><p>{activeNav === "Home" ? (items.length ? "No posts need attention right now." : "Connect a social account, create your draft, then review it before publishing.") : "Change the filter or add a post."}</p>{activeNav === "Home" && !items.length ? <a className="secondary-button" href="/channels">Connect social accounts</a> : null}</div> : null}
            </div>
          </div>

          {activeNav === "Home" ? <aside className="home-next panel">
            <p className="eyebrow">DO THIS NEXT</p>
            {nextUp ? <><span className={`type-icon ${nextUp.status}`}>{nextUp.status === "review" ? <CircleCheck size={19} /> : nextUp.status === "action_required" || nextUp.status === "failed" ? <AlertCircle size={19} /> : <Newspaper size={19} />}</span><h2>{nextUp.title}</h2><p>{nextUp.status === "action_required" || nextUp.status === "failed" ? "This item may need recovery before other work continues." : nextUp.status === "review" ? "The exact draft is waiting for a human decision." : "Continue the next incomplete step in this item's source-to-proof journey."}</p><button className="primary-wide" onClick={() => navigate("Content", { itemId: nextUp.id })}>Open next action <Sparkles size={16} /></button></> : <><Check size={23} /><h2>{items.length ? "Ready for your next story" : "Create your draft"}</h2><p>Add a news link, write your own post, or use Create with AI. Nothing publishes until it is approved.</p><button className="primary-wide" onClick={() => { setComposerOpen(true); setComposerError(""); }}>Add content <Plus size={16} /></button></>}
          </aside> : <aside className="detail-panel panel">
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
              {selected.tags?.includes("monitor") ? <div className={`evidence-status ${"waiting"}`}><ShieldCheck size={16} /><div><strong>{crossCheckLabel}</strong><small>{sourcePublishers.size || selected.sources.length} publisher{(sourcePublishers.size || selected.sources.length) === 1 ? "" : "s"} · {supportedClaims} supported claim{supportedClaims === 1 ? "" : "s"}{newestSourceDate ? ` · newest ${new Date(newestSourceDate).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}</small></div></div> : null}
              <div className="detail-section"><div className="section-label"><span>Evidence</span></div>{selected.sources.length ? selected.sources.map((source) => <SourceEvidenceCard key={source.id} source={source} />) : <div className="dashed-action dashed-action-static"><FileText size={16} /> No sources yet</div>}</div>
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
              <button className="primary-wide" onClick={() => navigate("Create")}>Open Create <WandSparkles size={16} /></button>
            </> : null}
          </aside>}
        </section>
        </>}
      </main>

      {composerOpen ? <div ref={composerRef} className="modal-layer" role="dialog" aria-modal="true" aria-label="Add content"><button tabIndex={-1} className="modal-scrim" aria-label="Close add content dialog" onClick={closeComposer} /><form className="composer" onSubmit={createItem}><div className="composer-head"><div><p className="eyebrow">NEW CONTENT</p><h2>Add something to the inbox</h2></div><button type="button" className="icon-button" onClick={closeComposer} aria-label="Close add content dialog"><X size={18} /></button></div>{composerError && <p className="workspace-error" role="alert">{composerError}</p>}<label>What is it about?<input name="title" autoFocus maxLength={180} placeholder="Example: New local policy announcement" required /></label><label>Notes<textarea name="summary" maxLength={2000} placeholder="Paste a note, short brief, or what you already know." rows={5} /></label><label className="check-row"><input type="checkbox" name="researchNow" defaultChecked /><span><strong>Research it now</strong><small>Check fresh sources, dates, and claims after saving.</small></span></label><div className="intake-types"><span><FileText size={15} /> Note</span><span><Search size={15} /> Link</span><span><Newspaper size={15} /> News</span><span><Sparkles size={15} /> AI suggestion</span></div><div className="composer-actions"><button type="button" className="secondary-button" onClick={closeComposer}>Cancel</button><button className="new-button" type="submit" disabled={createBusy}><Plus size={16} /> {createBusy ? "Saving…" : "Add to inbox"}</button></div></form></div> : null}
    </div>
  );
}
