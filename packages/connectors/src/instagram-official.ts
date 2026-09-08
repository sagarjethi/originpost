import { createHash } from "node:crypto";
import {
  assertApprovedInstagramPublishSettings,
  assertInstagramPublishApprovalBinding,
  assertInstagramCollaboratorFormat,
  assertInstagramReelCoverForDraft,
  assertInstagramStoryAutoPublish,
  assertInstagramStorySettings,
  collaboratorInviteProof,
  instagramCollaboratorCapability,
  instagramStoryCapability,
  normalizeInstagramCollaborators,
  normalizeInstagramPublisherUsername,
  instagramRequestedUsernamesHash,
  canonicalSha256,
  DomainError,
} from "@originpost/domain";
import type { CollaboratorInviteProof, CurrentCollaboratorStatusSnapshot, InstagramAccountType, InstagramCollaboratorCapability, InstagramCollaboratorCapabilityContext, InstagramCollaboratorEndpointFamily, InstagramConnectionMode, InstagramPublishSettings, InstagramStoryCapability } from "@originpost/domain";
import { MockInstagramConnector } from "./mock.js";
import { ProviderAnalyticsError, ProviderEngagementError, ProviderPublishError } from "./types.js";
import type { AnalyticsRequest, AnalyticsResult, CommentPage, ConnectorManifest, EngagementConnector, EngagementRequestScope, InstagramCollaboratorStatusResult, PlatformConnector, ProviderEngagementComment, PublishRequest, PublishResult, ReadCommentsRequest, ReadInstagramCollaboratorStatusesRequest, ReplyToCommentRequest, ReplyToCommentResult, SubscribeCommentsRequest, SubscriptionResult, ValidationIssue } from "./types.js";
import { assertCorrectionExecution, correctionLineage, correctionResult, ProviderRemoteCorrectionError, remoteSnapshot } from "./remote-correction.js";
import type { ExecuteRemoteCorrectionRequest, ReconcileRemoteCorrectionRequest, RemoteContentObservation, RemoteContentSnapshot, RemoteCorrectionCapabilityRequest, RemoteCorrectionCapabilitySet, RemoteCorrectionConnector, RemoteCorrectionOutcome, RemoteCorrectionTarget } from "./remote-correction.js";
import { ProviderFirstCommentError } from "./first-comment.js";
import type { CreateFirstCommentRequest, FirstCommentCapability, FirstCommentConnector, FirstCommentObservation, FirstCommentScope, InspectFirstCommentRequest } from "./first-comment.js";

export interface InstagramPublishingCredential {
  externalAccountId: string;
  accessToken: string;
  /** Server-derived from Meta account discovery. Legacy/missing values fail closed for Stories. */
  accountType?: InstagramAccountType | undefined;
  connectionMode?: InstagramConnectionMode | undefined;
  /** Server-derived canonical publisher username. Legacy `username` is display-only and is not an approval authority. */
  canonicalUsername?: string | undefined;
  username?: string | undefined;
  scope?: string | undefined;
  scopes?: readonly string[] | undefined;
  endpointFamily?: InstagramCollaboratorEndpointFamily | undefined;
  collaboratorEndpointProbe?: { state: "verified" | "failed" | "not_run"; apiVersion?: string | undefined } | undefined;
}

export interface InstagramPublishingOperation {
  containerId: string;
  childContainerIds: string[];
  collaboratorInviteProof: CollaboratorInviteProof;
}

export interface InstagramOfficialConnectorOptions {
  apiVersion: string;
  resolveCredential(request: Pick<PublishRequest, "workspaceId" | "accountId"> | Pick<EngagementRequestScope, "workspaceId" | "accountId"> | RemoteCorrectionCapabilityRequest): Promise<InstagramPublishingCredential>;
  fetch?: typeof fetch;
  baseUrl?: string;
  facebookGraphBaseUrl?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  maxCommentPages?: number;
}

type GraphBody = {
  id?: string;
  permalink?: string;
  is_ai_generated?: boolean;
  status_code?: string;
  status?: string;
  success?: boolean;
  deleted_id?: string;
  media_type?: string;
  media_product_type?: string;
  username?: string;
  owner?: { id?: string };
  data?: Array<{
    name?: string;
    period?: string;
    values?: Array<{ value?: unknown }>;
    total_value?: { value?: unknown };
  }>;
  error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string };
};

type EngagementGraphComment = {
  id?: unknown;
  text?: unknown;
  hidden?: unknown;
  timestamp?: unknown;
  username?: unknown;
  parent_id?: unknown;
  from?: { id?: unknown; username?: unknown };
};

type EngagementGraphBody = {
  id?: unknown;
  success?: unknown;
  data?: unknown;
  paging?: { next?: unknown; cursors?: { before?: unknown; after?: unknown } };
  error?: { message?: unknown; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string };
};

type CollaboratorGraphBody = {
  data?: unknown;
  paging?: { next?: unknown } | undefined;
  error?: { code?: number; error_subcode?: number; type?: string };
};

const instagramMetrics = ["views", "reach", "likes", "comments", "saved", "shares"] as const;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export class InstagramOfficialConnector implements PlatformConnector, EngagementConnector, RemoteCorrectionConnector, FirstCommentConnector {
  readonly manifest = {
    id: "originpost.instagram.official", name: "Instagram", platform: "instagram", version: "0.1.0", apiMode: "official",
    capabilities: { formats: ["image", "carousel", "reel", "story"], analytics: true, comments: true, tokenRefresh: true, pendingPublishing: true },
    limits: { captionCharacters: 2200, maxMedia: 10, maxVideoBytes: 4_000_000_000 },
  } satisfies ConnectorManifest;
  private readonly transport: typeof fetch;
  private readonly baseUrl: string;
  private readonly correctionBaseUrl: string;

  constructor(private readonly options: InstagramOfficialConnectorOptions) {
    if (!/^v\d+\.\d+$/.test(options.apiVersion)) throw new Error("Instagram apiVersion must look like v23.0.");
    this.transport = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://graph.instagram.com").replace(/\/$/, "");
    this.correctionBaseUrl = (options.facebookGraphBaseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
    for (const value of [this.baseUrl, this.correctionBaseUrl]) {
      const origin = new URL(value);
      if (
        origin.protocol !== "https:"
        || origin.username
        || origin.password
        || origin.search
        || origin.hash
        || origin.pathname !== "/"
      ) {
        throw new Error("Instagram provider origins must be exact HTTPS origins without credentials, path, query, or fragment.");
      }
    }
  }

  async validate(request: PublishRequest): Promise<ValidationIssue[]> {
    const issues = await new MockInstagramConnector().validate(request);
    if (request.format === "story") {
      try {
        assertInstagramStorySettings(request.settings);
        this.collaboratorSettings(request.settings, undefined, request);
      } catch (error) {
        issues.push({
          field: "settings",
          code: this.domainErrorCode(error, "instagram_story_settings_unsupported"),
          message: error instanceof Error ? error.message : "Instagram Story settings are unsupported.",
          severity: "error",
        });
      }
      let accountType: InstagramAccountType | undefined;
      try {
        accountType = (await this.options.resolveCredential(request)).accountType;
      } catch {
        accountType = undefined;
      }
      try {
        assertInstagramStoryAutoPublish({ accountType });
      } catch (error) {
        const code = this.domainErrorCode(error, "instagram_story_account_type_unavailable");
        issues.push({
          field: "accountId",
          code,
          message: error instanceof Error ? error.message : "Instagram Story account eligibility is unavailable.",
          severity: "error",
        });
      }
      return issues;
    }
    try {
      const settings = this.collaboratorSettings(request.settings, undefined, request);
      assertInstagramCollaboratorFormat(request.format, Boolean(settings?.collaborators.length));
      assertInstagramReelCoverForDraft(settings?.reelCover, request.format, request.media[0]?.durationMs, true);
      if (settings?.reelCover?.mode === "custom_image") {
        const cover = request.coverMedia;
        if (!cover || cover.id !== settings.reelCover.mediaId || cover.sha256 !== settings.reelCover.mediaSha256 || cover.type !== "image" || cover.inspectionStatus !== "ready") throw new DomainError("The approved Reel cover image is unavailable or changed.", "instagram_reel_cover_stale", 409);
      } else if (request.coverMedia) throw new DomainError("A cover image was supplied without an approved custom-cover selection.", "instagram_reel_cover_unapproved", 409);
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error && typeof error.code === "string"
        ? error.code
        : "instagram_collaborator_invalid_syntax";
      issues.push({
        field: code.startsWith("instagram_reel_") ? "settings.reelCover" : "settings.collaborators",
        code,
        message: error instanceof Error ? error.message : "Instagram collaborator settings are invalid.",
        severity: "error",
      });
    }
    return issues;
  }

  async getStoryCapability(request: Pick<PublishRequest, "workspaceId" | "accountId">): Promise<InstagramStoryCapability> {
    try {
      const credential = await this.options.resolveCredential(request);
      return instagramStoryCapability({ accountType: credential.accountType });
    } catch {
      return instagramStoryCapability(undefined);
    }
  }

  async getCollaboratorCapability(request: Pick<PublishRequest, "workspaceId" | "accountId">): Promise<InstagramCollaboratorCapability> {
    return (await this.getCollaboratorIdentity(request)).capability;
  }

  async getCollaboratorIdentity(request: Pick<PublishRequest, "workspaceId" | "accountId">): Promise<{ capability: InstagramCollaboratorCapability; publishingUsername?: string }> {
    try {
      const credential = await this.options.resolveCredential(request);
      const publisher = credential.canonicalUsername ?? credential.username;
      return {
        capability: instagramCollaboratorCapability(this.collaboratorCapabilityContext(credential)),
        ...(publisher ? { publishingUsername: normalizeInstagramPublisherUsername(publisher) } : {}),
      };
    } catch {
      return { capability: instagramCollaboratorCapability(undefined) };
    }
  }

  /** Read-only recovery check used before minting proof for an AI-labelled post. */
  async inspectAiDisclosure(request: { workspaceId: string; accountId: string; externalMediaId: string }): Promise<{ externalMediaId: string; liveUrl: string; isAiGenerated: true; providerResponseSha256: string }> {
    const credential = await this.options.resolveCredential(request);
    const value = await this.call(
      `/${encodeURIComponent(request.externalMediaId)}`,
      credential.accessToken,
      undefined,
      new URLSearchParams({ fields: "id,permalink,is_ai_generated" }),
      this.publishProviderBase(undefined, credential),
    );
    if (value.id !== request.externalMediaId || typeof value.permalink !== "string" || !value.permalink.startsWith("https://www.instagram.com/") || value.is_ai_generated !== true) {
      throw new DomainError("Instagram did not verify the native AI info label for this exact media ID.", "instagram_ai_disclosure_unverified", 409);
    }
    return {
      externalMediaId: value.id,
      liveUrl: value.permalink,
      isAiGenerated: true,
      providerResponseSha256: canonicalSha256({ id: value.id, permalink: value.permalink, isAiGenerated: true }),
    };
  }

  async correctionCapabilities(request: RemoteCorrectionCapabilityRequest): Promise<RemoteCorrectionCapabilitySet> {
    if (request.platform !== "instagram") throw new ProviderRemoteCorrectionError("This connector only corrects Instagram media.", "invalid_request");
    let credential: InstagramPublishingCredential | undefined;
    try { credential = await this.options.resolveCredential(request); }
    catch { credential = undefined; }
    const facebookLogin = credential?.connectionMode === "facebook_login";
    const scoped = credential ? this.hasManageContentsScope(credential) : false;
    const deleteCapability = !facebookLogin
      ? { state: "unsupported" as const, reason: "Instagram API deletion is available only for Facebook Login connections." }
      : scoped
        ? { state: "supported" as const }
        : { state: "scope_required" as const, reason: "Reconnect Instagram and grant instagram_manage_contents before deleting live media." };
    const unsupported = { state: "unsupported" as const, reason: "The official Instagram media contract does not expose this correction action." };
    return {
      platform: "instagram",
      providerVersion: this.options.apiVersion,
      resolvedAt: new Date().toISOString(),
      actions: {
        edit_text: unsupported,
        make_private: unsupported,
        restore_visibility: unsupported,
        delete_remote: deleteCapability,
        manual_remove: { state: "manual_only", reason: "Use Instagram's native app for archive or unsupported removal and attach operator evidence." },
      },
    };
  }

  async preflightCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    if (request.platform !== "instagram") throw new ProviderRemoteCorrectionError("This connector only corrects Instagram media.", "invalid_request");
    const credential = await this.correctionCredential(request);
    return this.readCorrectionSnapshot(request, credential);
  }

  async preflightManualCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    if (request.platform !== "instagram") throw new ProviderRemoteCorrectionError("This connector only corrects Instagram media.", "invalid_request");
    return this.readCorrectionSnapshot(request, await this.identityCredential(request));
  }

  private async readCorrectionSnapshot(request: RemoteCorrectionTarget, credential: InstagramPublishingCredential): Promise<RemoteContentSnapshot> {
    let response: Response;
    try {
      const query = new URLSearchParams({ fields: "id,media_type,media_product_type,owner,permalink,username" });
      const graphBase = credential.connectionMode === "facebook_login" ? this.correctionBaseUrl : this.baseUrl;
      response = await this.transport(`${graphBase}/${this.options.apiVersion}/${encodeURIComponent(request.externalPostId)}?${query.toString()}`, {
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderRemoteCorrectionError("Instagram media state could not be read.", "transient");
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) {
      const error = this.correctionError(response, value);
      if (error.code === "not_found") return this.instagramSnapshot(request, credential.externalAccountId, "not_found", "unknown", {});
      throw error;
    }
    if (value.id !== request.externalPostId) throw new ProviderRemoteCorrectionError("Instagram returned different media than the approved publication.", "invalid_request");
    if (!value.owner?.id) throw new ProviderRemoteCorrectionError("Instagram did not return the media owner required to verify publication lineage.", "uncertain");
    if (value.owner.id !== credential.externalAccountId) throw new ProviderRemoteCorrectionError("Instagram returned media owned by another account.", "permission");
    const objectKind = value.media_type === "CAROUSEL_ALBUM" ? "carousel_container" : value.media_product_type === "REELS" ? "reel" : value.media_product_type === "STORY" ? "story" : "post";
    return this.instagramSnapshot(request, credential.externalAccountId, "live", objectKind, {
      mediaType: value.media_type ?? "unknown",
      mediaProductType: value.media_product_type ?? "unknown",
      ...(value.username ? { username: value.username } : {}),
    });
  }

  async executeCorrection(request: ExecuteRemoteCorrectionRequest): Promise<RemoteCorrectionOutcome> {
    assertCorrectionExecution(request, "instagram");
    const operation = request.operation;
    if (operation.mutation.action === "manual_remove") return { kind: "manual_action_required", reason: "Open the native Instagram media, remove or archive it, and attach operator evidence.", handoff: "instagram_native" };
    if (operation.mutation.action !== "delete_remote") return { kind: "rejected", category: "unsupported", reason: "The official Instagram media contract does not support this correction action." };
    let credential: InstagramPublishingCredential;
    try { credential = await this.correctionCredential(operation); }
    catch (error) { return this.rejectedCorrection(error); }
    let response: Response;
    try {
      response = await this.transport(`${this.correctionBaseUrl}/${this.options.apiVersion}/${encodeURIComponent(operation.externalPostId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { kind: "uncertain", reason: "Instagram may have received the deletion. Reconcile before any further action." };
    }
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) return this.rejectedCorrection(this.correctionError(response, value));
    if (value.success !== true || value.deleted_id !== operation.externalPostId) return { kind: "uncertain", reason: "Instagram did not return the approved media ID in its deletion receipt. Reconcile before any further action." };
    let after: RemoteContentSnapshot;
    try { after = await this.preflightCorrection(this.targetFor(operation)); }
    catch { return { kind: "uncertain", reason: "Instagram confirmed deletion, but OriginPost could not complete read-after-write verification." }; }
    if (after.state !== "not_found") return { kind: "uncertain", reason: "Instagram confirmed deletion, but the media is still returned by read-after-write verification." };
    const occurredAt = new Date().toISOString();
    return {
      kind: "provider_confirmed",
      receipt: { provider: "instagram", action: "delete_remote", externalPostId: operation.externalPostId, occurredAt, responseSha256: canonicalSha256({ success: true, deletedId: value.deleted_id }) },
      after,
    };
  }

  async reconcileCorrection(request: ReconcileRemoteCorrectionRequest): Promise<RemoteContentObservation> {
    const snapshot = await this.preflightCorrection(this.targetFor(request.operation));
    return { snapshot, result: correctionResult(request.operation, snapshot) };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const operation = await this.createOperation(request);
    await this.waitUntilOperationReady(request, operation.containerId);
    return this.finalizeOperation(request, operation.containerId);
  }

  async readPostAnalytics(request: AnalyticsRequest): Promise<AnalyticsResult> {
    if (request.platform !== "instagram") throw new ProviderAnalyticsError("This connector only reads Instagram analytics.", "unsupported");
    let credential: InstagramPublishingCredential;
    try {
      credential = await this.options.resolveCredential(request);
    } catch {
      throw new ProviderAnalyticsError("Instagram analytics access is unavailable. Reconnect the account.", "permission_missing");
    }
    if (!credential.externalAccountId || !credential.accessToken) {
      throw new ProviderAnalyticsError("Instagram analytics access is unavailable. Reconnect the account.", "permission_missing");
    }

    const query = new URLSearchParams({ metric: instagramMetrics.join(","), period: "lifetime" });
    const response = await this.transport(`${this.baseUrl}/${this.options.apiVersion}/${encodeURIComponent(request.externalPostId)}/insights?${query.toString()}`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) throw this.analyticsError(response, value);

    const byName = new Map((value.data ?? []).map((entry) => [entry.name, entry]));
    const read = (name: string): number | undefined => {
      const entry = byName.get(name);
      const raw = entry?.total_value?.value ?? entry?.values?.[0]?.value;
      return finiteNonNegative(raw) ? raw : undefined;
    };
    const metrics: AnalyticsResult["metrics"] = [];
    const mappings = [
      ["views", "views", ["Meta marks this metric as in development; it excludes ad-media plays."]],
      ["reach", "reach", ["Meta reports reach as an estimate."]],
      ["likes", "likes", []],
      ["comments", "comments", []],
      ["shares", "shares", []],
      ["saved", "saves", []],
    ] as const;
    for (const [rawName, key, caveats] of mappings) {
      const metric = read(rawName);
      if (metric !== undefined) metrics.push({
        key,
        value: metric,
        unit: "count",
        rawMetric: rawName,
        source: "instagram_media_insights",
        coverage: "organic",
        definitionVersion: this.options.apiVersion,
        ...(caveats.length ? { caveats: [...caveats] } : {}),
      });
    }
    return {
      capturedAt: new Date().toISOString(),
      period: "lifetime",
      metrics,
      status: metrics.length ? "ready" : "unavailable",
      caveats: ["Instagram Insights can be delayed by up to 48 hours. Missing metrics are not zero."],
      rawResponse: value,
    };
  }

  async readComments(request: ReadCommentsRequest): Promise<CommentPage> {
    if (request.platform !== "instagram") throw new ProviderEngagementError("This connector only reads Instagram comments.", "unsupported");
    const credential = await this.engagementCredential(request);
    const fields = "from,hidden,id,parent_id,text,timestamp,username";
    const top = await this.readCommentEdge(`/${encodeURIComponent(request.externalMediaId)}/comments`, credential.accessToken, new URLSearchParams({ fields, limit: "100" }));
    const comments = [...top.comments];
    const rawPages: unknown[] = [...top.rawPages];
    for (const parent of top.comments) {
      const replies = await this.readCommentEdge(`/${encodeURIComponent(parent.externalCommentId)}/replies`, credential.accessToken, new URLSearchParams({ fields, limit: "100" }), parent.externalCommentId);
      comments.push(...replies.comments);
      rawPages.push(...replies.rawPages);
    }
    comments.sort((a, b) => (a.providerCreatedAt ?? "").localeCompare(b.providerCreatedAt ?? "") || a.externalCommentId.localeCompare(b.externalCommentId));
    return { comments, fetchedAt: new Date().toISOString(), complete: true, rawResponse: { pageCount: rawPages.length, pages: rawPages } };
  }

  async replyToComment(request: ReplyToCommentRequest): Promise<ReplyToCommentResult> {
    if (request.platform !== "instagram") throw new ProviderEngagementError("This connector only replies to Instagram comments.", "unsupported");
    const credential = await this.engagementCredential(request);
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}/${this.options.apiVersion}/${encodeURIComponent(request.externalCommentId)}/replies`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message: request.body.normalize("NFC") }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderEngagementError("Instagram may have received this reply, but OriginPost did not receive a result. Reconcile it before retrying.", "uncertain");
    }
    const value = await response.json().catch(() => ({})) as EngagementGraphBody;
    if (!response.ok || value.error) throw this.engagementError(response, value);
    if (typeof value.id !== "string" || !value.id) throw new ProviderEngagementError("Instagram did not return a reply ID. Reconcile this reply before retrying.", "uncertain");
    return { externalReplyId: value.id, createdAt: new Date().toISOString(), rawResponse: { id: value.id } };
  }

  async firstCommentCapability(scope: FirstCommentScope): Promise<FirstCommentCapability> {
    if (scope.platform !== "instagram") return { state: "unsupported", platform: "instagram", providerVersion: this.options.apiVersion, reason: "This connector supports only Instagram first comments.", maxCharacters: 2_200 };
    let credential: InstagramPublishingCredential;
    try { credential = await this.engagementCredential(scope); }
    catch { return { state: "permission_missing", platform: "instagram", providerVersion: this.options.apiVersion, reason: "Reconnect Instagram with comment-management access.", maxCharacters: 2_200 }; }
    const scopes = new Set([...(credential.scopes ?? []), ...(credential.scope?.split(/[\s,]+/u).filter(Boolean) ?? [])]);
    const required = credential.connectionMode === "facebook_login" ? "instagram_manage_comments" : "instagram_business_manage_comments";
    return scopes.has(required)
      ? { state: "supported", platform: "instagram", providerVersion: this.options.apiVersion, maxCharacters: 2_200 }
      : { state: "permission_missing", platform: "instagram", providerVersion: this.options.apiVersion, reason: `Instagram first comments require ${required}.`, maxCharacters: 2_200 };
  }

  async createFirstComment(request: CreateFirstCommentRequest) {
    const capability = await this.firstCommentCapability(request);
    if (capability.state !== "supported") throw new ProviderFirstCommentError(capability.reason, capability.state);
    const credential = await this.engagementCredential(request);
    const providerBase = credential.connectionMode === "facebook_login" ? this.correctionBaseUrl : this.baseUrl;
    let response: Response;
    try { response = await this.transport(`${providerBase}/${this.options.apiVersion}/${encodeURIComponent(request.externalPostId)}/comments`, { method: "POST", headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: request.body.normalize("NFC") }), redirect: "error", signal: AbortSignal.timeout(20_000) }); }
    catch { throw new ProviderFirstCommentError("Instagram may have received the first comment. Reconcile before any further write.", "uncertain"); }
    const value = await response.json().catch(() => ({})) as EngagementGraphBody;
    if (!response.ok || value.error) throw this.firstCommentError(response, value);
    if (typeof value.id !== "string" || !value.id) throw new ProviderFirstCommentError("Instagram accepted the first-comment request without returning a comment ID. Reconcile before any further write.", "uncertain");
    const providerAcceptedAt = new Date().toISOString();
    return { providerCommentId: value.id, providerAcceptedAt, providerResponseSha256: canonicalSha256({ provider: "instagram", externalPostId: request.externalPostId, providerCommentId: value.id, providerAcceptedAt }) };
  }

  async inspectFirstComment(request: InspectFirstCommentRequest): Promise<FirstCommentObservation> {
    const credential = await this.engagementCredential(request);
    const page = await this.readComments({ workspaceId: request.workspaceId, accountId: request.accountId, platform: "instagram", brandId: "provider-internal", externalMediaId: request.externalPostId });
    const matches = page.comments.filter((comment) => !comment.parentExternalCommentId && comment.authorScopedId === credential.externalAccountId && comment.body.normalize("NFC").trim() === request.body.normalize("NFC").trim() && (!request.providerCommentId || comment.externalCommentId === request.providerCommentId) && (!comment.providerCreatedAt || Date.parse(comment.providerCreatedAt) >= Date.parse(request.earliestCreatedAt) - 60_000));
    const observedAt = new Date().toISOString();
    const providerResponseSha256 = canonicalSha256({ provider: "instagram", externalPostId: request.externalPostId, requestedCommentId: request.providerCommentId ?? null, matches: matches.map((entry) => ({ id: entry.externalCommentId, createdAt: entry.providerCreatedAt ?? null })) });
    if (matches.length !== 1) return { state: matches.length ? "ambiguous" : "not_found", observedAt, providerResponseSha256 };
    return { state: "matched", providerCommentId: matches[0]!.externalCommentId, providerAcceptedAt: matches[0]!.providerCreatedAt ?? observedAt, providerResponseSha256, observedAt };
  }

  async subscribeToComments(request: SubscribeCommentsRequest): Promise<SubscriptionResult> {
    if (request.platform !== "instagram") throw new ProviderEngagementError("This connector only subscribes Instagram accounts.", "unsupported");
    const credential = await this.engagementCredential(request);
    const query = new URLSearchParams({ subscribed_fields: "comments" });
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}/${this.options.apiVersion}/${encodeURIComponent(request.externalAccountId)}/subscribed_apps?${query.toString()}`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderEngagementError("Instagram comment subscription is temporarily unavailable.", "provider_failed");
    }
    const value = await response.json().catch(() => ({})) as EngagementGraphBody;
    if (!response.ok || value.error) throw this.engagementError(response, value);
    if (value.success !== true) throw new ProviderEngagementError("Instagram did not confirm the comment subscription.", "provider_failed");
    return { subscribed: true, fields: ["comments"], rawResponse: { success: true } };
  }

  async createOperation(request: PublishRequest): Promise<InstagramPublishingOperation> {
    const errors = (await this.validate(request)).filter((issue) => issue.severity === "error");
    if (errors.length) {
      const first = errors[0]!;
      if (request.format === "story") throw new DomainError(first.message, first.code, 409);
      throw new Error(errors.map((issue) => issue.message).join(" "));
    }
    const credential = await this.options.resolveCredential(request);
    if (!credential.externalAccountId || !credential.accessToken) throw new Error("Instagram publishing credential is unavailable.");
    if (request.format === "story") {
      assertInstagramStorySettings(request.settings);
      assertInstagramStoryAutoPublish({ accountType: credential.accountType });
    }
    const settings = this.collaboratorSettings(request.settings, credential.canonicalUsername, request);
    this.assertCollaboratorCredential(settings, credential);
    const providerBase = this.publishProviderBase(settings, credential);
    const inviteProof = collaboratorInviteProof(settings, credential.connectionMode);
    return request.format === "carousel"
      ? await this.createCarousel(request, credential, settings, inviteProof, providerBase)
      : { containerId: await this.createSingle(request, credential, settings, providerBase), childContainerIds: [], collaboratorInviteProof: inviteProof };
  }

  async waitUntilOperationReady(request: PublishRequest, containerId: string): Promise<void> {
    const credential = await this.options.resolveCredential(request);
    if (!credential.accessToken) throw new Error("Instagram publishing credential is unavailable.");
    if (request.format === "story") {
      assertInstagramStorySettings(request.settings);
      assertInstagramStoryAutoPublish({ accountType: credential.accountType });
    }
    const settings = this.collaboratorSettings(request.settings, credential.canonicalUsername, request);
    this.assertCollaboratorCredential(settings, credential);
    await this.waitUntilReady(containerId, credential.accessToken, this.publishProviderBase(settings, credential));
  }

  async finalizeOperation(request: PublishRequest, containerId: string): Promise<Extract<PublishResult, { status: "published" }>> {
    const credential = await this.options.resolveCredential(request);
    if (!credential.externalAccountId || !credential.accessToken) throw new Error("Instagram publishing credential is unavailable.");
    if (request.format === "story") {
      assertInstagramStorySettings(request.settings);
      assertInstagramStoryAutoPublish({ accountType: credential.accountType });
    }
    const settings = this.collaboratorSettings(request.settings, credential.canonicalUsername, request);
    this.assertCollaboratorCredential(settings, credential);
    const providerBase = this.publishProviderBase(settings, credential);
    const inviteProof = collaboratorInviteProof(settings, credential.connectionMode);
    let published: GraphBody;
    try {
      published = await this.call(`/${encodeURIComponent(credential.externalAccountId)}/media_publish`, credential.accessToken, new URLSearchParams({ creation_id: containerId }), undefined, providerBase);
    } catch {
      throw new ProviderPublishError(
        "Instagram may have published this media. Reconcile the container before retrying.",
        "uncertain",
        { containerId },
      );
    }
    if (!published.id) {
      throw new ProviderPublishError("Instagram did not return a published media ID. Reconcile before retrying.", "uncertain", { containerId });
    }
    let media: GraphBody;
    try {
      media = await this.call(`/${encodeURIComponent(published.id)}`, credential.accessToken, undefined, new URLSearchParams({ fields: "permalink,is_ai_generated" }), providerBase);
    } catch {
      throw new ProviderPublishError(
        "Instagram published the media, but its permalink is unavailable. Reconcile before retrying.",
        "uncertain",
        { containerId, externalPostId: published.id },
      );
    }
    if (!media.permalink || !media.permalink.startsWith("https://www.instagram.com/")) {
      throw new ProviderPublishError(
        "Instagram published the media, but did not return a valid permalink. Reconcile before retrying.",
        "uncertain",
        { containerId, externalPostId: published.id },
      );
    }
    if (settings?.isAiGenerated === true && media.is_ai_generated !== true) {
      throw new ProviderPublishError(
        "Instagram published the media, but its native AI info label was not verified. Reconcile before recording proof.",
        "uncertain",
        { containerId, externalPostId: published.id },
      );
    }
    return {
      status: "published",
      externalPostId: published.id,
      liveUrl: media.permalink,
      rawResponse: { containerId, mediaId: published.id, permalink: media.permalink, collaboratorInviteProof: inviteProof, isAiGenerated: media.is_ai_generated === true },
    };
  }

  async readCollaboratorStatuses(request: ReadInstagramCollaboratorStatusesRequest): Promise<InstagramCollaboratorStatusResult> {
    const requestedUsernames = normalizeInstagramCollaborators(request.requestedUsernames);
    const capturedAt = new Date().toISOString();
    const expectedUsernamesSha256 = instagramRequestedUsernamesHash(requestedUsernames);
    if (!/^[a-f0-9]{64}$/u.test(request.requestedUsernamesSha256) || request.requestedUsernamesSha256 !== expectedUsernamesSha256) {
      return this.unavailableCollaboratorStatuses(request, [], capturedAt, "invalid_response", "The requested collaborator lineage hash is invalid.", false);
    }
    let credential: InstagramPublishingCredential;
    try {
      credential = await this.options.resolveCredential(request);
    } catch {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "credential_unavailable", "Instagram credentials are unavailable.", false);
    }
    if (!credential.accessToken) {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "credential_unavailable", "Instagram credentials are unavailable.", false);
    }
    const capability = instagramCollaboratorCapability(this.collaboratorCapabilityContext(credential));
    if (capability.state !== "supported") {
      const availability = capability.reason === "required_scopes_missing" ? "scope_missing" : capability.reason === "facebook_login_required" ? "connection_unsupported" : "endpoint_unavailable";
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, availability, this.collaboratorCapabilityMessage(capability.reason), false);
    }

    const query = new URLSearchParams({ fields: "id,username,invite_status", limit: "10" });
    let response: Response;
    try {
      response = await this.transport(`${this.correctionBaseUrl}/${this.options.apiVersion}/${encodeURIComponent(request.externalMediaId)}/collaborators?${query.toString()}`, {
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "transport_failed", "Instagram collaborator status could not be reached.", true);
    }
    let responseText: string | null;
    try {
      responseText = await this.readBoundedStatusBody(response, 65_536);
    } catch {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "transport_failed", "Instagram collaborator status ended before a complete response was read.", true);
    }
    if (responseText === null) {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned an oversized collaborator status response.", false);
    }
    let value: CollaboratorGraphBody;
    try {
      value = JSON.parse(responseText) as CollaboratorGraphBody;
    } catch {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned malformed collaborator status JSON.", false);
    }
    if (!response.ok || value.error) {
      const providerCode = value.error?.code ?? response.status;
      const providerSubcode = value.error?.error_subcode;
      const credentialFailure = response.status === 401 || providerCode === 190;
      const scopeFailure = response.status === 403;
      const retry = response.status === 429 || response.status >= 500;
      const availability = credentialFailure ? "credential_unavailable" : scopeFailure ? "scope_missing" : "provider_failed";
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, availability, credentialFailure ? "Instagram authorization is no longer valid." : scopeFailure ? "Instagram collaborator status permission is missing." : "Instagram rejected the collaborator status read.", retry, { providerCode, ...(providerSubcode !== undefined ? { providerSubcode } : {}), ...this.retryAfter(response) });
    }
    if (!Array.isArray(value.data) || value.data.length > 10) {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned an invalid or oversized collaborator status response.", false);
    }
    if (value.paging?.next !== undefined) {
      return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned a paginated collaborator response, so the status set is incomplete.", false);
    }

    const sanitized: Array<{id?:string;username:string;invite_status:"Accepted"|"Pending"}> = [];
    for (const entry of value.data) {
      if (!entry || typeof entry !== "object") return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned a malformed collaborator status entry.", false);
      const item = entry as { id?: unknown; username?: unknown; invite_status?: unknown };
      if (typeof item.username !== "string" || item.username.length > 31 || (item.invite_status !== "Accepted" && item.invite_status !== "Pending") || (item.id !== undefined && (typeof item.id !== "string" || !item.id || item.id.length > 200))) {
        return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned a malformed collaborator status entry.", false);
      }
      sanitized.push({ ...(typeof item.id === "string" ? { id:item.id } : {}), username:item.username, invite_status:item.invite_status });
    }
    const rawResponseSha256 = createHash("sha256").update(JSON.stringify({ data: sanitized })).digest("hex");
    const observed = new Map<string, { providerScopedUserId?: string; status: "pending" | "accepted" }>();
    for (const item of sanitized) {
      let username: string;
      try { username = normalizeInstagramCollaborators([item.username])[0]!; }
      catch { return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned an invalid collaborator username.", false); }
      if (observed.has(username)) return this.unavailableCollaboratorStatuses(request, requestedUsernames, capturedAt, "invalid_response", "Instagram returned duplicate collaborator status entries.", false);
      const status = item.invite_status === "Accepted" ? "accepted" : "pending";
      observed.set(username, { ...(item.id ? { providerScopedUserId: item.id } : {}), status });
    }
    const snapshots:CurrentCollaboratorStatusSnapshot[] = requestedUsernames.map((username) => {
      const result = observed.get(username);
      return {
        ...this.collaboratorStatusLineage(request),
        username,
        ...(result?.providerScopedUserId ? { providerScopedUserId: result.providerScopedUserId } : {}),
        status: result?.status ?? "not_returned" as const,
        capturedAt,
        providerResponseSha256: rawResponseSha256,
      };
    });
    return { snapshots, capturedAt, complete: true, availability:"available", rawResponseSha256 };
  }

  private async createSingle(request: PublishRequest, credential: InstagramPublishingCredential, settings: InstagramPublishSettings | undefined, providerBase: string): Promise<string> {
    const media = request.media[0]!;
    if (request.format === "story") {
      const body = new URLSearchParams({
        media_type: "STORIES",
        ...(media.type === "image" ? { image_url: media.url } : { video_url: media.url }),
        ...(settings?.isAiGenerated === true ? { is_ai_generated: "true" } : {}),
      });
      const created = await this.call(`/${encodeURIComponent(credential.externalAccountId)}/media`, credential.accessToken, body, undefined, providerBase);
      if (!created.id) throw new Error("Instagram did not return a Story container ID.");
      return created.id;
    }
    const cover = settings?.reelCover;
    const body = new URLSearchParams({ caption: request.caption, ...(media.type === "image" ? { image_url: media.url } : { video_url: media.url, media_type: "REELS", share_to_feed: settings?.shareToFeed === false ? "false" : "true", ...(cover?.mode === "custom_image" ? { cover_url: request.coverMedia!.url } : {}), ...(cover?.mode === "video_frame" ? { thumb_offset: String(cover.offsetMs) } : {}) }), ...(settings?.collaborators.length ? { collaborators: JSON.stringify(settings.collaborators) } : {}), ...(settings?.isAiGenerated === true ? { is_ai_generated: "true" } : {}) });
    const created = await this.call(`/${encodeURIComponent(credential.externalAccountId)}/media`, credential.accessToken, body, undefined, providerBase);
    if (!created.id) throw new Error("Instagram did not create a media container.");
    return created.id;
  }

  private domainErrorCode(error: unknown, fallback: string): string {
    return typeof error === "object" && error && "code" in error && typeof error.code === "string"
      ? error.code
      : fallback;
  }

  private async createCarousel(request: PublishRequest, credential: InstagramPublishingCredential, settings: InstagramPublishSettings | undefined, inviteProof: CollaboratorInviteProof, providerBase: string): Promise<InstagramPublishingOperation> {
    const children: string[] = [];
    for (const media of request.media) {
      const child = await this.call(`/${encodeURIComponent(credential.externalAccountId)}/media`, credential.accessToken, new URLSearchParams({ ...(media.type === "image" ? { image_url: media.url } : { video_url: media.url, media_type: "VIDEO" }), is_carousel_item: "true" }), undefined, providerBase);
      if (!child.id) throw new Error("Instagram did not create a carousel child container.");
      await this.waitUntilReady(child.id, credential.accessToken, providerBase);
      children.push(child.id);
    }
    const parent = await this.call(`/${encodeURIComponent(credential.externalAccountId)}/media`, credential.accessToken, new URLSearchParams({ media_type: "CAROUSEL", children: children.join(","), caption: request.caption, ...(settings?.collaborators.length ? { collaborators: JSON.stringify(settings.collaborators) } : {}), ...(settings?.isAiGenerated === true ? { is_ai_generated: "true" } : {}) }), undefined, providerBase);
    if (!parent.id) throw new Error("Instagram did not create the carousel container.");
    return { containerId: parent.id, childContainerIds: children, collaboratorInviteProof: inviteProof };
  }

  private collaboratorSettings(settings: Record<string, unknown>, publishingUsername?: string, request?:Pick<PublishRequest,"platform"|"accountId"|"draftSha256">): InstagramPublishSettings | undefined {
    if (!("collaborators" in settings) && !("approvedSettingsSha256" in settings) && !("reelCover" in settings) && !("shareToFeed" in settings) && !("isAiGenerated" in settings)) return undefined;
    const approved=assertApprovedInstagramPublishSettings({
      collaborators: settings.collaborators,
      ...(settings.shareToFeed !== undefined ? {shareToFeed:settings.shareToFeed} : {}),
      ...(settings.reelCover !== undefined ? {reelCover:settings.reelCover} : {}),
      ...(settings.isAiGenerated !== undefined ? {isAiGenerated:settings.isAiGenerated} : {}),
      approvedSettingsSha256: settings.approvedSettingsSha256,
      ...(settings.approvalBinding ? {approvalBinding:settings.approvalBinding} : {}),
    }, publishingUsername);
    if(approved.collaborators.length||approved.reelCover||approved.shareToFeed===false||approved.isAiGenerated!==undefined){
      if(!request?.draftSha256) throw new Error("Instagram collaborator publishing needs the exact approved draft hash.");
      assertInstagramPublishApprovalBinding(approved.approvalBinding,{platform:"instagram",accountId:request.accountId,draftSha256:request.draftSha256,approvedSettingsSha256:approved.approvedSettingsSha256});
    }
    return approved;
  }

  private unavailableCollaboratorStatuses(
    request: ReadInstagramCollaboratorStatusesRequest,
    requestedUsernames: readonly string[],
    capturedAt: string,
    availability:Exclude<InstagramCollaboratorStatusResult["availability"],"available">,
    message:string,
    retryRecommended:boolean,
    detail:{providerCode?:number;providerSubcode?:number;afterSeconds?:number}={},
  ): InstagramCollaboratorStatusResult {
    const rawResponseSha256 = createHash("sha256").update(JSON.stringify({ unavailable: availability, providerCode:detail.providerCode, providerSubcode:detail.providerSubcode })).digest("hex");
    return {
      snapshots: requestedUsernames.map((username) => ({
        ...this.collaboratorStatusLineage(request),
        username,
        status: "unavailable",
        capturedAt,
        providerResponseSha256: rawResponseSha256,
      })),
      capturedAt,
      complete: false,
      availability,
      error:{code:availability,message,...(detail.providerCode!==undefined?{providerCode:detail.providerCode}:{}),...(detail.providerSubcode!==undefined?{providerSubcode:detail.providerSubcode}:{})},
      retry:{recommended:retryRecommended,...(detail.afterSeconds!==undefined?{afterSeconds:detail.afterSeconds}:{})},
      rawResponseSha256,
    };
  }

  private collaboratorCapabilityContext(credential:InstagramPublishingCredential):InstagramCollaboratorCapabilityContext{
    const scopes=[...(credential.scopes??[]),...(credential.scope?.split(/[\s,]+/u)??[])].map((scope)=>scope.trim()).filter(Boolean);
    const probe=credential.collaboratorEndpointProbe;
    return{
      connectionMode:credential.connectionMode,
      scopes:[...new Set(scopes)],
      endpointFamily:credential.endpointFamily,
      endpointProbe:probe?.state==="verified"&&probe.apiVersion===this.options.apiVersion?probe:{state:probe?.state==="failed"?"failed":"not_run"},
    };
  }

  private assertCollaboratorCredential(settings:InstagramPublishSettings|undefined,credential:InstagramPublishingCredential):void{
    if(!settings?.collaborators.length)return;
    const capability=instagramCollaboratorCapability(this.collaboratorCapabilityContext(credential));
    if(capability.state!=="supported")throw new DomainError(this.collaboratorCapabilityMessage(capability.reason),"instagram_collaborators_connection_unsupported",409);
    if(!credential.canonicalUsername?.trim())throw new DomainError("Instagram collaborator publishing needs the server-derived canonical publisher username.","instagram_collaborator_publisher_identity_unavailable",409);
  }

  private collaboratorCapabilityMessage(reason:Extract<InstagramCollaboratorCapability,{state:"unsupported"}>["reason"]):string{
    if(reason==="facebook_login_required")return"Connect Instagram through Facebook Login before using collaborators.";
    if(reason==="required_scopes_missing")return"Reconnect Instagram with instagram_basic, instagram_content_publish, and pages_read_engagement.";
    if(reason==="endpoint_family_unsupported")return"Instagram collaborator publishing needs the Facebook Login Graph endpoint family.";
    return"Instagram collaborator publishing needs a verified provider endpoint probe.";
  }

  private collaboratorStatusLineage(request:ReadInstagramCollaboratorStatusesRequest){
    return{workspaceId:request.workspaceId,brandId:request.brandId,contentItemId:request.contentItemId,proofId:request.proofId,accountId:request.accountId,externalMediaId:request.externalMediaId,requestedUsernamesSha256:request.requestedUsernamesSha256};
  }

  private retryAfter(response:Response):{afterSeconds?:number}{
    const value=Number(response.headers.get("retry-after"));
    return Number.isInteger(value)&&value>0&&value<=86_400?{afterSeconds:value}:{};
  }

  private publishProviderBase(settings: InstagramPublishSettings | undefined, credential?: InstagramPublishingCredential): string {
    return credential?.connectionMode === "facebook_login" || settings?.collaborators.length ? this.correctionBaseUrl : this.baseUrl;
  }

  private async readBoundedStatusBody(response: Response, maxBytes: number): Promise<string | null> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (bytesRead + next.value.byteLength > maxBytes) {
          await reader.cancel("Instagram collaborator status response exceeded the safe read limit.").catch(() => undefined);
          return null;
        }
        chunks.push(next.value);
        bytesRead += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

    const joined = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  private async waitUntilReady(containerId: string, accessToken: string, providerBase = this.baseUrl): Promise<void> {
    const attempts = this.options.maxPollAttempts ?? 30;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.call(`/${encodeURIComponent(containerId)}`, accessToken, undefined, new URLSearchParams({ fields: "status_code,status" }), providerBase);
      if (result.status_code === "FINISHED") return;
      if (result.status_code === "ERROR" || result.status_code === "EXPIRED") throw new Error(`Instagram media processing ${result.status_code.toLowerCase()}.`);
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 2_000));
    }
    throw new Error("Instagram media processing did not finish in time.");
  }

  private async call(path: string, accessToken: string, body?: URLSearchParams, query?: URLSearchParams, providerBase = this.baseUrl): Promise<GraphBody> {
    const suffix = query?.size ? `?${query.toString()}` : "";
    const response = await this.transport(`${providerBase}/${this.options.apiVersion}${path}${suffix}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json().catch(() => ({})) as GraphBody;
    if (!response.ok || value.error) {
      const code = value.error?.code ? ` code ${value.error.code}` : "";
      throw new Error(`Instagram API request failed${code}.`);
    }
    return value;
  }

  private analyticsError(response: Response, value: GraphBody): ProviderAnalyticsError {
    const code = value.error?.code ?? response.status;
    if (response.status === 401 || code === 10 || code === 190 || code === 200) {
      return new ProviderAnalyticsError("Instagram analytics permission is missing or expired. Reconnect the account.", "permission_missing");
    }
    if (response.status === 400 || code === 100) {
      return new ProviderAnalyticsError("Instagram does not support this analytics query for the published media.", "unsupported");
    }
    return new ProviderAnalyticsError(`Instagram analytics request failed with provider code ${code}.`, "provider_failed");
  }

  private async engagementCredential(request: Pick<EngagementRequestScope, "workspaceId" | "accountId">): Promise<InstagramPublishingCredential> {
    let credential: InstagramPublishingCredential;
    try { credential = await this.options.resolveCredential(request); }
    catch { throw new ProviderEngagementError("Instagram comment access is unavailable. Reconnect the account.", "permission_missing"); }
    if (!credential.externalAccountId || !credential.accessToken) throw new ProviderEngagementError("Instagram comment access is unavailable. Reconnect the account.", "permission_missing");
    return credential;
  }

  private hasManageContentsScope(credential: InstagramPublishingCredential): boolean {
    const scopes = new Set([...(credential.scopes ?? []), ...(credential.scope?.split(/[\s,]+/).filter(Boolean) ?? [])]);
    return scopes.has("instagram_basic") && scopes.has("instagram_manage_contents");
  }

  private async correctionCredential(request: RemoteCorrectionCapabilityRequest): Promise<InstagramPublishingCredential> {
    const credential = await this.identityCredential(request);
    if (credential.connectionMode !== "facebook_login") throw new ProviderRemoteCorrectionError("Instagram API deletion requires a Facebook Login connection.", "unsupported");
    if (!this.hasManageContentsScope(credential)) throw new ProviderRemoteCorrectionError("Instagram deletion requires instagram_basic and instagram_manage_contents.", "permission");
    return credential;
  }

  private async identityCredential(request: RemoteCorrectionCapabilityRequest): Promise<InstagramPublishingCredential> {
    let credential: InstagramPublishingCredential;
    try { credential = await this.options.resolveCredential(request); }
    catch { throw new ProviderRemoteCorrectionError("Instagram correction access is unavailable. Reconnect the account.", "authentication"); }
    if (!credential.externalAccountId || !credential.accessToken) throw new ProviderRemoteCorrectionError("Instagram correction credential is unavailable.", "authentication");
    return credential;
  }

  private instagramSnapshot(request: RemoteCorrectionTarget, ownerId: string, state: RemoteContentSnapshot["state"], objectKind: RemoteContentSnapshot["objectKind"], mutableState: Record<string, unknown>): RemoteContentSnapshot {
    return remoteSnapshot({ ...correctionLineage(request), providerOwnerId: ownerId, state, objectKind, mutableState, observedAt: new Date().toISOString(), providerVersion: this.options.apiVersion });
  }

  private targetFor(operation: ExecuteRemoteCorrectionRequest["operation"]): RemoteCorrectionTarget {
    return { workspaceId: operation.workspaceId, brandId: operation.brandId, publishProofId: operation.publishProofId, contentItemId: operation.contentItemId, draftId: operation.draftId, draftSha256: operation.draftSha256, platform: operation.platform, accountId: operation.accountId, externalPostId: operation.externalPostId, mutation: operation.mutation };
  }

  private correctionError(response: Response, value: GraphBody): ProviderRemoteCorrectionError {
    const providerCode = value.error?.code ?? response.status;
    const providerSubcode = value.error?.error_subcode;
    const traceId = value.error?.fbtrace_id;
    const detail = { providerCode, ...(providerSubcode !== undefined ? { providerSubcode } : {}), ...(traceId ? { traceId } : {}) };
    if (response.status === 401 || providerCode === 190) return new ProviderRemoteCorrectionError("Instagram correction access expired. Reconnect the account.", "authentication", detail);
    if (providerCode === 100 || providerSubcode === 2207007) return new ProviderRemoteCorrectionError("Instagram did not provide authenticated proof that the media is absent.", "uncertain", detail);
    if (response.status === 404) return new ProviderRemoteCorrectionError("The Instagram media was not found.", "not_found", detail);
    if (response.status === 429 || [4, 17, 32, 341, 613, 80002].includes(providerCode)) return new ProviderRemoteCorrectionError("Instagram paused correction requests because of a provider limit.", "rate_limited", detail);
    if (providerSubcode === 2207073) return new ProviderRemoteCorrectionError("Instagram does not support deleting this media type.", "unsupported", detail);
    if (response.status === 403 || providerCode === 10 || providerCode === 200) return new ProviderRemoteCorrectionError("Instagram deletion permission is missing.", "permission", detail);
    if (response.status === 400) return new ProviderRemoteCorrectionError("Instagram rejected the correction request.", "invalid_request", detail);
    return new ProviderRemoteCorrectionError("Instagram correction request failed.", "transient", detail);
  }

  private rejectedCorrection(error: unknown): RemoteCorrectionOutcome {
    if (error instanceof ProviderRemoteCorrectionError) return { kind: "rejected", category: error.code, reason: error.message };
    return { kind: "rejected", category: "transient", reason: error instanceof Error ? error.message : "Instagram correction failed." };
  }

  private async readCommentEdge(path: string, accessToken: string, query: URLSearchParams, parentExternalCommentId?: string): Promise<{ comments: ProviderEngagementComment[]; rawPages: unknown[] }> {
    const comments: ProviderEngagementComment[] = [];
    const rawPages: unknown[] = [];
    let url: string | undefined = `${this.baseUrl}/${this.options.apiVersion}${path}?${query.toString()}`;
    const maxPages = Math.max(1, Math.min(this.options.maxCommentPages ?? 50, 100));
    for (let page = 0; url && page < maxPages; page += 1) {
      url = this.safePagingUrl(url);
      let response: Response;
      try { response = await this.transport(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }); }
      catch { throw new ProviderEngagementError("Instagram comments are temporarily unavailable.", "provider_failed"); }
      const value = await response.json().catch(() => ({})) as EngagementGraphBody;
      if (!response.ok || value.error) throw this.engagementError(response, value);
      if (!Array.isArray(value.data)) throw new ProviderEngagementError("Instagram returned an invalid comment page.", "provider_failed");
      const mapped = value.data.map((item) => this.mapComment(item, parentExternalCommentId));
      comments.push(...mapped);
      const next = typeof value.paging?.next === "string" && value.paging.next ? value.paging.next : undefined;
      rawPages.push({ data: mapped, paging: { hasNext: Boolean(next), ...(typeof value.paging?.cursors?.before === "string" ? { before: value.paging.cursors.before } : {}), ...(typeof value.paging?.cursors?.after === "string" ? { after: value.paging.cursors.after } : {}) } });
      url = next;
      if (url && page + 1 === maxPages) throw new ProviderEngagementError("Instagram returned more comment pages than the safe reconciliation limit.", "provider_failed");
    }
    return { comments, rawPages };
  }

  private mapComment(value: unknown, fallbackParentId?: string): ProviderEngagementComment {
    if (!value || typeof value !== "object") throw new ProviderEngagementError("Instagram returned an invalid comment.", "provider_failed");
    const item = value as EngagementGraphComment;
    if (typeof item.id !== "string" || typeof item.text !== "string" || typeof item.hidden !== "boolean") {
      throw new ProviderEngagementError("Instagram omitted required comment fields.", "provider_failed");
    }
    const parent = typeof item.parent_id === "string" ? item.parent_id : fallbackParentId;
    const authorScopedId = typeof item.from?.id === "string" ? item.from.id : undefined;
    const authorUsername = typeof item.username === "string" ? item.username : typeof item.from?.username === "string" ? item.from.username : undefined;
    return {
      externalCommentId: item.id,
      ...(parent ? { parentExternalCommentId: parent } : {}),
      ...(authorScopedId ? { authorScopedId } : {}),
      ...(authorUsername ? { authorUsername } : {}),
      body: item.text,
      visibility: item.hidden ? "hidden" : "visible",
      ...(typeof item.timestamp === "string" ? { providerCreatedAt: item.timestamp } : {}),
    };
  }

  private safePagingUrl(raw: string): string {
    const url = new URL(raw, this.baseUrl);
    const trusted = new URL(this.baseUrl);
    if (url.origin !== trusted.origin || !url.pathname.startsWith(`/${this.options.apiVersion}/`)) {
      throw new ProviderEngagementError("Instagram returned an untrusted pagination URL.", "provider_failed");
    }
    url.searchParams.delete("access_token");
    return url.toString();
  }

  private engagementError(response: Response, value: EngagementGraphBody): ProviderEngagementError {
    const providerCode = value.error?.code ?? response.status;
    const providerSubcode = value.error?.error_subcode;
    const traceId = value.error?.fbtrace_id;
    const detail = { providerCode, ...(providerSubcode !== undefined ? { providerSubcode } : {}), ...(traceId ? { traceId } : {}) };
    if (response.status === 401 || providerCode === 102 || providerCode === 190 || (providerSubcode !== undefined && [458, 460, 463, 467, 492].includes(providerSubcode))) {
      return new ProviderEngagementError("Instagram access expired or was removed. Reconnect the account.", "expired", detail);
    }
    if (providerCode === 10 || providerCode === 3 || (providerCode >= 200 && providerCode <= 299) || response.status === 403) {
      return new ProviderEngagementError("Instagram comment permission is missing. Reconnect and grant comment access.", "permission_missing", detail);
    }
    if (response.status === 429 || [4, 17, 32, 341, 613, 80002].includes(providerCode)) {
      return new ProviderEngagementError("Instagram paused comment requests because of a provider limit.", "rate_limited", detail);
    }
    if (response.status === 404) return new ProviderEngagementError("This Instagram comment or media is no longer available.", "not_found", detail);
    if (providerCode === 100 || response.status === 400) return new ProviderEngagementError("Instagram does not support this comment request.", "unsupported", detail);
    return new ProviderEngagementError("Instagram comment request failed.", "provider_failed", detail);
  }

  private firstCommentError(response: Response, value: EngagementGraphBody): ProviderFirstCommentError {
    const error = this.engagementError(response, value);
    const code = error.code === "permission_missing" || error.code === "expired" ? "permission_missing" : error.code === "unsupported" ? "unsupported" : error.code === "rate_limited" ? "rate_limited" : "provider_failed";
    return new ProviderFirstCommentError(error.message, code, error.detail);
  }
}
