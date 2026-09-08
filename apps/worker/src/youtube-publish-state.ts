import type { ProviderPublishOperation, PublishProof, PublishTarget } from "@originpost/domain";

export const YOUTUBE_PROCESSING_POLL_INTERVAL_MS = 30_000;
export const YOUTUBE_PROCESSING_MAX_CHECKS = 240;
export const YOUTUBE_PROCESSING_TIMEOUT_MS = 2 * 60 * 60_000;

export type YouTubePublishNextStep = "create-session" | "query-session" | "upload" | "check-processing" | "finish-proof" | "action-required" | "failed";

export function youtubePublishNextStep(operation: ProviderPublishOperation | null): YouTubePublishNextStep {
  if (!operation) return "create-session";
  if (operation.status === "uncertain") return "action-required";
  if (operation.status === "failed") return "failed";
  if (operation.status === "published") return "finish-proof";
  if (operation.externalPostId) return "check-processing";
  if (operation.status === "finalizing") return "query-session";
  return "upload";
}

export function advanceYouTubeProcessingPoll(
  operation: ProviderPublishOperation,
  nowMs = Date.now(),
): { action: "poll" | "action-required"; operation: ProviderPublishOperation } {
  const processingChecks = (operation.processingChecks ?? 0) + 1;
  const processingDeadlineAt = operation.processingDeadlineAt ?? new Date(nowMs + YOUTUBE_PROCESSING_TIMEOUT_MS).toISOString();
  const deadlineMs = Date.parse(processingDeadlineAt);
  const timedOut = processingChecks >= YOUTUBE_PROCESSING_MAX_CHECKS || !Number.isFinite(deadlineMs) || nowMs >= deadlineMs;
  const updatedAt = new Date(nowMs).toISOString();
  if (timedOut) {
    return {
      action: "action-required",
      operation: {
        ...operation,
        status: "uncertain",
        processingChecks,
        processingDeadlineAt,
        lastError: "YouTube processing was not confirmed within the safety window. Check the video in YouTube Studio before recording proof.",
        updatedAt,
      },
    };
  }
  return {
    action: "poll",
    operation: { ...operation, status: "processing", processingChecks, processingDeadlineAt, lastError: undefined, updatedAt },
  };
}

export function youtubePrivacyMatches(target: PublishTarget, actualPrivacyStatus: string | undefined): boolean {
  const expected = target.settings?.privacyStatus ?? "private";
  return actualPrivacyStatus === expected;
}

export function proofDisclosureForTarget(target: PublishTarget): PublishProof["disclosure"] {
  if (target.platform === "youtube" && target.settings?.containsSyntheticMedia === true) return "synthetic-media";
  if (target.platform === "instagram" && target.settings?.isAiGenerated === true) return "ai-assisted";
  return "none";
}
