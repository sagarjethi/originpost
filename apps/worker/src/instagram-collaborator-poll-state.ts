import type { InstagramCollaboratorStatusResult } from "@originpost/connectors";

export interface InstagramCollaboratorPollDecision {
  trackingComplete: boolean;
  retryAt?: string | undefined;
}

/**
 * A complete provider read is not the same as a complete invitation workflow.
 * Pending and not-returned invitations remain observable until the poll budget or
 * TTL is exhausted by the repository.
 */
export function decideInstagramCollaboratorPoll(
  result: InstagramCollaboratorStatusResult,
  attemptCount: number,
  nowMs = Date.now(),
): InstagramCollaboratorPollDecision {
  if (result.complete) {
    const trackingComplete = result.snapshots.every((snapshot) => snapshot.status === "accepted");
    return trackingComplete
      ? { trackingComplete: true }
      : { trackingComplete: false, retryAt: new Date(nowMs + 6 * 60 * 60_000).toISOString() };
  }

  if (!result.retry.recommended) return { trackingComplete: false };
  const delaySeconds = Math.max(
    60,
    result.retry.afterSeconds ?? Math.min(3600, 60 * 2 ** Math.min(attemptCount, 6)),
  );
  return { trackingComplete: false, retryAt: new Date(nowMs + delaySeconds * 1000).toISOString() };
}
