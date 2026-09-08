import type { CurrentCollaboratorStatusSnapshot } from "@originpost/domain";
import { describe, expect, it } from "vitest";
import { decideInstagramCollaboratorPoll } from "../src/instagram-collaborator-poll-state.js";

const capturedAt = "2026-08-31T12:00:00.000Z";
const lineage = {
  workspaceId: "workspace-a",
  brandId: "brand-a",
  contentItemId: "content-a",
  proofId: "proof-a",
  accountId: "account-a",
  externalMediaId: "media-a",
  requestedUsernamesSha256: "a".repeat(64),
  capturedAt,
  providerResponseSha256: "b".repeat(64),
} as const;

function snapshot(username: string, status: CurrentCollaboratorStatusSnapshot["status"]): CurrentCollaboratorStatusSnapshot {
  return { ...lineage, username, status };
}

describe("Instagram collaborator polling decisions", () => {
  it("continues after a complete provider read while an invite is pending or absent", () => {
    const now = Date.parse(capturedAt);
    expect(decideInstagramCollaboratorPoll({
      complete: true,
      availability: "available",
      capturedAt,
      rawResponseSha256: "c".repeat(64),
      snapshots: [snapshot("one", "accepted"), snapshot("two", "pending"), snapshot("three", "not_returned")],
    }, 1, now)).toEqual({ trackingComplete: false, retryAt: "2026-08-31T18:00:00.000Z" });
  });

  it("finishes only when every requested collaborator is accepted", () => {
    expect(decideInstagramCollaboratorPoll({
      complete: true,
      availability: "available",
      capturedAt,
      rawResponseSha256: "c".repeat(64),
      snapshots: [snapshot("one", "accepted"), snapshot("two", "accepted")],
    }, 2, Date.parse(capturedAt))).toEqual({ trackingComplete: true });
  });

  it("honors provider retry guidance but does not invent a retry when it is unsafe", () => {
    const base = {
      complete: false as const,
      availability: "transport_failed" as const,
      capturedAt,
      snapshots: [],
      error: { code: "transport_failed" as const, message: "Temporarily unavailable." },
    };
    expect(decideInstagramCollaboratorPoll({ ...base, retry: { recommended: true, afterSeconds: 90 } }, 1, Date.parse(capturedAt)))
      .toEqual({ trackingComplete: false, retryAt: "2026-08-31T12:01:30.000Z" });
    expect(decideInstagramCollaboratorPoll({ ...base, retry: { recommended: false } }, 1, Date.parse(capturedAt)))
      .toEqual({ trackingComplete: false });
  });
});
