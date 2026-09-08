import { canonicalSha256 } from "@originpost/domain";
import { MockYouTubeConnector } from "./mock.js";
import { ProviderAnalyticsError } from "./types.js";
import type { AnalyticsRequest, AnalyticsResult, ConnectorManifest, PlatformConnector, PublishRequest, PublishResult, ValidationIssue } from "./types.js";
import { assertCorrectionExecution, correctionLineage, correctionResult, ProviderRemoteCorrectionError, remoteSnapshot } from "./remote-correction.js";
import type { ExecuteRemoteCorrectionRequest, ReconcileRemoteCorrectionRequest, RemoteContentObservation, RemoteContentSnapshot, RemoteCorrectionCapabilityRequest, RemoteCorrectionCapabilitySet, RemoteCorrectionConnector, RemoteCorrectionOutcome, RemoteCorrectionTarget } from "./remote-correction.js";

export interface YouTubePublishingCredential {
  externalAccountId: string;
  accessToken: string;
  scope?: string | undefined;
  scopes?: readonly string[] | undefined;
}

export interface YouTubeUploadSession {
  sessionUri: string;
  totalBytes: number;
}

export type YouTubeUploadStatus =
  | { status: "incomplete"; uploadedBytes: number }
  | { status: "published"; videoId: string; rawResponse: unknown };

export type YouTubeProcessingStatus =
  | { status: "processing" }
  | { status: "ready"; privacyStatus?: string }
  | { status: "failed"; reason: string };

export interface YouTubeOfficialConnectorOptions {
  resolveCredential(request: Pick<PublishRequest, "workspaceId" | "contentItemId" | "accountId" | "platform"> | RemoteCorrectionCapabilityRequest): Promise<YouTubePublishingCredential>;
  fetch?: typeof fetch;
  uploadBaseUrl?: string;
  apiBaseUrl?: string;
  analyticsBaseUrl?: string;
}

type YouTubeVideoResponse = {
  id?: string;
  items?: Array<{
    id?: string;
    snippet?: { channelId?: string };
    status?: {
      uploadStatus?: string;
      privacyStatus?: string;
      failureReason?: string;
      rejectionReason?: string;
      embeddable?: boolean;
      license?: string;
      publicStatsViewable?: boolean;
      selfDeclaredMadeForKids?: boolean;
      containsSyntheticMedia?: boolean;
      publishAt?: string;
    };
    processingDetails?: { processingStatus?: string; processingFailureReason?: string };
  }>;
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
};

type YouTubeAnalyticsResponse = {
  columnHeaders?: Array<{ name?: string; columnType?: string; dataType?: string }>;
  rows?: unknown[][];
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
};

function isoDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new ProviderAnalyticsError("The YouTube publish date is invalid.", "unsupported");
  return date.toISOString().slice(0, 10);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function textSetting(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanSetting(settings: Record<string, unknown>, key: string): boolean | undefined {
  return typeof settings[key] === "boolean" ? settings[key] as boolean : undefined;
}

function uploadedBytes(response: Response): number {
  const range = response.headers.get("range");
  const match = range?.match(/bytes=0-(\d+)/i);
  return match?.[1] ? Number(match[1]) + 1 : 0;
}

function titleFor(request: PublishRequest): string {
  return textSetting(request.settings, "title") ?? request.caption.split(/\r?\n/, 1)[0] ?? "OriginPost video";
}

const trustedYouTubeUploadHosts = new Set(["www.googleapis.com", "youtube.googleapis.com"]);

function trustedYouTubeSessionUri(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("YouTube returned an invalid resumable upload session."); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || !trustedYouTubeUploadHosts.has(url.hostname.toLowerCase()) || url.pathname !== "/upload/youtube/v3/videos") {
    throw new Error("YouTube returned an untrusted resumable upload session.");
  }
  if (url.searchParams.get("uploadType") !== "resumable" || !url.searchParams.get("upload_id")) {
    throw new Error("YouTube returned an incomplete resumable upload session.");
  }
  return url.toString();
}

export class YouTubeOfficialConnector implements PlatformConnector, RemoteCorrectionConnector {
  readonly manifest: ConnectorManifest = {
    id: "originpost.youtube.official",
    name: "YouTube Shorts",
    platform: "youtube",
    version: "0.1.0",
    apiMode: "official",
    capabilities: { formats: ["short"], analytics: true, comments: false, tokenRefresh: true, pendingPublishing: true },
    limits: { captionCharacters: 5000, maxMedia: 1, maxVideoBytes: 256_000_000_000 },
  };

  private readonly transport: typeof fetch;
  private readonly uploadBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly analyticsBaseUrl: string;

  constructor(private readonly options: YouTubeOfficialConnectorOptions) {
    this.transport = options.fetch ?? fetch;
    this.uploadBaseUrl = (options.uploadBaseUrl ?? "https://www.googleapis.com/upload/youtube/v3").replace(/\/$/, "");
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://www.googleapis.com/youtube/v3").replace(/\/$/, "");
    this.analyticsBaseUrl = (options.analyticsBaseUrl ?? "https://youtubeanalytics.googleapis.com/v2").replace(/\/$/, "");
    for (const value of [this.uploadBaseUrl,this.apiBaseUrl,this.analyticsBaseUrl]) { const origin=new URL(value); if(origin.protocol!=="https:"||origin.username||origin.password||origin.search||origin.hash) throw new Error("YouTube provider origins must be HTTPS URLs without credentials, query, or fragment."); }
  }

  async validate(request: PublishRequest): Promise<ValidationIssue[]> {
    const issues = await new MockYouTubeConnector().validate(request);
    if (request.platform !== "youtube") issues.push({ field: "platform", code: "youtube_platform_required", message: "This connector only publishes to YouTube.", severity: "error" });
    const title = titleFor(request);
    const description = textSetting(request.settings, "description") ?? request.caption;
    if (title.length === 0) issues.push({ field: "settings.title", code: "youtube_title_required", message: "A YouTube title is required.", severity: "error" });
    if (title.length > 100 || /[<>]/.test(title)) issues.push({ field: "settings.title", code: "youtube_title_invalid", message: "The YouTube title must be 100 characters or fewer and cannot contain angle brackets.", severity: "error" });
    if (Buffer.byteLength(description, "utf8") > 5000 || /[<>]/.test(description)) issues.push({ field: "settings.description", code: "youtube_description_invalid", message: "The YouTube description must be 5,000 UTF-8 bytes or fewer and cannot contain angle brackets.", severity: "error" });
    if (booleanSetting(request.settings, "madeForKids") === undefined) issues.push({ field: "settings.madeForKids", code: "youtube_audience_required", message: "Choose whether this video is made for kids.", severity: "error" });
    if (booleanSetting(request.settings, "containsSyntheticMedia") === undefined) issues.push({ field: "settings.containsSyntheticMedia", code: "youtube_synthetic_declaration_required", message: "Choose whether this video contains realistic altered or synthetic media.", severity: "error" });
    const privacy = textSetting(request.settings, "privacyStatus") ?? "private";
    if (!["private", "unlisted", "public"].includes(privacy)) issues.push({ field: "settings.privacyStatus", code: "youtube_privacy_invalid", message: "YouTube privacy must be private, unlisted, or public.", severity: "error" });
    return issues;
  }

  async correctionCapabilities(request: RemoteCorrectionCapabilityRequest): Promise<RemoteCorrectionCapabilitySet> {
    if (request.platform !== "youtube") throw new ProviderRemoteCorrectionError("This connector only corrects YouTube videos.", "invalid_request");
    let scoped = false;
    try { scoped = this.hasCorrectionScope(await this.options.resolveCredential(request)); }
    catch { scoped = false; }
    const requiresScope = { state: "scope_required" as const, reason: "Reconnect YouTube and grant youtube.force-ssl before changing or deleting a live video." };
    const supported = { state: "supported" as const };
    const unsupported = { state: "unsupported" as const, reason: "Live text editing is outside this correction slice." };
    return {
      platform: "youtube",
      providerVersion: "youtube-data-v3",
      resolvedAt: new Date().toISOString(),
      actions: {
        edit_text: unsupported,
        make_private: scoped ? supported : requiresScope,
        restore_visibility: scoped ? supported : requiresScope,
        delete_remote: scoped ? supported : requiresScope,
        manual_remove: { state: "manual_only", reason: "Manual YouTube Studio actions require operator attestation." },
      },
    };
  }

  async preflightCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    if (request.platform !== "youtube") throw new ProviderRemoteCorrectionError("This connector only corrects YouTube videos.", "invalid_request");
    const credential = await this.correctionCredential(request);
    return this.readCorrectionSnapshot(request, credential);
  }

  async preflightManualCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    if (request.platform !== "youtube") throw new ProviderRemoteCorrectionError("This connector only corrects YouTube videos.", "invalid_request");
    return this.readCorrectionSnapshot(request, await this.identityCredential(request));
  }

  private async readCorrectionSnapshot(request: RemoteCorrectionTarget, credential: YouTubePublishingCredential): Promise<RemoteContentSnapshot> {
    let response: Response;
    try {
      response = await this.transport(`${this.apiBaseUrl}/videos?part=snippet,status&id=${encodeURIComponent(request.externalPostId)}`, {
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderRemoteCorrectionError("YouTube video state could not be read.", "transient");
    }
    const value = await response.json().catch(() => ({})) as YouTubeVideoResponse;
    if (!response.ok || value.error) throw this.correctionError(response, value);
    const video = value.items?.[0];
    if (!video) return this.youtubeSnapshot(request, credential.externalAccountId, "not_found", {});
    if (video.id !== request.externalPostId) throw new ProviderRemoteCorrectionError("YouTube did not return the exact approved video.", "uncertain");
    if (video.snippet?.channelId !== credential.externalAccountId) throw new ProviderRemoteCorrectionError("YouTube returned a video owned by another channel.", "permission");
    const privacy = video.status?.privacyStatus;
    const state = privacy === "private" || privacy === "unlisted" || privacy === "public" ? privacy : "unknown";
    const mutableStatus = {
      ...(typeof video.status?.embeddable === "boolean" ? { embeddable: video.status.embeddable } : {}),
      ...(typeof video.status?.license === "string" ? { license: video.status.license } : {}),
      ...(typeof video.status?.publicStatsViewable === "boolean" ? { publicStatsViewable: video.status.publicStatsViewable } : {}),
      ...(typeof video.status?.selfDeclaredMadeForKids === "boolean" ? { selfDeclaredMadeForKids: video.status.selfDeclaredMadeForKids } : {}),
      ...(typeof video.status?.containsSyntheticMedia === "boolean" ? { containsSyntheticMedia: video.status.containsSyntheticMedia } : {}),
      ...(typeof video.status?.publishAt === "string" ? { publishAt: video.status.publishAt } : {}),
      ...(privacy ? { privacyStatus: privacy } : {}),
    };
    return this.youtubeSnapshot(request, credential.externalAccountId, state, { status: mutableStatus });
  }

  async executeCorrection(request: ExecuteRemoteCorrectionRequest): Promise<RemoteCorrectionOutcome> {
    assertCorrectionExecution(request, "youtube");
    const operation = request.operation;
    if (operation.mutation.action === "manual_remove") return { kind: "manual_action_required", reason: "Complete this action in YouTube Studio and attach operator evidence.", handoff: "youtube_studio" };
    if (operation.mutation.action === "edit_text") return { kind: "rejected", category: "unsupported", reason: "YouTube live text editing is outside this correction slice." };
    let credential: YouTubePublishingCredential;
    try { credential = await this.correctionCredential(operation); }
    catch (error) { return this.rejectedCorrection(error); }

    if (operation.mutation.action === "delete_remote") {
      let response: Response;
      try {
        response = await this.transport(`${this.apiBaseUrl}/videos?id=${encodeURIComponent(operation.externalPostId)}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${credential.accessToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        return { kind: "uncertain", reason: "YouTube may have received the delete request. Reconcile before any further action." };
      }
      if (response.status !== 204) {
        const value = await response.json().catch(() => ({})) as YouTubeVideoResponse;
        return this.rejectedCorrection(this.correctionError(response, value));
      }
      let after: RemoteContentSnapshot;
      try { after = await this.preflightCorrection(this.targetFor(operation)); }
      catch { return { kind: "uncertain", reason: "YouTube confirmed deletion, but OriginPost could not complete read-after-write verification." }; }
      if (after.state !== "not_found") return { kind: "uncertain", reason: "YouTube accepted deletion, but the video is still returned by read-after-write verification." };
      const occurredAt = new Date().toISOString();
      return {
        kind: "provider_confirmed",
        receipt: { provider: "youtube", action: "delete_remote", externalPostId: operation.externalPostId, occurredAt, responseSha256: canonicalSha256({ status: 204, externalPostId: operation.externalPostId }) },
        after,
      };
    }

    const status = request.before.mutableState.status;
    if (!status || typeof status !== "object" || Array.isArray(status)) return { kind: "rejected", category: "invalid_request", reason: "YouTube preflight did not return the mutable status fields required for a safe update." };
    const privacyStatus = operation.mutation.action === "make_private" ? "private" : operation.mutation.visibility;
    let response: Response;
    try {
      response = await this.transport(`${this.apiBaseUrl}/videos?part=status`, {
        method: "PUT",
        headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ id: operation.externalPostId, status: { ...(status as Record<string, unknown>), privacyStatus } }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { kind: "uncertain", reason: "YouTube may have received the visibility change. Reconcile before any further action." };
    }
    const value = await response.json().catch(() => ({})) as YouTubeVideoResponse;
    if (!response.ok || value.error) return this.rejectedCorrection(this.correctionError(response, value));
    let after: RemoteContentSnapshot;
    try { after = await this.preflightCorrection(this.targetFor(operation)); }
    catch { return { kind: "uncertain", reason: "YouTube accepted the visibility change, but OriginPost could not complete read-after-write verification." }; }
    if (after.state !== privacyStatus) return { kind: "uncertain", reason: "YouTube did not return the approved visibility during read-after-write verification." };
    const occurredAt = new Date().toISOString();
    return {
      kind: "provider_confirmed",
      receipt: { provider: "youtube", action: operation.mutation.action, externalPostId: operation.externalPostId, occurredAt, responseSha256: canonicalSha256(value) },
      after,
    };
  }

  async reconcileCorrection(request: ReconcileRemoteCorrectionRequest): Promise<RemoteContentObservation> {
    const snapshot = await this.preflightCorrection(this.targetFor(request.operation));
    return { snapshot, result: correctionResult(request.operation, snapshot) };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const session = await this.createUploadSession(request);
    const result = await this.uploadFromSession(request, session.sessionUri, 0);
    if (result.status !== "published") throw new Error("YouTube accepted only part of the video upload.");
    return {
      status: "published",
      externalPostId: result.videoId,
      liveUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(result.videoId)}`,
      rawResponse: result.rawResponse,
    };
  }

  async readPostAnalytics(request: AnalyticsRequest): Promise<AnalyticsResult> {
    if (request.platform !== "youtube") throw new ProviderAnalyticsError("This connector only reads YouTube analytics.", "unsupported");
    let credential: YouTubePublishingCredential;
    try {
      credential = await this.credential(request);
    } catch {
      throw new ProviderAnalyticsError("YouTube analytics access is unavailable. Reconnect the channel.", "permission_missing");
    }

    const query = new URLSearchParams({
      ids: "channel==MINE",
      startDate: isoDate(request.publishedAt),
      endDate: isoDate(new Date()),
      metrics: "views,engagedViews,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained",
      filters: `video==${request.externalPostId}`,
    });
    const response = await this.transport(`${this.analyticsBaseUrl}/reports?${query.toString()}`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json().catch(() => ({})) as YouTubeAnalyticsResponse;
    if (!response.ok || value.error) throw this.analyticsError(response, value);

    const metrics: AnalyticsResult["metrics"] = [];
    const row = value.rows?.[0];
    if (row) {
      const byName = new Map(value.columnHeaders?.map((header, index) => [header.name, row[index]]) ?? []);
      const append = (rawName: string, key: AnalyticsResult["metrics"][number]["key"], unit: AnalyticsResult["metrics"][number]["unit"], multiplier = 1, caveats: string[] = []) => {
        const raw = byName.get(rawName);
        if (finiteNonNegative(raw)) metrics.push({
          key,
          value: raw * multiplier,
          unit,
          rawMetric: rawName,
          source: "youtube_analytics_query",
          coverage: "unknown",
          definitionVersion: "youtube-analytics-v2",
          ...(caveats.length ? { caveats } : {}),
        });
      };
      append("views", "views", "count", 1, ["YouTube view-count definitions can change; compare with the retrieval date shown for this snapshot."]);
      append("engagedViews", "engaged_views", "count", 1, ["YouTube engaged views are distinct from total views, especially for Shorts."]);
      append("estimatedMinutesWatched", "watch_time_seconds", "seconds", 60, ["Converted from YouTube's estimated minutes watched by multiplying by 60."]);
      append("averageViewDuration", "average_view_duration_seconds", "seconds");
      append("likes", "likes", "count");
      append("comments", "comments", "count");
      append("shares", "shares", "count");
      append("subscribersGained", "subscribers_gained", "count");
    }
    return {
      capturedAt: new Date().toISOString(),
      period: "lifetime",
      metrics,
      status: metrics.length ? "ready" : "unavailable",
      caveats: ["YouTube omits rows when data is unavailable. Missing metrics are not zero."],
      rawResponse: value,
    };
  }

  async createUploadSession(request: PublishRequest): Promise<YouTubeUploadSession> {
    const errors = (await this.validate(request)).filter((issue) => issue.severity === "error");
    if (errors.length) throw new Error(errors.map((issue) => issue.message).join(" "));
    const media = request.media[0]!;
    const credential = await this.credential(request);
    const status: Record<string, unknown> = { privacyStatus: textSetting(request.settings, "privacyStatus") ?? "private" };
    const madeForKids = booleanSetting(request.settings, "madeForKids");
    const containsSyntheticMedia = booleanSetting(request.settings, "containsSyntheticMedia");
    if (madeForKids !== undefined) status.selfDeclaredMadeForKids = madeForKids;
    if (containsSyntheticMedia !== undefined) status.containsSyntheticMedia = containsSyntheticMedia;
    const description = textSetting(request.settings, "description") ?? request.caption;
    const metadata = {
      snippet: {
        title: titleFor(request),
        description,
        ...(textSetting(request.settings, "categoryId") ? { categoryId: textSetting(request.settings, "categoryId") } : {}),
        ...(textSetting(request.settings, "defaultLanguage") ? { defaultLanguage: textSetting(request.settings, "defaultLanguage") } : {}),
      },
      status,
    };
    const notifySubscribers = booleanSetting(request.settings, "notifySubscribers") ?? false;
    const response = await this.transport(`${this.uploadBaseUrl}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${notifySubscribers ? "true" : "false"}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(media.sizeBytes),
        "x-upload-content-type": media.mimeType,
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw await this.providerError("start a resumable upload", response);
    const sessionUri = response.headers.get("location");
    if (!sessionUri) throw new Error("YouTube did not return a resumable upload session.");
    return { sessionUri: trustedYouTubeSessionUri(sessionUri), totalBytes: media.sizeBytes };
  }

  async queryUploadSession(request: PublishRequest, sessionUri: string): Promise<YouTubeUploadStatus> {
    const media = request.media[0]!;
    const uploadUri = trustedYouTubeSessionUri(sessionUri);
    const credential = await this.credential(request);
    const response = await this.transport(uploadUri, {
      method: "PUT",
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-length": "0",
        "content-range": `bytes */${media.sizeBytes}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 308) return { status: "incomplete", uploadedBytes: uploadedBytes(response) };
    if (response.ok) {
      const value = await response.json().catch(() => ({})) as YouTubeVideoResponse;
      if (value.id) return { status: "published", videoId: value.id, rawResponse: value };
    }
    throw await this.providerError("check the resumable upload", response);
  }

  async uploadFromSession(request: PublishRequest, sessionUri: string, startByte: number): Promise<YouTubeUploadStatus> {
    const media = request.media[0]!;
    if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= media.sizeBytes) throw new Error("The YouTube upload offset is invalid.");
    const uploadUri = trustedYouTubeSessionUri(sessionUri);
    const credential = await this.credential(request);
    const source = await this.transport(media.url, {
      method: "GET",
      ...(startByte ? { headers: { range: `bytes=${startByte}-` } } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!source.ok || !source.body) throw new Error("The approved video could not be opened for YouTube upload.");
    const remaining = media.sizeBytes - startByte;
    if (startByte) {
      const expectedRange = `bytes ${startByte}-${media.sizeBytes - 1}/${media.sizeBytes}`;
      if (source.status !== 206 || source.headers.get("content-range") !== expectedRange || source.headers.get("content-length") !== String(remaining)) {
        await source.body.cancel().catch(() => undefined);
        throw new Error("The approved video did not return the exact resume range.");
      }
    }
    const init = {
      method: "PUT",
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-length": String(remaining),
        "content-type": media.mimeType,
        ...(startByte ? { "content-range": `bytes ${startByte}-${media.sizeBytes - 1}/${media.sizeBytes}` } : {}),
      },
      body: source.body,
      duplex: "half",
      signal: AbortSignal.timeout(30 * 60_000),
    } as RequestInit & { duplex: "half" };
    const response = await this.transport(uploadUri, init);
    if (response.status === 308) return { status: "incomplete", uploadedBytes: uploadedBytes(response) };
    const value = await response.json().catch(() => ({})) as YouTubeVideoResponse;
    if (response.ok && value.id) return { status: "published", videoId: value.id, rawResponse: value };
    throw await this.providerError("upload the video", response, value);
  }

  async checkProcessing(request: PublishRequest, videoId: string): Promise<YouTubeProcessingStatus> {
    const credential = await this.credential(request);
    const response = await this.transport(`${this.apiBaseUrl}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json().catch(() => ({})) as YouTubeVideoResponse;
    if (!response.ok || value.error) throw await this.providerError("check video processing", response, value);
    const video = value.items?.[0];
    if (!video) return { status: "failed", reason: "YouTube no longer returns the uploaded video." };
    const upload = video.status?.uploadStatus;
    const processing = video.processingDetails?.processingStatus;
    if (upload === "failed" || upload === "rejected" || processing === "failed") {
      return { status: "failed", reason: video.status?.failureReason ?? video.status?.rejectionReason ?? video.processingDetails?.processingFailureReason ?? "YouTube could not process the video." };
    }
    if (upload === "processed" || processing === "succeeded") return { status: "ready", ...(video.status?.privacyStatus ? { privacyStatus: video.status.privacyStatus } : {}) };
    return { status: "processing" };
  }

  private async credential(request: Pick<PublishRequest, "workspaceId" | "contentItemId" | "accountId" | "platform">): Promise<YouTubePublishingCredential> {
    const credential = await this.options.resolveCredential(request);
    if (!credential.externalAccountId || !credential.accessToken) throw new Error("YouTube publishing credential is unavailable.");
    return credential;
  }

  private hasCorrectionScope(credential: YouTubePublishingCredential): boolean {
    const scopes = new Set([...(credential.scopes ?? []), ...(credential.scope?.split(/\s+/).filter(Boolean) ?? [])]);
    return scopes.has("https://www.googleapis.com/auth/youtube.force-ssl");
  }

  private async correctionCredential(request: RemoteCorrectionCapabilityRequest): Promise<YouTubePublishingCredential> {
    const credential = await this.identityCredential(request);
    if (!this.hasCorrectionScope(credential)) throw new ProviderRemoteCorrectionError("YouTube correction requires youtube.force-ssl.", "permission");
    return credential;
  }

  private async identityCredential(request: RemoteCorrectionCapabilityRequest): Promise<YouTubePublishingCredential> {
    let credential: YouTubePublishingCredential;
    try { credential = await this.options.resolveCredential(request); }
    catch { throw new ProviderRemoteCorrectionError("YouTube correction access is unavailable. Reconnect the channel.", "authentication"); }
    if (!credential.externalAccountId || !credential.accessToken) throw new ProviderRemoteCorrectionError("YouTube correction credential is unavailable.", "authentication");
    return credential;
  }

  private youtubeSnapshot(request: RemoteCorrectionTarget, ownerId: string, state: RemoteContentSnapshot["state"], mutableState: Record<string, unknown>): RemoteContentSnapshot {
    return remoteSnapshot({ ...correctionLineage(request), providerOwnerId: ownerId, state, objectKind: "video", mutableState, observedAt: new Date().toISOString(), providerVersion: "youtube-data-v3" });
  }

  private targetFor(operation: ExecuteRemoteCorrectionRequest["operation"]): RemoteCorrectionTarget {
    return { workspaceId: operation.workspaceId, brandId: operation.brandId, publishProofId: operation.publishProofId, contentItemId: operation.contentItemId, draftId: operation.draftId, draftSha256: operation.draftSha256, platform: operation.platform, accountId: operation.accountId, externalPostId: operation.externalPostId, mutation: operation.mutation };
  }

  private correctionError(response: Response, value: YouTubeVideoResponse): ProviderRemoteCorrectionError {
    const reason = value.error?.errors?.[0]?.reason;
    const providerCode = value.error?.code ?? response.status;
    const detail = { providerCode };
    if (response.status === 401) return new ProviderRemoteCorrectionError("YouTube correction access expired. Reconnect the channel.", "authentication", detail);
    if (response.status === 404 || reason === "videoNotFound") return new ProviderRemoteCorrectionError("The YouTube video was not found.", "not_found", detail);
    if (response.status === 429 || reason === "quotaExceeded" || reason === "rateLimitExceeded") return new ProviderRemoteCorrectionError("YouTube correction is paused by a provider limit.", "rate_limited", detail);
    if (response.status === 403) return new ProviderRemoteCorrectionError("YouTube did not permit this correction for the connected channel.", "permission", detail);
    if (response.status === 400) return new ProviderRemoteCorrectionError("YouTube rejected the correction request.", "invalid_request", detail);
    return new ProviderRemoteCorrectionError("YouTube correction request failed.", "transient", detail);
  }

  private rejectedCorrection(error: unknown): RemoteCorrectionOutcome {
    if (error instanceof ProviderRemoteCorrectionError) return { kind: "rejected", category: error.code, reason: error.message };
    return { kind: "rejected", category: "transient", reason: error instanceof Error ? error.message : "YouTube correction failed." };
  }

  private analyticsError(response: Response, value: YouTubeAnalyticsResponse): ProviderAnalyticsError {
    const reason = value.error?.errors?.[0]?.reason;
    const code = value.error?.code ?? response.status;
    if (response.status === 401 || (response.status === 403 && !["quotaExceeded", "rateLimitExceeded"].includes(reason ?? ""))) {
      return new ProviderAnalyticsError("YouTube analytics permission is missing or expired. Reconnect the channel.", "permission_missing");
    }
    if (response.status === 400 || response.status === 404 || ["badRequest", "invalidValue", "videoNotFound"].includes(reason ?? "")) {
      return new ProviderAnalyticsError("YouTube does not support this analytics query or the video is unavailable.", "unsupported");
    }
    return new ProviderAnalyticsError(`YouTube analytics request failed${reason ? ` (${reason})` : ""}; provider code ${code}.`, "provider_failed");
  }

  private async providerError(action: string, response: Response, parsed?: YouTubeVideoResponse): Promise<Error> {
    const value = parsed ?? await response.json().catch(() => ({})) as YouTubeVideoResponse;
    const reason = value.error?.errors?.[0]?.reason;
    const code = value.error?.code ?? response.status;
    return new Error(`YouTube could not ${action}${reason ? ` (${reason})` : ""}; provider code ${code}.`);
  }
}
