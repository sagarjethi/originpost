import { describe, expect, it } from "vitest";
import {
  apiMessage,
  engagementActionRequiredMessage,
  engagementCanCancelAction,
  engagementCanSendReply,
  engagementCapabilities,
  engagementPlatform,
  engagementPlatformMatches,
  engagementProviderObjectId,
  engagementProviderState,
  engagementReplyActionCopy,
  engagementNeedsTerminalPoll,
  engagementSyncState,
  relativeTime,
  relativePastTime,
} from "./engagement-utils";

describe("engagement UI helpers", () => {
  it("keeps sending and management behind manager roles", () => {
    expect(engagementCapabilities("creator")).toEqual({ canDraft: true, canSend: false, canManageThread: false });
    expect(engagementCapabilities("manager").canSend).toBe(true);
    expect(engagementCapabilities("viewer").canDraft).toBe(false);
  });

  it("distinguishes waiting, current, and stale sync states", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    expect(engagementSyncState(undefined, now)).toBe("waiting");
    expect(engagementSyncState("2026-08-29T11:45:00.000Z", now)).toBe("current");
    expect(engagementSyncState("2026-08-29T11:30:00.000Z", now)).toBe("stale");
  });

  it("formats compact relative time and safe API messages", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    expect(relativeTime("2026-08-29T11:43:00.000Z", now)).toBe("17m");
    expect(relativePastTime("2026-08-29T12:00:00.000Z", now)).toBe("just now");
    expect(relativePastTime("2026-08-29T11:43:00.000Z", now)).toBe("17m ago");
    expect(apiMessage({ message: ["Reconnect", "Instagram"] }, "Failed")).toBe("Reconnect Instagram");
    expect(apiMessage({ message: "Cannot GET /v1/engagement" }, "Could not load")).toBe("Could not load");
  });

  it("matches cancellation controls to server ownership and role rules", () => {
    expect(engagementCanCancelAction("creator", "creator-1", { requestedBy: "creator-1", status: "pending_approval" })).toBe(true);
    expect(engagementCanCancelAction("creator", "creator-2", { requestedBy: "creator-1", status: "pending_approval" })).toBe(false);
    expect(engagementCanCancelAction("creator", "creator-1", { requestedBy: "creator-1", status: "queued" })).toBe(false);
    expect(engagementCanCancelAction("manager", "manager-1", { requestedBy: "creator-1", status: "uncertain" })).toBe(false);
    expect(engagementCanCancelAction("owner", "owner-1", { requestedBy: "creator-1", status: "processing" })).toBe(false);
  });

  it("polls only while a provider reply can still change asynchronously", () => {
    expect(engagementNeedsTerminalPoll([{ status: "queued" }])).toBe(true);
    expect(engagementNeedsTerminalPoll([{ status: "processing" }])).toBe(true);
    expect(engagementNeedsTerminalPoll([{ status: "succeeded" }, { status: "cancelled" }])).toBe(false);
    expect(engagementNeedsTerminalPoll([{ status: "uncertain" }])).toBe(false);
  });

  it("keeps legacy rows on Instagram and filters both supported platforms", () => {
    expect(engagementPlatform(undefined)).toBe("instagram");
    expect(engagementPlatform("facebook")).toBe("facebook");
    expect(engagementPlatformMatches(undefined, "instagram")).toBe(true);
    expect(engagementPlatformMatches("facebook", "facebook")).toBe(true);
    expect(engagementPlatformMatches("facebook", "instagram")).toBe(false);
  });

  it("normalizes provider object aliases without changing outbound payloads", () => {
    expect(engagementProviderObjectId({ externalMediaId: "ig-1" })).toBe("ig-1");
    expect(engagementProviderObjectId({ externalPostId: "fb-1" })).toBe("fb-1");
    expect(engagementProviderObjectId({ externalObjectId: "object-1" })).toBe("object-1");
    expect(engagementProviderObjectId({})).toBe("Not reported");
  });

  it("fails Facebook sending closed but preserves legacy Instagram support", () => {
    expect(engagementCanSendReply({ platform: "instagram" })).toBe(true);
    expect(engagementCanSendReply({ platform: "facebook" })).toBe(false);
    expect(engagementCanSendReply({ platform: "facebook", replySupported: true, subscriptionStatus: "active" })).toBe(true);
    expect(engagementCanSendReply({ platform: "facebook", replySupported: true, subscriptionStatus: "permission_missing" })).toBe(false);
    expect(engagementReplyActionCopy({ platform: "facebook" })?.title).toBe("Action required");
  });

  it("maps permission, subscription, and reconciliation health to plain UI states", () => {
    expect(engagementProviderState({ platform: "facebook", subscriptionStatus: "permission_missing", reconciliationStatus: "failed" })).toEqual({
      permission: { tone: "attention", label: "Permission missing", detail: "Reconnect Facebook Page in Channels." },
      subscription: { tone: "attention", label: "Blocked", detail: "The subscription needs provider permission." },
      reconciliation: { tone: "attention", label: "Failed", detail: "Refresh the proof before replying." },
    });
  });

  it("turns provider feature gates into action-required copy", () => {
    expect(engagementActionRequiredMessage({ status: "action_required" }, { platform: "facebook" })).toContain("send it from Facebook");
    expect(engagementActionRequiredMessage({ action: { code: "feature_gated" } }, { platform: "facebook" })).toContain("not available");
    expect(engagementActionRequiredMessage({ message: "Facebook reply sending is currently unavailable" }, { platform: "facebook" })).toContain("send it from Facebook");
    expect(engagementActionRequiredMessage({ status: "succeeded" }, { platform: "facebook" })).toBeNull();
  });
});
