import { describe, expect, it } from "vitest";
import {
  correctionActions,
  correctionApprovalMode,
  correctionControlState,
  correctionPermission,
  correctionStatusView,
  attestationTimeError,
  evidenceGradeView,
  hasEligiblePublishProofs,
  localDateTimeInputValue,
  parseCapabilityResponse,
  parseCorrectionListResponse,
  shortHash,
} from "./remote-correction-utils";

describe("remote correction UI helpers", () => {
  it("keeps mutation permissions behind managers and owners", () => {
    expect(correctionPermission("owner")).toEqual({ canRequest: true, canApprove: true });
    expect(correctionPermission("manager")).toEqual({ canRequest: true, canApprove: true });
    expect(correctionPermission("creator")).toEqual({ canRequest: false, canApprove: false });
    expect(correctionPermission("viewer")).toEqual({ canRequest: false, canApprove: false });
    expect(correctionApprovalMode("manager", "manager-1", "creator-1")).toBe("two_person");
    expect(correctionApprovalMode("manager", "manager-1", "manager-1")).toBe("blocked");
    expect(correctionApprovalMode("owner", "owner-1", "owner-1")).toBe("single_owner_override");
  });

  it("parses capability envelopes without trusting malformed fields", () => {
    expect(parseCapabilityResponse({ data: { lineage: { publishProofId: "proof-1", platform: "youtube" }, capabilities: {
      platform: "youtube", providerVersion: "youtube-data-v3", resolvedAt: "2026-08-29T12:00:00.000Z",
      actions: { make_private: { state: "supported" }, delete_remote: { state: "scope_required", reason: "Reconnect" } },
    } } })).toMatchObject({ platform: "youtube", providerVersion: "youtube-data-v3", actions: { make_private: { state: "supported" } } });
    expect(parseCapabilityResponse({ data: { capabilities: { platform: "tiktok", actions: { delete_remote: { state: "yes" } } } } })).toBeNull();
  });

  it("parses operation records and rejects values without a usable operation", () => {
    const records = parseCorrectionListResponse({ data: [
      { operation: { id: "op-1", publishProofId: "proof-1", platform: "instagram", externalPostId: "ig-1", mutation: { action: "delete_remote" }, reason: "Wrong post", requestedBy: "user-1", requestedAt: "2026-08-29T12:00:00.000Z", immutableIntentSha256: "a".repeat(64), status: "uncertain", createdAt: "2026-08-29T12:00:00.000Z", updatedAt: "2026-08-29T12:01:00.000Z" }, attempts: [], proofs: [] },
      { operation: { id: 42 } },
    ] });
    expect(records).toHaveLength(1);
    expect(records[0]?.operation.status).toBe("uncertain");
  });

  it("uses honest status and evidence labels", () => {
    expect(correctionStatusView("uncertain")).toMatchObject({ tone: "danger", actionRequired: true, terminal: false });
    expect(correctionStatusView("manual_action_required")).toMatchObject({ tone: "warning", actionRequired: true });
    expect(correctionStatusView("provider_confirmed").label).toBe("Provider confirmed");
    expect(correctionStatusView("operator_confirmed").label).toBe("Operator attested");
    expect(evidenceGradeView("operator_attested")).toEqual({ label: "Operator attested", detail: "A person supplied evidence. The provider did not independently confirm it.", tone: "warning" });
    expect(evidenceGradeView("provider_confirmed").label).toBe("Provider confirmed");
  });

  it("offers only the hardened API actions and formats hashes safely", () => {
    expect(correctionActions.map((action) => action.value)).toEqual(["make_private", "restore_visibility", "delete_remote", "manual_remove"]);
    expect(shortHash("a".repeat(64))).toBe("aaaaaaaa…aaaaaaaa");
    expect(shortHash(undefined)).toBe("Not recorded");
    expect(localDateTimeInputValue(new Date(2026, 7, 29, 19, 5))).toBe("2026-08-29T19:05");
  });

  it("blocks manual evidence dated before the approved operation", () => {
    const approvedAt = "2026-08-29T12:00:00.000Z";
    expect(attestationTimeError("2026-08-29T11:59:00.000Z", approvedAt, "2026-08-29T13:00:00.000Z")).toBe("Action time cannot be before this correction was approved.");
    expect(attestationTimeError("2026-08-29T12:01:00.000Z", approvedAt, "2026-08-29T13:00:00.000Z")).toBeNull();
    expect(attestationTimeError("2026-08-29T13:01:00.000Z", approvedAt, "2026-08-29T13:00:00.000Z")).toBe("Action time cannot be in the future.");
    expect(attestationTimeError("not-a-date", approvedAt, "2026-08-29T13:00:00.000Z")).toBe("Choose a valid action time.");
  });

  it("hides the surface without a supported publish proof", () => {
    expect(hasEligiblePublishProofs([])).toBe(false);
    expect(hasEligiblePublishProofs([{ id: "proof-1", platform: "linkedin", liveUrl: "https://example.test/post" }])).toBe(false);
    expect(hasEligiblePublishProofs([{ id: "proof-2", platform: "instagram", liveUrl: "https://instagram.com/p/1", evidenceMode: "official" }])).toBe(true);
    expect(hasEligiblePublishProofs([{ id: "proof-legacy", platform: "instagram", liveUrl: "https://instagram.com/p/legacy", evidenceMode: "legacy_unknown" }])).toBe(false);
    expect(hasEligiblePublishProofs([{ id: "proof-3", platform: "instagram", liveUrl: "https://instagram.example.invalid/p/1", evidenceMode: "simulation" }])).toBe(false);
  });

  it("maps request, approval, reconciliation, and manual evidence states", () => {
    expect(correctionControlState("pending_approval", "two_person")).toEqual({ approve: true, reconcile: false, attest: false });
    expect(correctionControlState("pending_approval", "blocked")).toEqual({ approve: false, reconcile: false, attest: false });
    expect(correctionControlState("uncertain", "two_person")).toEqual({ approve: false, reconcile: true, attest: false });
    expect(correctionControlState("finalizing", "two_person").reconcile).toBe(true);
    expect(correctionControlState("manual_action_required", "two_person")).toEqual({ approve: false, reconcile: false, attest: true });
    expect(correctionControlState("operator_confirmed", "two_person")).toEqual({ approve: false, reconcile: false, attest: false });
  });
});
