import { describe, expect, it } from "vitest";
import {
  formatEligibilityDuration,
  privateAttachmentLabel,
  privateAvailabilityCopy,
  privateAvailabilityFromResponse,
  privateCanCancelIntent,
  privateConnectionModeLabel,
  privateEligibilityPresentation,
  privateMessageCopy,
  privateNeedsTerminalPoll,
  privateReplyEligibility,
} from "./private-conversation-utils";

describe("private conversation UI helpers", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  it("fails reply eligibility closed and shows a bounded countdown", () => {
    expect(privateEligibilityPresentation({ state: "eligible", checkedAt: "2026-08-31T11:59:00.000Z", expiresAt: "2026-08-31T12:04:30.000Z" }, now)).toMatchObject({ canReply: true, tone: "attention", label: "Reply window closing", remainingMs: 270_000 });
    expect(privateEligibilityPresentation({ state: "eligible", checkedAt: "2026-08-31T11:59:00.000Z", expiresAt: "2026-08-31T11:59:59.000Z" }, now).canReply).toBe(false);
    expect(privateEligibilityPresentation({ state: "unknown", checkedAt: "2026-08-31T11:59:00.000Z", reason: "contract_unverified" }, now)).toMatchObject({ canReply: false, label: "Messaging contract not verified" });
    expect(formatEligibilityDuration(65 * 60_000)).toBe("1h 5m");
  });

  it("prefers the canonical replyEligibility field while tolerating the old alias", () => {
    const canonical = { state: "ineligible" as const, checkedAt: "2026-08-31T12:00:00.000Z", reason: "window_closed" as const };
    const alias = { state: "unknown" as const, checkedAt: "2026-08-31T11:00:00.000Z" };
    expect(privateReplyEligibility({ replyEligibility: canonical, eligibility: alias })).toBe(canonical);
    expect(privateReplyEligibility({ eligibility: alias })).toBe(alias);
  });

  it("uses exact landed deletion literals and metadata-only attachment copy", () => {
    expect(privateMessageCopy({ id: "m1", direction: "incoming", kind: "text", body: "secret", availability: "deleted", firstSeenAt: "2026-08-31T12:00:00.000Z" })).toBe("This message was removed on the provider.");
    expect(privateAttachmentLabel({ id: "a1", kind: "image", availability: "deleted" })).toBe("Image removed");
    expect(privateAttachmentLabel({ id: "a2", kind: "video", availability: "available" })).toBe("Video not imported");
  });

  it("maps connection modes and safe unavailable states", () => {
    expect(privateConnectionModeLabel("instagram_linked_page")).toBe("Instagram linked Page");
    expect(privateConnectionModeLabel("instagram_login")).toBe("Instagram Login");
    expect(privateAvailabilityFromResponse(404, { message: "Cannot GET route" }).state).toBe("contract_unverified");
    expect(privateAvailabilityCopy({ state: "permission_missing" })).toMatchObject({ title: "Messaging permission missing", action: "Reconnect in Channels" });
  });

  it("bounds polling to mutable provider states and keeps cancellation role-safe", () => {
    expect(privateNeedsTerminalPoll([{ status: "queued" }])).toBe(true);
    expect(privateNeedsTerminalPoll([{ status: "processing" }])).toBe(true);
    expect(privateNeedsTerminalPoll([{ status: "uncertain" }, { status: "succeeded" }])).toBe(false);
    expect(privateCanCancelIntent("creator", "creator-1", { requestedBy: "creator-1", status: "draft" })).toBe(true);
    expect(privateCanCancelIntent("creator", "creator-2", { requestedBy: "creator-1", status: "draft" })).toBe(false);
    expect(privateCanCancelIntent("manager", "manager-1", { requestedBy: "creator-1", status: "uncertain" })).toBe(false);
  });
});
