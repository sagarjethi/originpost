import { createHash } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import type { ConnectedAccount } from "@originpost/domain";
import type { InstagramPublishingCredential } from "@originpost/connectors";

export const instagramFacebookScopes = ["instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_contents", "instagram_manage_insights", "pages_read_engagement", "pages_show_list"] as const;
export const instagramFacebookEndpointFamily = "instagram_api_with_facebook_login" as const;

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function instagramFacebookAppVersion(appId: string, providerVersion: string, callbackUrl: string): string {
  return sha256(["originpost.meta-app-contract.v1", appId, providerVersion, callbackUrl, [...instagramFacebookScopes].sort().join(" ")].join("\0"));
}
export function instagramFacebookProviderAccountVersion(pageId: string, externalAccountId: string, canonicalUsername: string): string {
  return sha256(["originpost.meta-account.v1", pageId, externalAccountId, canonicalUsername].join("\0"));
}

export function instagramCollaboratorProbe(config: Pick<ConfigService, "get">, providerVersion: string, now = Date.now()): { state: "verified"; apiVersion: string } | { state: "not_run" } {
  const apiVersion = config.get<string>("INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION")?.trim();
  const verifiedAt = config.get<string>("INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT")?.trim();
  const expiresAt = config.get<string>("INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT")?.trim();
  if (!apiVersion || !verifiedAt || !expiresAt || apiVersion !== providerVersion) return { state: "not_run" };
  const verified = Date.parse(verifiedAt); const expires = Date.parse(expiresAt);
  if (!Number.isFinite(verified) || !Number.isFinite(expires) || verified > now || expires <= now || expires <= verified || expires - verified > 30 * 24 * 60 * 60_000) return { state: "not_run" };
  return { state: "verified", apiVersion };
}

export function resolveInstagramFacebookPublishingCredential(value: Record<string, unknown>, account: ConnectedAccount, runtime: { appId: string; providerVersion: string; callbackUrl: string; probe: { state: "verified"; apiVersion: string } | { state: "not_run" } }): InstagramPublishingCredential {
  const canonicalUsername = typeof value.canonicalUsername === "string" ? value.canonicalUsername : "";
  const scopes = Array.isArray(value.grantedScopes) && value.grantedScopes.every((scope) => typeof scope === "string") ? [...new Set(value.grantedScopes as string[])].sort() : [];
  const pageTasks = Array.isArray(value.pageTasks) && value.pageTasks.every((task) => typeof task === "string") ? [...new Set(value.pageTasks as string[])].sort() : [];
  const pageId = typeof value.pageId === "string" ? value.pageId : "";
  const expectedAppVersion = instagramFacebookAppVersion(runtime.appId, runtime.providerVersion, runtime.callbackUrl);
  const expectedProviderAccountVersion = instagramFacebookProviderAccountVersion(pageId, account.externalAccountId, canonicalUsername);
  if (value.provider !== "instagram" || value.connectionMode !== "facebook_login" || value.externalAccountId !== account.externalAccountId || typeof value.accessToken !== "string" || !value.accessToken || !/^[a-z0-9._]{1,30}$/.test(canonicalUsername) || !pageId || !pageTasks.includes("CREATE_CONTENT") || instagramFacebookScopes.some((scope) => !scopes.includes(scope)) || value.endpointFamily !== instagramFacebookEndpointFamily || value.providerVersion !== runtime.providerVersion || value.appVersion !== expectedAppVersion || value.providerAccountVersion !== expectedProviderAccountVersion || value.accountVersion !== account.updatedAt) {
    throw new Error("Instagram Facebook Login credential binding is stale or does not match this account. Reconnect it.");
  }
  return { externalAccountId: account.externalAccountId, accessToken: value.accessToken, connectionMode: "facebook_login", accountType: "BUSINESS", canonicalUsername, scopes, endpointFamily: instagramFacebookEndpointFamily, collaboratorEndpointProbe: runtime.probe };
}
