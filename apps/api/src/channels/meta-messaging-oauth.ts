import { createHmac } from "node:crypto";
import { BadGatewayException, ConflictException } from "@nestjs/common";
import type { MetaPagePrivateConversationMode } from "@originpost/connectors";

export const metaMessagingScopes = [
  "business_management",
  "instagram_basic",
  "instagram_manage_messages",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
  "pages_show_list",
] as const;

const messengerFields = ["messages", "message_echoes", "message_deliveries", "message_reads", "messaging_policy_enforcement"] as const;
const instagramFields = ["messages", "message_reactions", "messaging_seen", "messaging_postbacks", "messaging_referrals", "messaging_policy_enforcement"] as const;

export interface MetaMessagingCandidate {
  targetKey: string;
  connectionMode: MetaPagePrivateConversationMode;
  externalBusinessAccountId: string;
  endpointPageId: string;
  displayName: string;
  pageName: string;
  username?: string | undefined;
  accessToken: string;
  pageTasks: string[];
  grantedScopes: string[];
}

export interface MetaMessagingProbeResult {
  verifiedAt: string;
  expiresAt: string;
  webhookFields: string[];
}

export interface MetaMessagingDiscovery {
  providerSubject: string;
  candidates: MetaMessagingCandidate[];
}

export interface MetaMessagingOAuthProviderOptions {
  apiVersion: string;
  appId: string;
  appSecret: string;
  callbackUrl: string;
  testMode?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}

type GraphErrorBody = { error?: unknown };

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Meta Graph origin must be exact HTTPS.");
  return url.origin;
}

export function metaMessagingTargetKey(mode: MetaPagePrivateConversationMode, externalBusinessAccountId: string): string {
  return `${mode}:${externalBusinessAccountId}`;
}

export class MetaMessagingOAuthProvider {
  private readonly transport: typeof fetch;
  private readonly now: () => Date;
  private readonly graphOrigin: string;

  constructor(private readonly options: MetaMessagingOAuthProviderOptions) {
    if (!/^v\d+\.\d+$/.test(options.apiVersion)) throw new Error("Meta messaging apiVersion must look like v26.0.");
    if (!options.appId || !options.appSecret) throw new Error("Meta messaging app credentials are required.");
    const callback = new URL(options.callbackUrl);
    if (callback.protocol !== "https:" && !(options.testMode && callback.hostname === "localhost" && callback.protocol === "http:")) throw new Error("Meta messaging callback must use HTTPS.");
    this.graphOrigin = exactHttpsOrigin("https://graph.facebook.com");
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  authorizationUrl(rawState: string): string {
    const authorization = new URL(this.options.testMode ? "https://oauth.test.invalid/meta-messaging-authorize" : `https://www.facebook.com/${this.options.apiVersion}/dialog/oauth`);
    authorization.searchParams.set("client_id", this.options.testMode ? "test-facebook-client" : this.options.appId);
    authorization.searchParams.set("redirect_uri", this.options.callbackUrl);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", [...metaMessagingScopes].sort().join(","));
    authorization.searchParams.set("state", rawState);
    authorization.searchParams.set("auth_type", "rerequest");
    return authorization.toString();
  }

  async exchangeAndDiscover(code: string): Promise<MetaMessagingDiscovery> {
    if (this.options.testMode) {
      if (code !== "originpost-meta-messaging-oauth-test-code") throw new BadGatewayException("The test provider rejected this Meta messaging authorization code.");
      const grantedScopes = [...metaMessagingScopes].sort();
      return { providerSubject: "100000000000001", candidates: [
        { targetKey: metaMessagingTargetKey("facebook_page_messenger", "test-facebook-page-1"), connectionMode: "facebook_page_messenger", externalBusinessAccountId: "test-facebook-page-1", endpointPageId: "test-facebook-page-1", displayName: "OAuth Test Facebook Page", pageName: "OAuth Test Facebook Page", accessToken: "test-meta-messaging-page-token-never-returned", pageTasks: ["MESSAGING", "MODERATE"], grantedScopes },
        { targetKey: metaMessagingTargetKey("instagram_linked_page", "test-instagram-facebook-1"), connectionMode: "instagram_linked_page", externalBusinessAccountId: "test-instagram-facebook-1", endpointPageId: "test-facebook-page-1", displayName: "@originpost.test", pageName: "OAuth Test Facebook Page", username: "originpost.test", accessToken: "test-meta-messaging-page-token-never-returned", pageTasks: ["MESSAGING", "MODERATE"], grantedScopes },
      ] };
    }

    const short = await this.graph<{ access_token?: unknown; error?: unknown }>("/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({ client_id: this.options.appId, client_secret: this.options.appSecret, redirect_uri: this.options.callbackUrl, code }),
    });
    if (typeof short.access_token !== "string" || !short.access_token) throw new BadGatewayException("Facebook could not exchange the Meta messaging authorization code.");

    const debug = await this.graph<{ data?: { is_valid?: unknown; app_id?: unknown; user_id?: unknown }; error?: unknown }>("/debug_token", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.appId}|${this.options.appSecret}` },
      body: new URLSearchParams({ input_token: short.access_token }),
    });
    if (debug.data?.is_valid !== true || debug.data.app_id !== this.options.appId || (typeof debug.data.user_id !== "string" && typeof debug.data.user_id !== "number") || !String(debug.data.user_id)) throw new BadGatewayException("Facebook returned an invalid Meta messaging access grant.");

    const long = await this.graph<{ access_token?: unknown; error?: unknown }>("/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "fb_exchange_token", client_id: this.options.appId, client_secret: this.options.appSecret, fb_exchange_token: short.access_token }),
    });
    if (typeof long.access_token !== "string" || !long.access_token) throw new BadGatewayException("Facebook could not create long-lived Meta messaging access.");
    const token = long.access_token;
    const permissionBody = await this.graphWithToken<{ data?: unknown; error?: unknown }>("/me/permissions", token, { method: "GET" });
    const grantedScopes = Array.isArray(permissionBody.data)
      ? [...new Set((permissionBody.data as Array<{ permission?: unknown; status?: unknown }>).filter((entry) => entry.status === "granted" && typeof entry.permission === "string").map((entry) => entry.permission as string))].sort()
      : [];
    if (metaMessagingScopes.some((scope) => !grantedScopes.includes(scope))) throw new BadGatewayException("Meta messaging permissions were not fully granted. Reconnect and approve every requested Page and Instagram messaging permission.");

    const candidates: MetaMessagingCandidate[] = [];
    let after: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const query = new URLSearchParams({ fields: "id,name,access_token,tasks,instagram_business_account{id,username}", limit: "100" });
      if (after) query.set("after", after);
      const value = await this.graphWithToken<{ data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown }; error?: unknown }>("/me/accounts", token, { method: "GET", query });
      if (!Array.isArray(value.data)) throw new BadGatewayException("Facebook returned an invalid Page list for Meta messaging.");
      for (const raw of value.data.slice(0, 100) as Array<{ id?: unknown; name?: unknown; access_token?: unknown; tasks?: unknown; instagram_business_account?: { id?: unknown; username?: unknown } }>) {
        const pageId = typeof raw.id === "string" ? raw.id : "";
        const pageName = typeof raw.name === "string" ? raw.name.normalize("NFC").trim().slice(0, 200) : "";
        const accessToken = typeof raw.access_token === "string" ? raw.access_token : "";
        const pageTasks = Array.isArray(raw.tasks) ? [...new Set(raw.tasks.filter((task): task is string => typeof task === "string" && Boolean(task.trim())))].sort() : [];
        if (!pageId || !pageName || !accessToken || !pageTasks.some((task) => task === "MESSAGING" || task === "MODERATE")) continue;
        candidates.push({ targetKey: metaMessagingTargetKey("facebook_page_messenger", pageId), connectionMode: "facebook_page_messenger", externalBusinessAccountId: pageId, endpointPageId: pageId, displayName: pageName, pageName, accessToken, pageTasks, grantedScopes });
        const igId = typeof raw.instagram_business_account?.id === "string" ? raw.instagram_business_account.id : "";
        const username = typeof raw.instagram_business_account?.username === "string" ? raw.instagram_business_account.username.normalize("NFC").trim().replace(/^@/, "").toLowerCase() : "";
        if (igId && /^[a-z0-9._]{1,30}$/.test(username)) candidates.push({ targetKey: metaMessagingTargetKey("instagram_linked_page", igId), connectionMode: "instagram_linked_page", externalBusinessAccountId: igId, endpointPageId: pageId, displayName: `@${username}`, pageName, username, accessToken, pageTasks, grantedScopes });
      }
      const nextAfter = value.paging?.next && typeof value.paging.cursors?.after === "string" ? value.paging.cursors.after : undefined;
      if (!nextAfter || nextAfter === after) break;
      after = nextAfter;
    }
    return { providerSubject: String(debug.data.user_id), candidates };
  }

  async probe(candidate: MetaMessagingCandidate): Promise<MetaMessagingProbeResult> {
    if (metaMessagingScopes.some((scope) => !candidate.grantedScopes.includes(scope)) || !candidate.pageTasks.some((task) => task === "MESSAGING" || task === "MODERATE")) throw new ConflictException("This account does not have the exact Meta messaging permissions and Page task.");
    const fields = candidate.connectionMode === "facebook_page_messenger" ? [...messengerFields] : [...instagramFields];
    if (!this.options.testMode) {
      const conversations = await this.graphWithToken<{ data?: unknown; error?: unknown }>(`/${encodeURIComponent(candidate.endpointPageId)}/conversations`, candidate.accessToken, { method: "GET", query: new URLSearchParams({ platform: candidate.connectionMode === "facebook_page_messenger" ? "messenger" : "instagram", limit: "1" }) });
      if (!Array.isArray(conversations.data)) throw new BadGatewayException("Meta did not confirm the pinned Conversations API contract for this account.");
      const subscription = await this.graphWithToken<{ success?: unknown; error?: unknown }>(`/${encodeURIComponent(candidate.endpointPageId)}/subscribed_apps`, candidate.accessToken, { method: "POST", body: new URLSearchParams({ subscribed_fields: fields.join(",") }) });
      if (subscription.success !== true) throw new BadGatewayException("Meta did not confirm the private-message webhook subscription for this Page.");
    }
    const verifiedAt = this.now().toISOString();
    return { verifiedAt, expiresAt: new Date(Date.parse(verifiedAt) + 30 * 24 * 60 * 60_000).toISOString(), webhookFields: fields };
  }

  private async graphWithToken<T extends GraphErrorBody>(path: string, accessToken: string, input: { method: "GET" | "POST"; query?: URLSearchParams; body?: URLSearchParams }): Promise<T> {
    const query = new URLSearchParams(input.query);
    query.set("appsecret_proof", createHmac("sha256", this.options.appSecret).update(accessToken).digest("hex"));
    query.set("appsecret_time", String(Math.floor(this.now().getTime() / 1_000)));
    return this.graph<T>(path, { ...input, query, headers: { authorization: `Bearer ${accessToken}` } });
  }

  private async graph<T extends GraphErrorBody>(path: string, input: { method: "GET" | "POST"; query?: URLSearchParams; body?: URLSearchParams; headers?: Record<string, string> }): Promise<T> {
    const url = new URL(`${this.graphOrigin}/${this.options.apiVersion}${path}`);
    for (const [key, value] of input.query ?? []) url.searchParams.append(key, value);
    let response: Response;
    try {
      response = await this.transport(url, { method: input.method, headers: { accept: "application/json", ...(input.body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(input.headers ?? {}) }, ...(input.body ? { body: input.body } : {}), redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new BadGatewayException("Meta messaging could not reach Facebook safely.");
    }
    const raw = await response.text().catch(() => "");
    if (Buffer.byteLength(raw, "utf8") > 1_000_000) throw new BadGatewayException("Meta returned an oversized messaging response.");
    let value: T;
    try { value = JSON.parse(raw) as T; } catch { throw new BadGatewayException("Meta returned an invalid messaging response."); }
    if (!response.ok || value.error) throw new BadGatewayException("Meta rejected the messaging connection or contract probe.");
    return value;
  }
}
