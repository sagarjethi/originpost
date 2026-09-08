export const apiBasePath = "/v1";
const publicApiBasePath = "/public/v1";

export type AuthMode = "single-user" | "sessions";
export type AuthView = {
  mode: AuthMode;
  user: { id: string; email: string; displayName: string };
  memberships: Array<{ workspaceId: string; workspaceName: string; workspaceSlug: string; userId: string; role: "owner" | "manager" | "creator" | "viewer" }>;
  csrfToken?: string;
};

export function browserApiRoute(path: string): string {
  if (path === apiBasePath || path.startsWith(`${apiBasePath}/`)) return path;
  if (path === publicApiBasePath || path.startsWith(`${publicApiBasePath}/`)) return path;
  throw new TypeError("OriginPost browser API requests must use a relative /v1 or /public/v1 path.");
}

export async function apiFetch(path: string, init: RequestInit = {}, csrfToken?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-originpost-csrf", csrfToken);
  return fetch(browserApiRoute(path), { ...init, headers, credentials: "include" });
}
