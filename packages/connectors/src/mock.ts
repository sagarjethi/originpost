import { createHash } from "node:crypto";
import { canonicalSha256, validateMeasuredMedia } from "@originpost/domain";
import { assertCorrectionExecution, correctionLineage, correctionResult, remoteSnapshot } from "./remote-correction.js";
import type { ExecuteRemoteCorrectionRequest, ReconcileRemoteCorrectionRequest, RemoteContentSnapshot, RemoteCorrectionCapabilityRequest, RemoteCorrectionCapabilitySet, RemoteCorrectionConnector, RemoteCorrectionOutcome, RemoteCorrectionTarget } from "./remote-correction.js";
import type {
  ConnectorManifest,
  CommentPage,
  EngagementConnector,
  AnalyticsRequest,
  AnalyticsResult,
  PendingResult,
  PlatformConnector,
  PublishRequest,
  PublishResult,
  ReadCommentsRequest,
  ReplyToCommentRequest,
  ReplyToCommentResult,
  SubscribeCommentsRequest,
  SubscriptionResult,
  ValidationIssue,
} from "./types.js";
import type { CreateFirstCommentRequest, FirstCommentCapability, FirstCommentConnector, FirstCommentObservation, FirstCommentScope, InspectFirstCommentRequest } from "./first-comment.js";

abstract class MockConnector implements PlatformConnector, RemoteCorrectionConnector {
  abstract readonly manifest: ConnectorManifest;
  private readonly published = new Map<string, PublishResult>();
  private readonly corrected = new Map<string, RemoteContentSnapshot>();

  async validate(request: PublishRequest): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    issues.push(...validateMeasuredMedia({ platform: request.platform, format: request.format, media: request.media }));
    if (!this.manifest.capabilities.formats.includes(request.format)) {
      issues.push({
        field: "format",
        code: "unsupported_format",
        message: `${request.format} is not supported by ${this.manifest.name}.`,
        severity: "error",
      });
    }
    // Story copy is an OriginPost review note. The provider body intentionally
    // omits it, so it must not inherit Instagram's feed-caption limit.
    if (request.format !== "story" && request.caption.length > this.manifest.limits.captionCharacters) {
      issues.push({
        field: "caption",
        code: "caption_too_long",
        message: `Caption exceeds the ${this.manifest.limits.captionCharacters}-character connector limit.`,
        severity: "error",
      });
    }
    if (request.media.length > this.manifest.limits.maxMedia) {
      issues.push({
        field: "media",
        code: "too_many_media_items",
        message: `This connector accepts at most ${this.manifest.limits.maxMedia} media items.`,
        severity: "error",
      });
    }
    if (this.manifest.limits.maxVideoBytes && request.media.some((media) => media.type === "video" && media.sizeBytes > this.manifest.limits.maxVideoBytes!)) {
      issues.push({ field: "media", code: "video_too_large", message: `Video exceeds the ${this.manifest.limits.maxVideoBytes}-byte connector limit.`, severity: "error" });
    }
    if (request.media.some((media) => !media.altText) && request.format !== "short") {
      issues.push({
        field: "media.altText",
        code: "alt_text_missing",
        message: "Add alt text before publishing.",
        severity: "warning",
      });
    }
    return issues;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const existing = this.published.get(request.idempotencyKey);
    if (existing) return existing;

    const errors = (await this.validate(request)).filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      throw new Error(errors.map((issue) => issue.message).join(" "));
    }

    const digest = createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16);
    const result: PublishResult = {
      status: "published",
      externalPostId: `mock_${digest}`,
      liveUrl: `https://example.invalid/${this.manifest.platform}/mock_${digest}`,
      rawResponse: { mock: true, idempotencyKey: request.idempotencyKey, ...(this.manifest.platform === "instagram" ? { isAiGenerated: request.settings.isAiGenerated === true } : {}) },
    };
    this.published.set(request.idempotencyKey, result);
    return result;
  }

  async checkPending(pendingToken: string): Promise<PendingResult> {
    return { status: "ready", pendingToken };
  }

  async finalizePending(pendingToken: string): Promise<PendingResult> {
    return {
      status: "published",
      externalPostId: `mock_${pendingToken}`,
      liveUrl: `https://example.invalid/${this.manifest.platform}/mock_${pendingToken}`,
      rawResponse: { mock: true },
    };
  }

  async readPostAnalytics(request: AnalyticsRequest): Promise<AnalyticsResult> {
    const seed = Number.parseInt(createHash("sha256").update(`${request.platform}:${request.externalPostId}`).digest("hex").slice(0, 8), 16);
    const views = 500 + seed % 25_000;
    const likes = Math.max(1, Math.floor(views * (0.02 + seed % 30 / 1000)));
    const comments = Math.floor(likes * 0.08);
    const shares = Math.floor(likes * 0.12);
    const metrics: AnalyticsResult["metrics"] = request.platform === "instagram"
      ? [
          { key: "views", value: views, unit: "count" },
          { key: "reach", value: Math.floor(views * 0.82), unit: "count" },
          { key: "likes", value: likes, unit: "count" },
          { key: "comments", value: comments, unit: "count" },
          { key: "shares", value: shares, unit: "count" },
          { key: "saves", value: Math.floor(likes * 0.15), unit: "count" },
        ]
      : [
          { key: "views", value: views, unit: "count" },
          { key: "likes", value: likes, unit: "count" },
          { key: "comments", value: comments, unit: "count" },
          { key: "watch_time_seconds", value: views * 18, unit: "seconds" },
          { key: "average_view_duration_seconds", value: 18, unit: "seconds" },
          { key: "subscribers_gained", value: Math.floor(views / 1200), unit: "count" },
        ];
    return { capturedAt: new Date().toISOString(), period: "lifetime", metrics, rawResponse: { mock: true, externalPostId: request.externalPostId, metrics } };
  }

  async correctionCapabilities(_request: RemoteCorrectionCapabilityRequest): Promise<RemoteCorrectionCapabilitySet> {
    const unsupported = { state: "unsupported" as const, reason: "This correction action is not implemented by the mock platform contract." };
    const manual = { state: "manual_only" as const, reason: "This action requires operator attestation and is never provider-confirmed." };
    const actions: RemoteCorrectionCapabilitySet["actions"] = {
      edit_text: unsupported,
      make_private: this.manifest.platform === "youtube" ? { state: "supported" } : unsupported,
      restore_visibility: this.manifest.platform === "youtube" ? { state: "supported" } : unsupported,
      delete_remote: { state: "supported" },
      manual_remove: manual,
    };
    return { platform: this.manifest.platform, providerVersion: "mock-v1", resolvedAt: new Date().toISOString(), actions };
  }

  async preflightCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    if (request.platform !== this.manifest.platform) throw new Error("Mock correction target uses the wrong platform.");
    return this.corrected.get(request.externalPostId) ?? remoteSnapshot({
      ...correctionLineage(request),
      providerOwnerId: request.accountId,
      state: "live",
      objectKind: request.platform === "youtube" ? "video" : "post",
      mutableState: {},
      observedAt: new Date().toISOString(),
      providerVersion: "mock-v1",
    });
  }

  preflightManualCorrection(request: RemoteCorrectionTarget): Promise<RemoteContentSnapshot> {
    return this.preflightCorrection(request);
  }

  async executeCorrection(request: ExecuteRemoteCorrectionRequest): Promise<RemoteCorrectionOutcome> {
    assertCorrectionExecution(request, this.manifest.platform);
    const action = request.operation.mutation.action;
    if (action === "manual_remove") return { kind: "manual_action_required", reason: "Complete removal in the native provider and attach operator evidence.", handoff: this.manifest.platform === "facebook" ? "business_manager" : this.manifest.platform === "instagram" ? "instagram_native" : "youtube_studio" };
    if (action === "edit_text" || ((action === "make_private" || action === "restore_visibility") && this.manifest.platform !== "youtube")) return { kind: "rejected", category: "unsupported", reason: "The mock platform contract does not support this correction." };
    const state = action === "delete_remote" ? "not_found" : action === "make_private" ? "private" : request.operation.mutation.action === "restore_visibility" ? request.operation.mutation.visibility : request.before.state;
    const after = remoteSnapshot({ ...request.before, state, observedAt: new Date().toISOString() });
    this.corrected.set(request.operation.externalPostId, after);
    const receipt = {
      provider: this.manifest.platform,
      action,
      externalPostId: request.operation.externalPostId,
      occurredAt: after.observedAt,
      responseSha256: canonicalSha256({ mock: true, action, externalPostId: request.operation.externalPostId }),
    };
    return { kind: "provider_confirmed", receipt, after };
  }

  async reconcileCorrection(request: ReconcileRemoteCorrectionRequest) {
    const snapshot = this.corrected.get(request.operation.externalPostId) ?? remoteSnapshot({
      ...correctionLineage(request.operation),
      providerOwnerId: request.operation.accountId,
      state: "live",
      objectKind: request.operation.platform === "youtube" ? "video" : "post",
      mutableState: {},
      observedAt: new Date().toISOString(),
      providerVersion: "mock-v1",
    });
    return { snapshot, result: correctionResult(request.operation, snapshot) };
  }
}

export class MockInstagramConnector extends MockConnector implements EngagementConnector, FirstCommentConnector {
  readonly manifest = {
    id: "originpost.instagram.mock",
    name: "Instagram (safe test)",
    platform: "instagram",
    version: "0.1.0",
    apiMode: "mock",
    capabilities: {
      formats: ["image", "carousel", "reel", "story"],
      analytics: true,
      comments: true,
      tokenRefresh: false,
      pendingPublishing: false,
    },
    limits: { captionCharacters: 2200, maxMedia: 10, maxVideoBytes: 4_000_000_000 },
  } satisfies ConnectorManifest;
  private readonly replies = new Map<string, ReplyToCommentResult>();
  private readonly firstComments = new Map<string, { request: CreateFirstCommentRequest; providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string }>();

  override async validate(request: PublishRequest): Promise<ValidationIssue[]> {
    return super.validate(request);
  }

  async readComments(request: ReadCommentsRequest): Promise<CommentPage> {
    const digest = createHash("sha256").update(request.externalMediaId).digest("hex");
    const topId = `mock_comment_${digest.slice(0, 12)}`;
    const replyId = `mock_reply_${digest.slice(12, 24)}`;
    const comments: CommentPage["comments"] = [
      { externalCommentId: topId, authorScopedId: `mock_author_${digest.slice(24, 32)}`, authorUsername: `reader_${digest.slice(0, 6)}`, body: "Could you share the source?", visibility: "visible", providerCreatedAt: "2026-08-29T10:00:00.000Z" },
      { externalCommentId: replyId, parentExternalCommentId: topId, authorScopedId: "mock_brand", authorUsername: "originpost_test", body: "The source is linked in the post.", visibility: "visible", providerCreatedAt: "2026-08-29T10:01:00.000Z" },
    ];
    return { comments, fetchedAt: new Date().toISOString(), complete: true, rawResponse: { mock: true, externalMediaId: request.externalMediaId, comments } };
  }

  async replyToComment(request: ReplyToCommentRequest): Promise<ReplyToCommentResult> {
    const existing = this.replies.get(request.idempotencyKey);
    if (existing) return structuredClone(existing);
    const digest = createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16);
    const result = { externalReplyId: `mock_reply_${digest}`, createdAt: new Date().toISOString(), rawResponse: { mock: true, externalCommentId: request.externalCommentId } };
    this.replies.set(request.idempotencyKey, structuredClone(result));
    return result;
  }

  async subscribeToComments(_request: SubscribeCommentsRequest): Promise<SubscriptionResult> {
    return { subscribed: true, fields: ["comments"], rawResponse: { mock: true, success: true } };
  }

  async firstCommentCapability(_scope: FirstCommentScope): Promise<FirstCommentCapability> { return { state: "supported", platform: "instagram", providerVersion: "mock-v1", maxCharacters: 2_200 }; }
  async createFirstComment(request: CreateFirstCommentRequest) { const existing = this.firstComments.get(request.idempotencyKey); if (existing) return structuredClone(existing); const providerCommentId = `mock_first_${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16)}`; const providerAcceptedAt = new Date().toISOString(); const providerResponseSha256 = canonicalSha256({ mock: true, providerCommentId, externalPostId: request.externalPostId, bodySha256: request.bodySha256 }); const value = { request: structuredClone(request), providerCommentId, providerAcceptedAt, providerResponseSha256 }; this.firstComments.set(request.idempotencyKey, value); return structuredClone(value); }
  async inspectFirstComment(request: InspectFirstCommentRequest): Promise<FirstCommentObservation> { const matches = [...this.firstComments.values()].filter((entry) => entry.request.externalPostId === request.externalPostId && entry.request.bodySha256 === request.bodySha256 && (!request.providerCommentId || entry.providerCommentId === request.providerCommentId)); const observedAt = new Date().toISOString(); if (matches.length === 1) return { state: "matched", providerCommentId: matches[0]!.providerCommentId, providerAcceptedAt: matches[0]!.providerAcceptedAt, providerResponseSha256: matches[0]!.providerResponseSha256, observedAt }; return { state: matches.length ? "ambiguous" : "not_found", observedAt, providerResponseSha256: canonicalSha256({ mock: true, matches: matches.length, externalPostId: request.externalPostId, bodySha256: request.bodySha256 }) }; }
}

export class MockFacebookConnector extends MockConnector implements EngagementConnector, FirstCommentConnector {
  readonly manifest = {
    id: "originpost.facebook.mock",
    name: "Facebook Page (safe test)",
    platform: "facebook",
    version: "0.1.0",
    apiMode: "mock",
    capabilities: {
      formats: ["text", "image"],
      analytics: false,
      comments: true,
      tokenRefresh: false,
      pendingPublishing: false,
    },
    limits: { captionCharacters: 63_206, maxMedia: 10, maxVideoBytes: 4_000_000_000 },
  } satisfies ConnectorManifest;
  private readonly replies = new Map<string, ReplyToCommentResult>();
  private readonly firstComments = new Map<string, { request: CreateFirstCommentRequest; providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string }>();

  override async validate(request: PublishRequest): Promise<ValidationIssue[]> {
    return super.validate(request);
  }

  async readComments(request: ReadCommentsRequest): Promise<CommentPage> {
    const digest = createHash("sha256").update(request.externalMediaId).digest("hex");
    const topId = `mock_facebook_comment_${digest.slice(0, 12)}`;
    const replyId = `mock_facebook_reply_${digest.slice(12, 24)}`;
    const comments: CommentPage["comments"] = [
      { externalCommentId: topId, authorScopedId: `mock_facebook_author_${digest.slice(24, 32)}`, authorUsername: `Page reader ${digest.slice(0, 6)}`, body: "Where can I read the full update?", visibility: "visible", providerCreatedAt: "2026-08-29T10:00:00.000Z" },
      { externalCommentId: replyId, parentExternalCommentId: topId, authorScopedId: "mock_facebook_page", authorUsername: "OriginPost test Page", body: "The source is linked in the Page post.", visibility: "visible", providerCreatedAt: "2026-08-29T10:01:00.000Z" },
    ];
    return { comments, fetchedAt: new Date().toISOString(), complete: true, rawResponse: { mock: true, externalMediaId: request.externalMediaId, comments } };
  }

  async replyToComment(request: ReplyToCommentRequest): Promise<ReplyToCommentResult> {
    const existing = this.replies.get(request.idempotencyKey);
    if (existing) return structuredClone(existing);
    const digest = createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16);
    const result = { externalReplyId: `mock_facebook_reply_${digest}`, createdAt: new Date().toISOString(), rawResponse: { mock: true, externalCommentId: request.externalCommentId } };
    this.replies.set(request.idempotencyKey, structuredClone(result));
    return result;
  }

  async subscribeToComments(_request: SubscribeCommentsRequest): Promise<SubscriptionResult> {
    return { subscribed: true, fields: ["feed"], rawResponse: { mock: true, success: true } };
  }
  async firstCommentCapability(_scope: FirstCommentScope): Promise<FirstCommentCapability> { return { state: "supported", platform: "facebook", providerVersion: "mock-v1", maxCharacters: 2_200 }; }
  async createFirstComment(request: CreateFirstCommentRequest) { const existing = this.firstComments.get(request.idempotencyKey); if (existing) return structuredClone(existing); const providerCommentId = `mock_fb_first_${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16)}`; const providerAcceptedAt = new Date().toISOString(); const providerResponseSha256 = canonicalSha256({ mock: true, providerCommentId, externalPostId: request.externalPostId, bodySha256: request.bodySha256 }); const value = { request: structuredClone(request), providerCommentId, providerAcceptedAt, providerResponseSha256 }; this.firstComments.set(request.idempotencyKey, value); return structuredClone(value); }
  async inspectFirstComment(request: InspectFirstCommentRequest): Promise<FirstCommentObservation> { const matches = [...this.firstComments.values()].filter((entry) => entry.request.externalPostId === request.externalPostId && entry.request.bodySha256 === request.bodySha256 && (!request.providerCommentId || entry.providerCommentId === request.providerCommentId)); const observedAt = new Date().toISOString(); if (matches.length === 1) return { state: "matched", providerCommentId: matches[0]!.providerCommentId, providerAcceptedAt: matches[0]!.providerAcceptedAt, providerResponseSha256: matches[0]!.providerResponseSha256, observedAt }; return { state: matches.length ? "ambiguous" : "not_found", observedAt, providerResponseSha256: canonicalSha256({ mock: true, matches: matches.length, externalPostId: request.externalPostId, bodySha256: request.bodySha256 }) }; }
}

export class MockYouTubeConnector extends MockConnector {
  readonly manifest: ConnectorManifest = {
    id: "originpost.youtube.mock",
    name: "YouTube Shorts (safe test)",
    platform: "youtube",
    version: "0.1.0",
    apiMode: "mock",
    capabilities: {
      formats: ["short"],
      analytics: true,
      comments: false,
      tokenRefresh: false,
      pendingPublishing: false,
    },
    limits: { captionCharacters: 5000, maxMedia: 1, maxVideoBytes: 256_000_000_000 },
  };

  override async validate(request: PublishRequest): Promise<ValidationIssue[]> {
    return super.validate(request);
  }
}
