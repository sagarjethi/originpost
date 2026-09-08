import { createHmac } from "node:crypto";
import { canonicalSha256 } from "@originpost/domain";
import { MockFacebookConnector } from "./mock.js";
import { ProviderAnalyticsError, ProviderEngagementError } from "./types.js";
import type { AnalyticsRequest, AnalyticsResult, CommentPage, ConnectorManifest, EngagementConnector, EngagementRequestScope, PlatformConnector, ProviderEngagementComment, PublishRequest, PublishResult, ReadCommentsRequest, ReplyToCommentRequest, ReplyToCommentResult, SubscribeCommentsRequest, SubscriptionResult, ValidationIssue } from "./types.js";
import { assertCorrectionExecution, correctionLineage, correctionResult, ProviderRemoteCorrectionError, remoteSnapshot } from "./remote-correction.js";
import type { ExecuteRemoteCorrectionRequest, ReconcileRemoteCorrectionRequest, RemoteContentObservation, RemoteContentSnapshot, RemoteCorrectionCapabilityRequest, RemoteCorrectionCapabilitySet, RemoteCorrectionConnector, RemoteCorrectionOutcome, RemoteCorrectionTarget } from "./remote-correction.js";
import { ProviderFirstCommentError } from "./first-comment.js";
import type { CreateFirstCommentRequest, FirstCommentCapability, FirstCommentConnector, FirstCommentObservation, FirstCommentScope, InspectFirstCommentRequest } from "./first-comment.js";

export interface FacebookPagePublishingCredential {
  externalAccountId: string;
  accessToken: string;
  scope?: string | undefined;
  scopes?: readonly string[] | undefined;
  pageTasks?: readonly string[] | undefined;
  credentialVersion?: string | undefined;
  accountVersion?: string | undefined;
}

export interface FacebookPageOfficialConnectorOptions {
  apiVersion: string;
  appSecret: string;
  resolveCredential(request: Pick<PublishRequest, "workspaceId" | "accountId"> | Pick<EngagementRequestScope, "workspaceId" | "accountId"> | RemoteCorrectionCapabilityRequest): Promise<FacebookPagePublishingCredential>;
  fetch?: typeof fetch;
  baseUrl?: string;
  appId?: string;
  environment?: "production" | "development" | "test";
  maxCommentPages?: number;
  /**
   * Production analytics remains closed unless App Review evidence and a recent
   * operator-watched owned-Page probe result are bound to this app and version.
   */
  analyticsContractProbe?: {
    apiVersion: string;
    appId: string;
    appReviewSha256: string;
    resultSha256: string;
    verifiedAt: string;
    expiresAt: string;
  };
  /**
   * Enables only a live contract probe of Meta's generic Object Comments edge.
   * Meta's v26 endpoint-specific reply documentation conflicts with that edge,
   * so production callers must leave this unset until their pinned version has
   * been verified against a real Page and accepted through App Review.
   */
  commentReplyContractProbe?: { apiVersion: string; verifiedAt: string };
  /** Enables Page Post deletion only after this exact Graph version passes the live allowlist contract probe. */
  pageDeleteContractProbe?: {
    apiVersion: string;
    verifiedAt: string;
    expiresAt: string;
    environment: "production" | "development" | "test";
    appId: string;
    accountId: string;
    externalPageId: string;
    credentialVersion: string;
    accountVersion: string;
    pageTasksSha256: string;
    task: "page_post_delete";
  };
}

export interface FacebookCreatedPost {
  externalPostId: string;
  rawResponse: unknown;
}

export interface FacebookPublishedPost {
  externalPostId: string;
  liveUrl: string;
  createdAt?: string | undefined;
  rawResponse: unknown;
}

type GraphError = { message?: unknown; type?: unknown; code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
type GraphBody = {
  id?: unknown;
  post_id?: unknown;
  permalink_url?: unknown;
  is_published?: unknown;
  message?: unknown;
  created_time?: unknown;
  from?: { id?: unknown };
  success?: unknown;
  data?: unknown;
  tasks?: unknown;
  paging?: { next?: unknown; cursors?: { before?: unknown; after?: unknown } };
  error?: GraphError;
};

type FacebookInsightResult = { name?: unknown; period?: unknown; values?: unknown };
type FacebookInsightValue = { value?: unknown };
type FacebookPostInsightName = "post_media_view" | "post_total_media_view_unique" | "post_clicks";

const facebookPostInsightNames: readonly FacebookPostInsightName[] = ["post_media_view", "post_total_media_view_unique", "post_clicks"];
const facebookAnalyticsBodyLimit = 1024 * 1024;

async function boundedJson(response: Response): Promise<GraphBody> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > facebookAnalyticsBodyLimit) throw new ProviderAnalyticsError("Facebook returned an oversized analytics response.", "provider_failed");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > facebookAnalyticsBodyLimit) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderAnalyticsError("Facebook returned an oversized analytics response.", "provider_failed");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as GraphBody; }
  catch { throw new ProviderAnalyticsError("Facebook returned invalid analytics JSON.", "provider_failed"); }
}

type FacebookGraphComment = {
  id?: unknown;
  message?: unknown;
  created_time?: unknown;
  is_hidden?: unknown;
  from?: { id?: unknown; name?: unknown };
  parent?: { id?: unknown };
};

function facebookError(response: Response, body: GraphBody): Error {
  const providerCode = typeof body.error?.code === "number" ? ` (${body.error.code})` : "";
  const message = typeof body.error?.message === "string" ? body.error.message : `Facebook returned HTTP ${response.status}.`;
  return new Error(`Facebook Page publishing failed${providerCode}: ${message}`);
}

function validFacebookPermalink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"));
  } catch {
    return false;
  }
}

export class FacebookPageOfficialConnector implements PlatformConnector, EngagementConnector, RemoteCorrectionConnector, FirstCommentConnector {
  private readonly transport: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: FacebookPageOfficialConnectorOptions) {
    if (!/^v\d+\.\d+$/.test(options.apiVersion)) throw new Error("Facebook apiVersion must look like v26.0.");
    if (!options.appSecret) throw new Error("Facebook appSecret is required for appsecret_proof.");
    this.transport = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
    const origin = new URL(this.baseUrl);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Facebook provider origin must be an HTTPS URL without credentials, query, or fragment.");
  }

  get manifest(): ConnectorManifest & { platform: "facebook"; capabilities: ConnectorManifest["capabilities"] & { comments: true } } {
    return {
      id: "originpost.facebook.official",
      name: "Facebook Page",
      platform: "facebook",
      version: "0.2.0",
      apiMode: "official",
      capabilities: {
        formats: ["text", "image"],
        analytics: this.analyticsProbeEnabled(),
        comments: true,
        tokenRefresh: true,
        pendingPublishing: false,
      },
      limits: { captionCharacters: 63_206, maxMedia: 1, maxVideoBytes: 0 },
    };
  }

  validate(request: PublishRequest): Promise<ValidationIssue[]> {
    return new MockFacebookConnector().validate(request);
  }

  async correctionCapabilities(request: RemoteCorrectionCapabilityRequest): Promise<RemoteCorrectionCapabilitySet> {
    if (request.platform !== "facebook") throw new ProviderRemoteCorrectionError("This connector only corrects Facebook Page posts.", "invalid_request");
    let credential: FacebookPagePublishingCredential | undefined;
    try { credential = await this.options.resolveCredential(request); }
    catch { credential = undefined; }
    const probed = credential ? await this.deleteProbeEnabled(request, credential) : false;
    const scoped = credential ? this.hasCorrectionScopes(credential) : false;
    const deleteCapability = !probed
      ? { state: "contract_probe_required" as const, reason: "Meta limits Page Post API deletion to select developers; use Business Manager until this exact version passes the live probe." }
      : scoped
        ? { state: "supported" as const }
        : { state: "scope_required" as const, reason: "Reconnect the Page and grant pages_manage_posts before remote deletion." };
    const unsupported = { state: "unsupported" as const, reason: "This correction action is not proven by the Page Post adapter contract." };
    return {
      platform: "facebook",
      providerVersion: this.options.apiVersion,
      resolvedAt: new Date().toISOString(),
      actions: {
        edit_text: unsupported,
        make_private: unsupported,
        restore_visibility: unsupported,
        delete_remote: deleteCapability,
        manual_remove: { state: "manual_only", reason: "Use Business Manager and attach operator evidence." },
      },
    };
  }

  async preflightCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    if (request.platform !== "facebook") throw new ProviderRemoteCorrectionError("This connector only corrects Facebook Page posts.", "invalid_request");
    const credential = await this.correctionCredential(request, false);
    const query = new URLSearchParams({ fields: "id,from,created_time,is_published,permalink_url,message" });
    let response: Response;
    try {
      response = await this.transport(this.correctionUrl(`/${encodeURIComponent(request.externalPostId)}`, credential.accessToken, query), {
        method: "GET",
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderRemoteCorrectionError("Facebook Page post state could not be read.", "transient");
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) {
      const error = this.correctionError(response, value);
      if (error.code === "not_found") return this.facebookSnapshot(request, credential.externalAccountId, "not_found", {});
      throw error;
    }
    if (value.id !== request.externalPostId) throw new ProviderRemoteCorrectionError("Facebook did not return the exact approved Page post.", "uncertain");
    if (value.from?.id !== credential.externalAccountId) throw new ProviderRemoteCorrectionError("Facebook returned a post owned by another Page.", "permission");
    return this.facebookSnapshot(request, credential.externalAccountId, value.is_published === false ? "hidden" : "live", {
      ...(typeof value.message === "string" ? { text: value.message } : {}),
      ...(typeof value.created_time === "string" ? { createdTime: value.created_time } : {}),
      ...(validFacebookPermalink(value.permalink_url) ? { permalink: value.permalink_url } : {}),
    });
  }

  preflightManualCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    return this.preflightCorrection(request);
  }

  async executeCorrection(request: ExecuteRemoteCorrectionRequest): Promise<RemoteCorrectionOutcome> {
    assertCorrectionExecution(request, "facebook");
    const operation = request.operation;
    if (operation.mutation.action === "manual_remove") return { kind: "manual_action_required", reason: "Remove the post in Business Manager and attach operator evidence.", handoff: "business_manager" };
    if (operation.mutation.action !== "delete_remote") return { kind: "rejected", category: "unsupported", reason: "This Facebook Page correction action has not passed an official contract probe." };
    let credential: FacebookPagePublishingCredential;
    try { credential = await this.correctionCredential(operation, true); }
    catch (error) {
      if (error instanceof ProviderRemoteCorrectionError && error.code === "permission") return { kind: "manual_action_required", reason: "Facebook Page deletion is not enabled for this connection. Use Business Manager and attach operator evidence.", handoff: "business_manager" };
      return this.rejectedCorrection(error);
    }
    if (!(await this.deleteProbeEnabled(operation, credential))) return { kind: "manual_action_required", reason: "Meta limits Page Post API deletion to select developers. Remove it in Business Manager and attach operator evidence.", handoff: "business_manager" };
    let response: Response;
    try {
      response = await this.transport(this.correctionUrl(`/${encodeURIComponent(operation.externalPostId)}`, credential.accessToken), {
        method: "DELETE",
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { kind: "uncertain", reason: "Facebook may have received the Page Post deletion. Reconcile before any further action." };
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) return this.rejectedCorrection(this.correctionError(response, value));
    if (value.success !== true) return { kind: "uncertain", reason: "Facebook did not return an explicit success receipt. Reconcile before any further action." };
    let after: RemoteContentSnapshot;
    try { after = await this.preflightCorrection(this.targetFor(operation)); }
    catch { return { kind: "uncertain", reason: "Facebook confirmed deletion, but OriginPost could not complete read-after-write verification." }; }
    if (after.state !== "not_found") return { kind: "uncertain", reason: "Facebook confirmed deletion, but the Page Post is still returned by read-after-write verification." };
    const occurredAt = new Date().toISOString();
    return {
      kind: "provider_confirmed",
      receipt: { provider: "facebook", action: "delete_remote", externalPostId: operation.externalPostId, occurredAt, responseSha256: canonicalSha256({ success: true, externalPostId: operation.externalPostId }) },
      after,
    };
  }

  async reconcileCorrection(request: ReconcileRemoteCorrectionRequest): Promise<RemoteContentObservation> {
    const snapshot = await this.preflightCorrection(this.targetFor(request.operation));
    return { snapshot, result: correctionResult(request.operation, snapshot) };
  }

  async readComments(request: ReadCommentsRequest): Promise<CommentPage> {
    if (request.platform !== "facebook") throw new ProviderEngagementError("This connector only reads Facebook Page comments.", "unsupported");
    const credential = await this.engagementCredential(request);
    const fields = "id,message,created_time,is_hidden,from{id,name},parent{id}";
    const top = await this.readCommentEdge(
      `/${encodeURIComponent(request.externalMediaId)}/comments`,
      credential.accessToken,
      new URLSearchParams({ fields, filter: "toplevel", order: "chronological", limit: "100" }),
    );
    const comments = [...top.comments];
    const rawPages: unknown[] = [...top.rawPages];
    for (const parent of top.comments) {
      const replies = await this.readCommentEdge(
        `/${encodeURIComponent(parent.externalCommentId)}/comments`,
        credential.accessToken,
        new URLSearchParams({ fields, order: "chronological", limit: "100" }),
        parent.externalCommentId,
      );
      comments.push(...replies.comments);
      rawPages.push(...replies.rawPages);
    }
    comments.sort((a, b) => (a.providerCreatedAt ?? "").localeCompare(b.providerCreatedAt ?? "") || a.externalCommentId.localeCompare(b.externalCommentId));
    return { comments, fetchedAt: new Date().toISOString(), complete: true, rawResponse: { pageCount: rawPages.length, pages: rawPages } };
  }

  async replyToComment(request: ReplyToCommentRequest): Promise<ReplyToCommentResult> {
    if (request.platform !== "facebook") throw new ProviderEngagementError("This connector only replies to Facebook Page comments.", "unsupported");
    const probe = this.options.commentReplyContractProbe;
    if (!probe || probe.apiVersion !== this.options.apiVersion || !Number.isFinite(Date.parse(probe.verifiedAt))) {
      throw new ProviderEngagementError("Facebook Page public replies are disabled until this pinned Graph API version passes the required live contract probe.", "unsupported");
    }
    const credential = await this.engagementCredential(request);
    const url = this.engagementUrl(`/${encodeURIComponent(request.externalCommentId)}/comments`, credential.accessToken);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message: request.body.normalize("NFC") }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderEngagementError("Facebook may have received this reply, but OriginPost did not receive a result. Reconcile it before retrying.", "uncertain");
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) throw this.engagementError(response, value);
    if (typeof value.id !== "string" || !value.id) throw new ProviderEngagementError("Facebook did not return a reply ID. Reconcile this reply before retrying.", "uncertain");
    return { externalReplyId: value.id, createdAt: new Date().toISOString(), rawResponse: { id: value.id } };
  }

  async firstCommentCapability(scope: FirstCommentScope): Promise<FirstCommentCapability> {
    if (scope.platform !== "facebook") return { state: "unsupported", platform: "facebook", providerVersion: this.options.apiVersion, reason: "This connector supports only Facebook Page first comments.", maxCharacters: 2_200 };
    let credential: FacebookPagePublishingCredential;
    try { credential = await this.engagementCredential(scope); }
    catch { return { state: "permission_missing", platform: "facebook", providerVersion: this.options.apiVersion, reason: "Reconnect the Page with comment-management permission.", maxCharacters: 2_200 }; }
    const scopes = new Set([...(credential.scopes ?? []), ...(credential.scope?.split(/[\s,]+/u).filter(Boolean) ?? [])]);
    const tasks = new Set(credential.pageTasks ?? []);
    return scopes.has("pages_manage_engagement") && tasks.has("MODERATE")
      ? { state: "supported", platform: "facebook", providerVersion: this.options.apiVersion, maxCharacters: 2_200 }
      : { state: "permission_missing", platform: "facebook", providerVersion: this.options.apiVersion, reason: "Facebook first comments require pages_manage_engagement and the Page MODERATE task.", maxCharacters: 2_200 };
  }

  async createFirstComment(request: CreateFirstCommentRequest) {
    const capability = await this.firstCommentCapability(request);
    if (capability.state !== "supported") throw new ProviderFirstCommentError(capability.reason, capability.state);
    const credential = await this.engagementCredential(request);
    const url = this.engagementUrl(`/${encodeURIComponent(request.externalPostId)}/comments`, credential.accessToken);
    let response: Response;
    try { response = await this.transport(url, { method: "POST", headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: request.body.normalize("NFC") }), redirect: "error", signal: AbortSignal.timeout(20_000) }); }
    catch { throw new ProviderFirstCommentError("Facebook may have received the first comment. Reconcile before any further write.", "uncertain"); }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) throw this.firstCommentError(response, value);
    if (typeof value.id !== "string" || !value.id) throw new ProviderFirstCommentError("Facebook accepted the first-comment request without returning a comment ID. Reconcile before any further write.", "uncertain");
    const providerAcceptedAt = new Date().toISOString();
    return { providerCommentId: value.id, providerAcceptedAt, providerResponseSha256: canonicalSha256({ provider: "facebook", externalPostId: request.externalPostId, providerCommentId: value.id, providerAcceptedAt }) };
  }

  async inspectFirstComment(request: InspectFirstCommentRequest): Promise<FirstCommentObservation> {
    const credential = await this.engagementCredential(request);
    const page = await this.readComments({ workspaceId: request.workspaceId, accountId: request.accountId, platform: "facebook", brandId: "provider-internal", externalMediaId: request.externalPostId });
    const matches = page.comments.filter((comment) => !comment.parentExternalCommentId && comment.authorScopedId === credential.externalAccountId && comment.body.normalize("NFC").trim() === request.body.normalize("NFC").trim() && (!request.providerCommentId || comment.externalCommentId === request.providerCommentId) && (!comment.providerCreatedAt || Date.parse(comment.providerCreatedAt) >= Date.parse(request.earliestCreatedAt) - 60_000));
    const observedAt = new Date().toISOString();
    const providerResponseSha256 = canonicalSha256({ provider: "facebook", externalPostId: request.externalPostId, requestedCommentId: request.providerCommentId ?? null, matches: matches.map((entry) => ({ id: entry.externalCommentId, createdAt: entry.providerCreatedAt ?? null })) });
    if (matches.length !== 1) return { state: matches.length ? "ambiguous" : "not_found", observedAt, providerResponseSha256 };
    return { state: "matched", providerCommentId: matches[0]!.externalCommentId, providerAcceptedAt: matches[0]!.providerCreatedAt ?? observedAt, providerResponseSha256, observedAt };
  }

  async subscribeToComments(request: SubscribeCommentsRequest): Promise<SubscriptionResult> {
    if (request.platform !== "facebook") throw new ProviderEngagementError("This connector only subscribes Facebook Pages.", "unsupported");
    const credential = await this.engagementCredential(request);
    if (credential.externalAccountId !== request.externalAccountId) {
      throw new ProviderEngagementError("The Facebook Page subscription does not match the connected Page credential.", "permission_missing");
    }
    const value = await this.engagementCall(
      `/${encodeURIComponent(request.externalAccountId)}/subscribed_apps`,
      credential.accessToken,
      { method: "POST", query: new URLSearchParams({ subscribed_fields: "feed" }) },
    );
    if (value.success !== true) throw new ProviderEngagementError("Facebook did not confirm the Page feed subscription.", "provider_failed");
    return { subscribed: true, fields: ["feed"], rawResponse: { success: true } };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const created = await this.createPost(request);
    const verified = await this.readPublishedPost(request, created.externalPostId);
    return { status: "published", externalPostId: verified.externalPostId, liveUrl: verified.liveUrl, rawResponse: { create: created.rawResponse, verify: verified.rawResponse } };
  }

  async readPostAnalytics(request: AnalyticsRequest): Promise<AnalyticsResult> {
    if (request.platform !== "facebook") throw new ProviderAnalyticsError("This connector only reads Facebook Page Post analytics.", "unsupported");
    if (!this.analyticsProbeEnabled()) throw new ProviderAnalyticsError("Facebook Page analytics are disabled until App Review evidence and the current Graph-version probe are recorded.", "unsupported");
    const credential = await this.analyticsCredential(request);
    if (!request.externalPostId.startsWith(`${credential.externalAccountId}_`)) throw new ProviderAnalyticsError("The Facebook Page Post proof does not belong to this connected Page.", "permission_missing");

    const responses: Array<{ requested: FacebookPostInsightName[]; data: unknown[] }> = [];
    const parsed = new Map<FacebookPostInsightName, number>();
    const caveats: string[] = [
      "Facebook Page Post media views may include paid and organic delivery.",
      "Unique media viewers are approximate and are never summed across posts.",
    ];
    let firstFailure: ProviderAnalyticsError | undefined;
    try {
      const initial = await this.readInsightMetrics(request.externalPostId, credential.accessToken, [...facebookPostInsightNames]);
      responses.push(initial.raw);
      for (const [name, value] of this.parseInsightMetrics(initial.data, facebookPostInsightNames)) parsed.set(name, value);
    } catch (error) {
      if (!(error instanceof ProviderAnalyticsError) || error.code !== "unsupported") throw error;
      firstFailure = error;
    }

    const omitted = facebookPostInsightNames.filter((name) => !parsed.has(name));
    for (const name of omitted) {
      try {
        const retry = await this.readInsightMetrics(request.externalPostId, credential.accessToken, [name]);
        responses.push(retry.raw);
        const isolated = this.parseInsightMetrics(retry.data, [name]);
        if (isolated.has(name)) parsed.set(name, isolated.get(name)!);
      } catch (error) {
        if (!(error instanceof ProviderAnalyticsError)) throw error;
        if (error.code === "permission_missing") throw error;
        if ((error.code === "rate_limited" || error.code === "transient") && parsed.size === 0) throw error;
        firstFailure ??= error;
      }
    }

    const stillMissing = facebookPostInsightNames.filter((name) => !parsed.has(name));
    if (stillMissing.length) caveats.push(`Facebook did not return ${stillMissing.join(", ")}; missing values are not zero.`);
    if (firstFailure?.code === "unsupported") caveats.push("At least one pinned Facebook Page Post metric is unavailable for this object or Graph contract.");
    const capturedAt = new Date().toISOString();
    const metrics = facebookPostInsightNames.flatMap((rawMetric) => {
      const value = parsed.get(rawMetric);
      if (value === undefined) return [];
      const key = rawMetric === "post_media_view" ? "views" as const : rawMetric === "post_total_media_view_unique" ? "reach" as const : "clicks" as const;
      return [{
        key,
        value,
        unit: "count" as const,
        rawMetric,
        source: "facebook_page_post_insights" as const,
        coverage: rawMetric === "post_clicks" ? "unknown" as const : "paid_and_organic" as const,
        definitionVersion: `${this.options.apiVersion}:${rawMetric}`,
        aggregation: rawMetric === "post_total_media_view_unique" ? "non_additive" as const : "sum" as const,
      }];
    });
    const ageMs = Date.now() - Date.parse(request.publishedAt);
    return {
      capturedAt,
      period: "lifetime",
      metrics,
      status: metrics.length ? "ready" : Number.isFinite(ageMs) && ageMs < 24 * 60 * 60_000 ? "pending" : "unavailable",
      caveats,
      rawResponse: { provider: "facebook", apiVersion: this.options.apiVersion, responses },
    };
  }

  async createPost(request: PublishRequest): Promise<FacebookCreatedPost> {
    const errors = (await this.validate(request)).filter((issue) => issue.severity === "error");
    if (errors.length) throw new Error(errors.map((issue) => issue.message).join(" "));
    const credential = await this.options.resolveCredential(request);
    this.assertCredential(credential);
    const body = request.format === "text"
      ? new URLSearchParams({ message: request.caption })
      : new URLSearchParams({ url: request.media[0]!.url, caption: request.caption });
    const edge = request.format === "text" ? "feed" : "photos";
    const value = await this.call(`/${encodeURIComponent(credential.externalAccountId)}/${edge}`, credential.accessToken, { method: "POST", body });
    const externalPostId = typeof value.post_id === "string" && value.post_id ? value.post_id : typeof value.id === "string" && value.id ? value.id : undefined;
    if (!externalPostId) throw new Error("Facebook accepted the request but did not return a post ID. Reconcile the Page before retrying.");
    return { externalPostId, rawResponse: value };
  }

  async readPublishedPost(request: Pick<PublishRequest, "workspaceId" | "accountId">, externalPostId: string): Promise<FacebookPublishedPost> {
    const credential = await this.options.resolveCredential(request);
    this.assertCredential(credential);
    const query = new URLSearchParams({ fields: "id,from,created_time,is_published,permalink_url" });
    const value = await this.call(`/${encodeURIComponent(externalPostId)}?${query.toString()}`, credential.accessToken, { method: "GET" });
    if (value.from?.id !== credential.externalAccountId) throw new Error("Facebook returned a post from another Page. OriginPost will not record it as proof.");
    if (value.is_published === false) throw new Error("Facebook returned the object, but it is not published on the Page.");
    if (!validFacebookPermalink(value.permalink_url)) throw new Error("Facebook did not return a verified HTTPS permalink. Reconcile the Page before recording proof.");
    const returnedId = typeof value.id === "string" && value.id ? value.id : externalPostId;
    return { externalPostId: returnedId, liveUrl: value.permalink_url, ...(typeof value.created_time === "string" ? { createdAt: value.created_time } : {}), rawResponse: value };
  }

  private assertCredential(credential: FacebookPagePublishingCredential): void {
    if (!credential.accessToken || !credential.externalAccountId) throw new Error("Facebook Page publishing credential is unavailable.");
  }

  private analyticsProbeEnabled(): boolean {
    const probe = this.options.analyticsContractProbe;
    if (!probe || !this.options.appId || probe.apiVersion !== this.options.apiVersion || probe.appId !== this.options.appId || !/^[a-f0-9]{64}$/u.test(probe.appReviewSha256) || !/^[a-f0-9]{64}$/u.test(probe.resultSha256)) return false;
    const verifiedAt = Date.parse(probe.verifiedAt); const expiresAt = Date.parse(probe.expiresAt); const now = Date.now();
    return Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && verifiedAt <= now && now < expiresAt && expiresAt - verifiedAt <= 30 * 24 * 60 * 60_000;
  }

  private async analyticsCredential(request: AnalyticsRequest): Promise<FacebookPagePublishingCredential> {
    let credential: FacebookPagePublishingCredential;
    try { credential = await this.options.resolveCredential(request); }
    catch { throw new ProviderAnalyticsError("Facebook Page analytics access is unavailable. Reconnect the Page.", "permission_missing"); }
    if (!credential.externalAccountId || !credential.accessToken) throw new ProviderAnalyticsError("Facebook Page analytics credential is unavailable.", "permission_missing");
    const scopes = new Set([...(credential.scopes ?? []), ...(credential.scope?.split(/[\s,]+/u).filter(Boolean) ?? [])]);
    const missing = ["pages_show_list", "pages_read_engagement", "read_insights"].filter((scope) => !scopes.has(scope));
    if (missing.length || !credential.pageTasks?.includes("ANALYZE")) throw new ProviderAnalyticsError("Facebook Page analytics require read_insights, Page reading access, and the Page ANALYZE task. Reconnect the Page.", "permission_missing");
    return credential;
  }

  private async readInsightMetrics(externalPostId: string, accessToken: string, metrics: FacebookPostInsightName[]): Promise<{ data: unknown[]; raw: { requested: FacebookPostInsightName[]; data: unknown[] } }> {
    const query = new URLSearchParams({ metric: metrics.join(","), period: "lifetime" });
    const url = this.correctionUrl(`/${encodeURIComponent(externalPostId)}/insights`, accessToken, query);
    let response: Response;
    try {
      response = await this.transport(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new ProviderAnalyticsError("Facebook Page analytics are temporarily unavailable.", "transient");
    }
    const value = await boundedJson(response);
    if (!response.ok || value.error) throw this.analyticsError(response, value);
    if (!Array.isArray(value.data)) throw new ProviderAnalyticsError("Facebook returned an invalid Page Post insights result.", "provider_failed");
    return { data: value.data, raw: { requested: [...metrics], data: value.data } };
  }

  private parseInsightMetrics(rows: unknown[], requested: readonly FacebookPostInsightName[]): Map<FacebookPostInsightName, number> {
    const allowed = new Set<FacebookPostInsightName>(requested);
    const values = new Map<FacebookPostInsightName, number>();
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProviderAnalyticsError("Facebook returned a malformed Page Post insight.", "provider_failed");
      const row = raw as FacebookInsightResult;
      if (typeof row.name !== "string" || !allowed.has(row.name as FacebookPostInsightName)) throw new ProviderAnalyticsError("Facebook returned an unexpected Page Post metric.", "provider_failed");
      const name = row.name as FacebookPostInsightName;
      if (values.has(name) || row.period !== "lifetime" || !Array.isArray(row.values) || row.values.length !== 1) throw new ProviderAnalyticsError("Facebook returned an incompatible Page Post metric definition.", "provider_failed");
      const metricValue = (row.values[0] as FacebookInsightValue | undefined)?.value;
      if (typeof metricValue !== "number" || !Number.isFinite(metricValue) || metricValue < 0) throw new ProviderAnalyticsError("Facebook returned an invalid Page Post metric value.", "provider_failed");
      values.set(name, metricValue);
    }
    return values;
  }

  private analyticsError(response: Response, value: GraphBody): ProviderAnalyticsError {
    const providerCode = typeof value.error?.code === "number" ? value.error.code : response.status;
    const providerSubcode = typeof value.error?.error_subcode === "number" ? value.error.error_subcode : undefined;
    const retryHeader = Number(response.headers.get("retry-after"));
    const detail = { providerCode, ...(providerSubcode !== undefined ? { providerSubcode } : {}), ...(Number.isFinite(retryHeader) && retryHeader > 0 ? { retryAfterSeconds: Math.min(86_400, retryHeader) } : {}) };
    if (response.status === 401 || providerCode === 190) return new ProviderAnalyticsError("Facebook Page analytics access expired or was revoked. Reconnect the Page.", "permission_missing", detail);
    if (response.status === 403 || providerCode === 10 || (providerCode >= 200 && providerCode <= 299)) return new ProviderAnalyticsError("Facebook Page analytics permission is missing. Reconnect the Page.", "permission_missing", detail);
    if (response.status === 429 || [4, 17, 32, 341, 613, 80001].includes(providerCode)) return new ProviderAnalyticsError("Facebook rate-limited Page analytics.", "rate_limited", detail);
    if (response.status >= 500 || providerCode === 1 || providerCode === 2) return new ProviderAnalyticsError("Facebook Page analytics are temporarily unavailable.", "transient", detail);
    if (providerCode === 100) return new ProviderAnalyticsError("A pinned Facebook Page Post metric is unsupported by this Graph contract.", "unsupported", detail);
    return new ProviderAnalyticsError("Facebook could not return Page Post analytics.", "provider_failed", detail);
  }

  private async deleteProbeEnabled(request: RemoteCorrectionCapabilityRequest, credential: FacebookPagePublishingCredential): Promise<boolean> {
    const probe = this.options.pageDeleteContractProbe;
    const pageTasks=[...new Set(credential.pageTasks?.map((task)=>task.trim()).filter(Boolean)??[])].sort();
    const pageTasksSha256=canonicalSha256({schemaVersion:"originpost.facebook-page-tasks.v1",tasks:pageTasks});
    if (!probe || probe.apiVersion !== this.options.apiVersion || probe.environment !== (this.options.environment ?? "development") || probe.appId !== this.options.appId || probe.accountId !== request.accountId || probe.externalPageId !== credential.externalAccountId || probe.credentialVersion !== credential.credentialVersion || probe.accountVersion !== credential.accountVersion || probe.pageTasksSha256 !== pageTasksSha256 || probe.task !== "page_post_delete" || !pageTasks.includes("CREATE_CONTENT")) return false;
    const verifiedAt=Date.parse(probe.verifiedAt), expiresAt=Date.parse(probe.expiresAt), now=Date.now();
    if(!(Number.isFinite(verifiedAt)&&Number.isFinite(expiresAt)&&verifiedAt<=now&&now<expiresAt&&expiresAt-verifiedAt<=30*24*60*60*1000))return false;
    try {
      const query=new URLSearchParams({fields:"id,tasks"});
      const response=await this.transport(this.correctionUrl(`/${encodeURIComponent(credential.externalAccountId)}`,credential.accessToken,query),{method:"GET",headers:{authorization:`Bearer ${credential.accessToken}`},redirect:"error",signal:AbortSignal.timeout(20_000)});
      const value=await response.json().catch(()=>({})) as GraphBody;
      if(!response.ok||value.error||value.id!==credential.externalAccountId||!Array.isArray(value.tasks)||!value.tasks.every((task)=>typeof task==="string"&&Boolean(task.trim())))return false;
      const currentTasks=[...new Set(value.tasks as string[])].map((task)=>task.trim()).sort();
      return currentTasks.includes("CREATE_CONTENT")&&canonicalSha256({schemaVersion:"originpost.facebook-page-tasks.v1",tasks:currentTasks})===probe.pageTasksSha256;
    }catch{return false;}
  }

  private hasCorrectionScopes(credential: FacebookPagePublishingCredential): boolean {
    const scopes = new Set([...(credential.scopes ?? []), ...(credential.scope?.split(/[\s,]+/).filter(Boolean) ?? [])]);
    return scopes.has("pages_manage_posts") && scopes.has("pages_read_engagement");
  }

  private async correctionCredential(request: RemoteCorrectionCapabilityRequest, requireDelete: boolean): Promise<FacebookPagePublishingCredential> {
    let credential: FacebookPagePublishingCredential;
    try { credential = await this.options.resolveCredential(request); }
    catch { throw new ProviderRemoteCorrectionError("Facebook Page correction access is unavailable. Reconnect the Page.", "authentication"); }
    if (!credential.externalAccountId || !credential.accessToken) throw new ProviderRemoteCorrectionError("Facebook Page correction credential is unavailable.", "authentication");
    if (requireDelete && !this.hasCorrectionScopes(credential)) throw new ProviderRemoteCorrectionError("Facebook Page deletion requires pages_manage_posts and pages_read_engagement.", "permission");
    return credential;
  }

  private correctionUrl(path: string, accessToken: string, query?: URLSearchParams): URL {
    const url = new URL(`${this.baseUrl}/${this.options.apiVersion}${path}`);
    if (query) for (const [key, value] of query) url.searchParams.set(key, value);
    url.searchParams.set("appsecret_proof", createHmac("sha256", this.options.appSecret).update(accessToken).digest("hex"));
    url.searchParams.set("appsecret_time", String(Math.floor(Date.now() / 1000)));
    return url;
  }

  private facebookSnapshot(request: RemoteCorrectionTarget, ownerId: string, state: RemoteContentSnapshot["state"], mutableState: Record<string, unknown>): RemoteContentSnapshot {
    return remoteSnapshot({ ...correctionLineage(request), providerOwnerId: ownerId, state, objectKind: "post", mutableState, observedAt: new Date().toISOString(), providerVersion: this.options.apiVersion });
  }

  private targetFor(operation: ExecuteRemoteCorrectionRequest["operation"]): RemoteCorrectionTarget {
    return { workspaceId: operation.workspaceId, brandId: operation.brandId, publishProofId: operation.publishProofId, contentItemId: operation.contentItemId, draftId: operation.draftId, draftSha256: operation.draftSha256, platform: operation.platform, accountId: operation.accountId, externalPostId: operation.externalPostId, mutation: operation.mutation };
  }

  private correctionError(response: Response, value: GraphBody): ProviderRemoteCorrectionError {
    const providerCode = typeof value.error?.code === "number" ? value.error.code : response.status;
    const providerSubcode = typeof value.error?.error_subcode === "number" ? value.error.error_subcode : undefined;
    const traceId = typeof value.error?.fbtrace_id === "string" ? value.error.fbtrace_id : undefined;
    const detail = { providerCode, ...(providerSubcode !== undefined ? { providerSubcode } : {}), ...(traceId ? { traceId } : {}) };
    if (response.status === 401 || providerCode === 190) return new ProviderRemoteCorrectionError("Facebook Page correction access expired. Reconnect the Page.", "authentication", detail);
    if (response.status === 404) return new ProviderRemoteCorrectionError("The Facebook Page post was not found.", "not_found", detail);
    if (response.status === 429 || [4, 17, 32, 341, 613, 80001].includes(providerCode)) return new ProviderRemoteCorrectionError("Facebook paused Page correction requests because of a provider limit.", "rate_limited", detail);
    if (providerCode === 368) return new ProviderRemoteCorrectionError("Facebook does not allow this Page Post deletion.", "policy_restricted", detail);
    if (response.status === 403 || providerCode === 200 || providerCode === 10) return new ProviderRemoteCorrectionError("Facebook Page deletion permission is unavailable.", "permission", detail);
    if (response.status === 400 || providerCode === 100) return new ProviderRemoteCorrectionError("Facebook rejected the Page correction request.", "invalid_request", detail);
    return new ProviderRemoteCorrectionError("Facebook Page correction request failed.", "transient", detail);
  }

  private rejectedCorrection(error: unknown): RemoteCorrectionOutcome {
    if (error instanceof ProviderRemoteCorrectionError) return { kind: "rejected", category: error.code, reason: error.message };
    return { kind: "rejected", category: "transient", reason: error instanceof Error ? error.message : "Facebook Page correction failed." };
  }

  private async engagementCredential(request: Pick<EngagementRequestScope, "workspaceId" | "accountId">): Promise<FacebookPagePublishingCredential> {
    let credential: FacebookPagePublishingCredential;
    try {
      credential = await this.options.resolveCredential(request);
    } catch {
      throw new ProviderEngagementError("Facebook Page comment access is unavailable. Reconnect the Page.", "permission_missing");
    }
    if (!credential.externalAccountId || !credential.accessToken) {
      throw new ProviderEngagementError("Facebook Page comment access is unavailable. Reconnect the Page.", "permission_missing");
    }
    return credential;
  }

  private async readCommentEdge(path: string, accessToken: string, query: URLSearchParams, parentExternalCommentId?: string): Promise<{ comments: ProviderEngagementComment[]; rawPages: unknown[] }> {
    const comments: ProviderEngagementComment[] = [];
    const rawPages: unknown[] = [];
    let next: string | undefined = path;
    let nextQuery: URLSearchParams | undefined = query;
    const maxPages = Math.max(1, Math.min(this.options.maxCommentPages ?? 50, 100));
    for (let page = 0; next && page < maxPages; page += 1) {
      const value = await this.engagementCall(next, accessToken, { method: "GET", ...(nextQuery ? { query: nextQuery } : {}) });
      nextQuery = undefined;
      if (!Array.isArray(value.data)) throw new ProviderEngagementError("Facebook returned an invalid comment page.", "provider_failed");
      const mapped = value.data.map((item) => this.mapComment(item, parentExternalCommentId));
      comments.push(...mapped);
      const providerNext = typeof value.paging?.next === "string" && value.paging.next ? value.paging.next : undefined;
      rawPages.push({
        data: mapped,
        paging: {
          hasNext: Boolean(providerNext),
          ...(typeof value.paging?.cursors?.before === "string" ? { before: value.paging.cursors.before } : {}),
          ...(typeof value.paging?.cursors?.after === "string" ? { after: value.paging.cursors.after } : {}),
        },
      });
      next = providerNext;
      if (next && page + 1 === maxPages) throw new ProviderEngagementError("Facebook returned more comment pages than the safe reconciliation limit.", "provider_failed");
    }
    return { comments, rawPages };
  }

  private mapComment(value: unknown, fallbackParentId?: string): ProviderEngagementComment {
    if (!value || typeof value !== "object") throw new ProviderEngagementError("Facebook returned an invalid comment.", "provider_failed");
    const item = value as FacebookGraphComment;
    if (typeof item.id !== "string" || typeof item.message !== "string" || typeof item.is_hidden !== "boolean") {
      throw new ProviderEngagementError("Facebook omitted required comment fields.", "provider_failed");
    }
    const parent = typeof item.parent?.id === "string" ? item.parent.id : fallbackParentId;
    const authorScopedId = typeof item.from?.id === "string" ? item.from.id : undefined;
    const authorName = typeof item.from?.name === "string" ? item.from.name : undefined;
    return {
      externalCommentId: item.id,
      ...(parent ? { parentExternalCommentId: parent } : {}),
      ...(authorScopedId ? { authorScopedId } : {}),
      ...(authorName ? { authorUsername: authorName } : {}),
      body: item.message,
      visibility: item.is_hidden ? "hidden" : "visible",
      ...(typeof item.created_time === "string" ? { providerCreatedAt: item.created_time } : {}),
    };
  }

  private engagementUrl(pathOrUrl: string, accessToken: string, query?: URLSearchParams): URL {
    const trusted = new URL(this.baseUrl);
    const url = /^https?:\/\//.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(`${this.baseUrl}/${this.options.apiVersion}${pathOrUrl}`);
    if (url.origin !== trusted.origin || !url.pathname.startsWith(`/${this.options.apiVersion}/`)) {
      throw new ProviderEngagementError("Facebook returned an untrusted pagination URL.", "provider_failed");
    }
    for (const key of ["access_token", "appsecret_proof", "appsecret_time"]) url.searchParams.delete(key);
    if (query) for (const [key, value] of query) url.searchParams.set(key, value);
    url.searchParams.set("appsecret_proof", createHmac("sha256", this.options.appSecret).update(accessToken).digest("hex"));
    url.searchParams.set("appsecret_time", String(Math.floor(Date.now() / 1000)));
    return url;
  }

  private async engagementCall(pathOrUrl: string, accessToken: string, input: { method: "GET" | "POST"; query?: URLSearchParams }): Promise<GraphBody> {
    const url = this.engagementUrl(pathOrUrl, accessToken, input.query);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: input.method,
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderEngagementError("Facebook Page comments are temporarily unavailable.", "provider_failed");
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) throw this.engagementError(response, value);
    return value;
  }

  private engagementError(response: Response, value: GraphBody): ProviderEngagementError {
    const providerCode = typeof value.error?.code === "number" ? value.error.code : response.status;
    const providerSubcode = typeof value.error?.error_subcode === "number" ? value.error.error_subcode : undefined;
    const traceId = typeof value.error?.fbtrace_id === "string" ? value.error.fbtrace_id : undefined;
    const retryAfterHeader = response.headers.get("retry-after");
    const parsedRetryAfter = retryAfterHeader === null ? undefined : Number.parseInt(retryAfterHeader, 10);
    const retryAfterSeconds = parsedRetryAfter !== undefined && Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0 ? parsedRetryAfter : undefined;
    const detail = {
      providerCode,
      ...(providerSubcode !== undefined ? { providerSubcode } : {}),
      ...(traceId ? { traceId } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
    if (response.status === 401 || providerCode === 190 || (providerSubcode !== undefined && [458, 459, 460, 463, 464, 467].includes(providerSubcode))) {
      return new ProviderEngagementError("Facebook Page access expired or was removed. Reconnect the Page.", "expired", detail);
    }
    if (providerCode === 210 || response.status === 404) {
      return new ProviderEngagementError("This Facebook Page comment or post is not visible to the connected Page.", "not_found", detail);
    }
    if (providerCode === 492 || providerSubcode === 492 || providerCode === 3 || providerCode === 10 || (providerCode >= 200 && providerCode <= 299) || response.status === 403) {
      return new ProviderEngagementError("Facebook Page comment permission or the required Page task is missing. Reconnect the Page.", "permission_missing", detail);
    }
    if (response.status === 429 || [4, 17, 32, 341, 613, 80001].includes(providerCode)) {
      return new ProviderEngagementError("Facebook paused Page comment requests because of a provider limit.", "rate_limited", detail);
    }
    if (providerCode === 100 || response.status === 400) {
      return new ProviderEngagementError("Facebook does not support this Page comment request.", "unsupported", detail);
    }
    return new ProviderEngagementError("Facebook Page comment request failed.", "provider_failed", detail);
  }

  private firstCommentError(response: Response, value: GraphBody): ProviderFirstCommentError {
    const error = this.engagementError(response, value);
    const code = error.code === "permission_missing" || error.code === "expired" ? "permission_missing" : error.code === "unsupported" ? "unsupported" : error.code === "rate_limited" ? "rate_limited" : "provider_failed";
    return new ProviderFirstCommentError(error.message, code, error.detail);
  }

  private async call(path: string, accessToken: string, input: { method: "GET" | "POST"; body?: URLSearchParams }): Promise<GraphBody> {
    const appsecretProof = createHmac("sha256", this.options.appSecret).update(accessToken).digest("hex");
    const url = new URL(`${this.baseUrl}/${this.options.apiVersion}${path}`);
    url.searchParams.set("appsecret_proof", appsecretProof);
    url.searchParams.set("appsecret_time", String(Math.floor(Date.now() / 1000)));
    let response: Response;
    try {
      response = await this.transport(url, {
        method: input.method,
        headers: { authorization: `Bearer ${accessToken}`, ...(input.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        ...(input.body ? { body: input.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Facebook may have received this publish request, but OriginPost did not receive a result. Reconcile the Page before retrying.");
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) throw facebookError(response, value);
    return value;
  }
}
