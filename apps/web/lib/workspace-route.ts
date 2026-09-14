export type WorkspaceRouteModule = "boards" | "signals" | "evergreen" | "analytics" | "engagement" | "automations" | "batches" | "organizations" | "channels" | "plugins" | "library" | "creative" | "developer";
export type WorkspaceContentFilter = "all" | "new" | "review" | "scheduled" | "action";

export type WorkspaceRoute = {
  nav: string;
  path: string;
  module: WorkspaceRouteModule | null;
  defaultFilter: WorkspaceContentFilter;
};

export const workspaceRoutes: readonly WorkspaceRoute[] = [
  { nav: "Home", path: "/", module: null, defaultFilter: "all" },
  { nav: "Agent", path: "/agent", module: null, defaultFilter: "all" },
  { nav: "Boards", path: "/boards", module: "boards", defaultFilter: "all" },
  { nav: "Content", path: "/content", module: null, defaultFilter: "all" },
  { nav: "Create", path: "/create", module: null, defaultFilter: "all" },
  { nav: "Calendar", path: "/calendar", module: null, defaultFilter: "scheduled" },
  { nav: "Engagement", path: "/engagement", module: "engagement", defaultFilter: "all" },
  { nav: "Analytics", path: "/analytics", module: "analytics", defaultFilter: "all" },
  { nav: "Library", path: "/library", module: "library", defaultFilter: "all" },
  { nav: "Research", path: "/research", module: null, defaultFilter: "all" },
  { nav: "Signals", path: "/signals", module: "signals", defaultFilter: "all" },
  { nav: "Reuse", path: "/reuse", module: "evergreen", defaultFilter: "all" },
  { nav: "Creative Studio", path: "/creative-studio", module: "creative", defaultFilter: "all" },
  { nav: "Batches", path: "/batches", module: "batches", defaultFilter: "all" },
  { nav: "Proof", path: "/proof", module: null, defaultFilter: "all" },
  { nav: "Automations", path: "/automations", module: "automations", defaultFilter: "all" },
  { nav: "Organizations", path: "/organizations", module: "organizations", defaultFilter: "all" },
  { nav: "Channels", path: "/channels", module: "channels", defaultFilter: "all" },
  { nav: "Agent plugins", path: "/agent-plugins", module: "plugins", defaultFilter: "all" },
  { nav: "Developer API", path: "/developer-api", module: "developer", defaultFilter: "all" },
  { nav: "Help", path: "/help", module: null, defaultFilter: "all" },
];

export const workspacePageSlugs = workspaceRoutes.flatMap((route) => route.path === "/" ? [] : [route.path.slice(1)]);

const routeByPath = new Map(workspaceRoutes.map((route) => [route.path, route]));
const routeByNav = new Map(workspaceRoutes.map((route) => [route.nav.toLocaleLowerCase(), route]));
const routeByModule = new Map(workspaceRoutes.flatMap((route) => route.module ? [[route.module, route] as const] : []));

function normalizedPath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return `/${pathname.split("/").filter(Boolean).join("/")}`;
}

function contentFilter(value: string | null, fallback: WorkspaceContentFilter): WorkspaceContentFilter {
  return value === "all" || value === "new" || value === "review" || value === "scheduled" || value === "action" ? value : fallback;
}

export function workspaceRouteForNav(nav: string): WorkspaceRoute | null {
  return routeByNav.get(nav.trim().toLocaleLowerCase()) ?? null;
}

export function workspaceRouteForPath(pathname: string): WorkspaceRoute | null {
  return routeByPath.get(normalizedPath(pathname)) ?? null;
}

export function resolveWorkspaceLocation(pathname: string, search: string): {
  route: WorkspaceRoute;
  filter: WorkspaceContentFilter;
  itemId?: string;
  legacy: boolean;
} {
  const params = new URLSearchParams(search);
  const pathRoute = workspaceRouteForPath(pathname);
  let route = pathRoute ?? workspaceRoutes[0]!;
  let legacy = false;

  const channelResult = params.get("channel");
  if (["connected", "error", "select_facebook", "select_instagram", "select_meta_messaging"].includes(channelResult ?? "")) {
    route = workspaceRouteForNav("Channels")!;
    legacy = route.path !== normalizedPath(pathname);
  } else if (normalizedPath(pathname) === "/") {
    const legacyModule = params.get("module")?.trim().toLocaleLowerCase();
    const moduleRoute = legacyModule ? routeByModule.get(legacyModule as WorkspaceRouteModule) : undefined;
    const itemId = params.get("item")?.trim();
    if (moduleRoute) {
      route = moduleRoute;
      legacy = true;
    } else if (itemId) {
      route = workspaceRouteForNav("Content")!;
      legacy = true;
    }
  }

  const itemId = params.get("item")?.trim().slice(0, 200);
  return {
    route,
    filter: contentFilter(params.get("filter"), route.defaultFilter),
    ...(itemId ? { itemId } : {}),
    legacy,
  };
}

export function workspaceHref(nav: string, options: { filter?: WorkspaceContentFilter; itemId?: string } = {}): string {
  const route = workspaceRouteForNav(nav) ?? workspaceRoutes[0]!;
  const params = new URLSearchParams();
  if (route.nav === "Content" && options.filter && options.filter !== route.defaultFilter) params.set("filter", options.filter);
  if (["Content", "Create", "Creative Studio"].includes(route.nav) && options.itemId?.trim()) params.set("item", options.itemId.trim().slice(0, 200));
  const search = params.toString();
  return `${route.path}${search ? `?${search}` : ""}`;
}
