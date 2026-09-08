import { describe, expect, it } from "vitest";
import {
  collaboratorStatusRows,
  normalizeCollaboratorInput,
  parseCollaboratorCapability,
  parseCollaboratorCapabilityView,
  parseCollaboratorCandidates,
  parseCollaboratorInviteProof,
  parseCollaboratorSettingsApproval,
  parseCollaboratorStatusResult,
  shortCollaboratorHash,
} from "./instagram-collaborator-utils";

describe("Instagram collaborator UI helpers", () => {
  it("normalizes up to three unique Instagram usernames", () => {
    expect(normalizeCollaboratorInput(" @News.One, NEWS.one\nsecond_user third.user ")).toEqual({ usernames: ["news.one", "second_user", "third.user"], error: null });
    expect(normalizeCollaboratorInput("one two three four").error).toBe("Instagram accepts at most 3 collaborators.");
    expect(normalizeCollaboratorInput(".invalid").error).toBe("Use Instagram usernames with letters, numbers, periods, or underscores.");
    expect(normalizeCollaboratorInput("publisher", "@Publisher").error).toBe("The publishing Instagram account cannot invite itself.");
  });

  it("parses supported and Facebook-Login-required capability responses", () => {
    expect(parseCollaboratorCapability({ data: { capability: { state: "supported", connectionMode: "facebook_login", publish: true, statusRead: true, maxCollaborators: 3 } } })).toEqual({ state: "supported", connectionMode: "facebook_login", publish: true, statusRead: true, maxCollaborators: 3 });
    expect(parseCollaboratorCapabilityView({ data: { publishingUsername: "Publisher.Name", capability: { state: "supported", connectionMode: "facebook_login", publish: true, statusRead: true, maxCollaborators: 3 } } })).toEqual({ publishingUsername: "publisher.name", capability: { state: "supported", connectionMode: "facebook_login", publish: true, statusRead: true, maxCollaborators: 3 } });
    expect(parseCollaboratorCapability({ data: { capability: { state: "unsupported", connectionMode: "instagram_login", reason: "facebook_login_required", maxCollaborators: 3 } } })).toEqual({ state: "unsupported", connectionMode: "instagram_login", reason: "facebook_login_required", maxCollaborators: 3 });
    expect(parseCollaboratorCapability({ data: { capability: { state: "supported", connectionMode: "instagram_login" } } })).toBeNull();
  });

  it("keeps approval-bound settings and exact server hash together", () => {
    const hash = "a".repeat(64);
    expect(parseCollaboratorSettingsApproval({ data: { settings: { collaborators: ["one", "two"], isAiGenerated:true, approvedSettingsSha256: hash }, approvedAt: "2026-08-29T12:00:00.000Z", draftId: "draft-1", draftSha256: "b".repeat(64), accountId: "account-1", publishingUsername: "publisher" } })).toEqual({ collaborators: ["one", "two"], shareToFeed:true, isAiGenerated:true, approvedSettingsSha256: hash, approvedAt: "2026-08-29T12:00:00.000Z", draftId: "draft-1", draftSha256: "b".repeat(64), accountId: "account-1", publishingUsername: "publisher" });
    expect(parseCollaboratorSettingsApproval({ data: { settings: { collaborators: ["one"], approvedSettingsSha256: "not-a-hash" } } })).toBeNull();
    expect(parseCollaboratorSettingsApproval({ data: { settings: { collaborators: ["one"], isAiGenerated:"yes", approvedSettingsSha256: hash }, accountId:"account-1", publishingUsername:"publisher" } })).toBeNull();
    expect(shortCollaboratorHash(hash)).toBe("aaaaaaaa…aaaaaaaa");
  });

  it("keeps pending and approved candidates separate", () => {
    const hash = "a".repeat(64);
    const candidates = parseCollaboratorCandidates([{ id: "candidate-1", status: "pending_approval", requestedBy: "editor-1", requestedAt: "2026-08-29T11:00:00.000Z", accountId: "account-1", publishingUsername: "publisher", draftId: "draft-1", draftSha256: "b".repeat(64), settings: { collaborators: ["one"], approvedSettingsSha256: hash } }]);
    expect(candidates).toMatchObject([{ id: "candidate-1", status: "pending_approval", collaborators: ["one"] }]);
  });

  it("parses invite proof without treating requested as accepted", () => {
    const hash = "c".repeat(64);
    expect(parseCollaboratorInviteProof({ data: { collaboratorInviteProof: { requestedUsernames: ["one"], requestedUsernamesSha256: hash, requestState: "requested_unverified", providerConnectionMode: "facebook_login" } } })).toEqual({ requestedUsernames: ["one"], requestedUsernamesSha256: hash, requestState: "requested_unverified", providerConnectionMode: "facebook_login" });
  });

  it("shows pending, accepted, not-returned, and unavailable as different states", () => {
    const response = parseCollaboratorStatusResult({ data: { snapshots: [
      { proofId: "proof-1", externalMediaId: "media-1", username: "one", status: "accepted", capturedAt: "2026-08-29T12:00:00.000Z", providerResponseSha256: "d".repeat(64) },
      { proofId: "proof-1", externalMediaId: "media-1", username: "two", status: "pending", capturedAt: "2026-08-29T12:00:00.000Z", providerResponseSha256: "d".repeat(64) },
      { proofId: "proof-1", externalMediaId: "media-1", username: "four", status: "unavailable", capturedAt: "2026-08-29T12:00:00.000Z", providerResponseSha256: "d".repeat(64) },
    ], capturedAt: "2026-08-29T12:00:00.000Z", trackingStatus: "pending", providerReadComplete: true, availability: "available", rawResponseSha256: "d".repeat(64), retry: { recommended: true, nextAttemptAt: "2026-08-29T18:00:00.000Z" } } });
    expect(response?.snapshots).toHaveLength(3);
    expect(response).toMatchObject({ trackingStatus: "pending", providerReadComplete: true, nextAttemptAt: "2026-08-29T18:00:00.000Z" });
    expect(collaboratorStatusRows(["one", "two", "three", "four"], response?.snapshots ?? []).map((row) => row.status)).toEqual(["accepted", "pending", "not_returned", "unavailable"]);
  });
});
