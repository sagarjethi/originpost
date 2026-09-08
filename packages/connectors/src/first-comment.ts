import type { FirstCommentPlatform } from "@originpost/domain";

export type FirstCommentCapability =
  | { state: "supported"; platform: FirstCommentPlatform; providerVersion: string; maxCharacters: number }
  | { state: "permission_missing" | "unsupported"; platform: FirstCommentPlatform; providerVersion: string; reason: string; maxCharacters: number };

export interface FirstCommentScope { workspaceId: string; accountId: string; platform: FirstCommentPlatform }
export interface CreateFirstCommentRequest extends FirstCommentScope { externalPostId: string; body: string; bodySha256: string; idempotencyKey: string; publishedAt: string }
export interface InspectFirstCommentRequest extends CreateFirstCommentRequest { providerCommentId?: string | undefined; earliestCreatedAt: string }
export interface FirstCommentCreated { providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string }
export type FirstCommentObservation =
  | { state: "matched"; providerCommentId: string; providerAcceptedAt: string; providerResponseSha256: string; observedAt: string }
  | { state: "not_found" | "ambiguous"; observedAt: string; providerResponseSha256: string };

export type ProviderFirstCommentErrorCode = "permission_missing" | "unsupported" | "rate_limited" | "provider_failed" | "uncertain";
export class ProviderFirstCommentError extends Error {
  constructor(message: string, public readonly code: ProviderFirstCommentErrorCode, public readonly detail: { providerCode?: number; providerSubcode?: number; retryAfterSeconds?: number } = {}) { super(message); this.name = "ProviderFirstCommentError"; }
}

export interface FirstCommentConnector {
  firstCommentCapability(scope: FirstCommentScope): Promise<FirstCommentCapability>;
  createFirstComment(request: CreateFirstCommentRequest): Promise<FirstCommentCreated>;
  inspectFirstComment(request: InspectFirstCommentRequest): Promise<FirstCommentObservation>;
}
