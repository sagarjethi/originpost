import { describe, expect, it } from "vitest";
import { createEvergreenEntry, evergreenFreshnessFlags, materializeEvergreenOccurrence, nextEvergreenTime, type Actor, type ContentItem } from "../src/index.js";

const manager: Actor = { id: "manager_1", name: "Mira", role: "manager", actorType: "human" };
function source(tags: string[] = []): ContentItem {
  return { id: "content_source", workspaceId: "workspace_1", brandId: "brand_1", version: 9, title: "A useful guide", summary: "Still useful later", status: "published", researchDepth: "standard", riskLevel: "low", tags, sources: [{ id: "source_1", kind: "url", title: "Original source", url: "https://example.com/guide", capturedAt: "2026-01-01T00:00:00.000Z", rights: "cleared", confidence: 100 }], claims: [], researchRuns: [], drafts: [{ id: "draft_1", revision: 1, contentSha256: "a".repeat(64), createdBy: "creator", createdAt: "2026-01-01T00:00:00.000Z", platform: "instagram", format: "image", title: "Guide", caption: "Save this guide", mediaIds: ["media_1"] }], approvals: [{ id: "approval_1", draftId: "draft_1", draftSha256: "a".repeat(64), actorId: "manager_1", actorName: "Mira", decision: "approved", createdAt: "2026-01-01T01:00:00.000Z" }], reviewComments: [], reviewLinks: [], targets: [{ id: "target_1", platform: "instagram", accountId: "account_1", draftId: "draft_1", scheduledFor: "2026-01-02T00:00:00.000Z", deliveryMode: "auto_publish", status: "published" }], publishAttempts: [], proofs: [{ id: "proof_1", contentItemId: "content_source", draftId: "draft_1", draftSha256: "a".repeat(64), platform: "instagram", accountId: "account_1", externalPostId: "external_1", liveUrl: "https://instagram.com/p/example", publishedAt: "2026-01-02T00:00:00.000Z", captionSha256: "b".repeat(64), mediaSha256: ["c".repeat(64)], connectorResponseSha256: "d".repeat(64), approvedBy: "manager_1", sourceIds: ["source_1"], disclosure: "none" }], createdBy: "creator", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
}

describe("evergreen reuse", () => {
  it("creates a bounded policy and a fresh human-review draft", () => {
    const created = createEvergreenEntry({ source: source(), proofId: "proof_1", name: "Monthly guide", mode: "review_first", intervalDays: 30, timezone: "Asia/Kolkata", firstPublishAt: "2026-09-15T10:00:00.000Z", endAt: "2027-01-01T00:00:00.000Z", maxOccurrences: 4, actor: manager, now: "2026-09-01T00:00:00.000Z" });
    const claimed = { ...created.entry, claimId: "claim_1", claimOwner: "worker", claimLeaseExpiresAt: "2026-09-01T00:10:00.000Z", pendingOccurrenceNo: 1, pendingContentItemId: "content_reuse_1" };
    const result = materializeEvergreenOccurrence(claimed, source(), "2026-09-01T00:01:00.000Z");
    expect(result.item.id).toBe("content_reuse_1");
    expect(result.item.status).toBe("drafting");
    expect(result.item.drafts[0]?.id).not.toBe("draft_1");
    expect(result.item.targets).toHaveLength(0);
    expect(result.item.approvals).toHaveLength(0);
    expect(result.occurrence.status).toBe("review_ready");
    expect(nextEvergreenTime(created.entry).nextPublishAt).toBe("2026-10-15T10:00:00.000Z");
  });

  it("rejects automatic reposts and accepts reviewed news refreshes", () => {
    expect(() => createEvergreenEntry({ source: source(["news", "signal"]), proofId: "proof_1", name: "Unsafe auto", mode: "auto_schedule", intervalDays: 30, timezone: "UTC", firstPublishAt: "2026-09-15T10:00:00.000Z", endAt: "2026-12-01T00:00:00.000Z", maxOccurrences: 2, actor: manager, now: "2026-09-01T00:00:00.000Z" })).toThrow(/human approval/i);
    const safe = createEvergreenEntry({ source: source(["news", "signal"]), proofId: "proof_1", name: "Reviewed reuse", mode: "review_first", intervalDays: 30, timezone: "UTC", firstPublishAt: "2026-09-15T10:00:00.000Z", endAt: "2026-12-01T00:00:00.000Z", maxOccurrences: 2, actor: manager, now: "2026-09-01T00:00:00.000Z" });
    expect(safe.entry.mode).toBe("review_first");
  });
  it("shows time-sensitive and rights checks instead of hiding them",()=>{const value=source();value.summary="Offer ₹499 today during election week";value.sources[0]!.rights="reference-only";expect(evergreenFreshnessFlags(value)).toEqual(expect.arrayContaining(["Check relative dates and live references.","Check prices and offers.","Check changing public facts with current sources.","Reference-only sources do not grant media reuse rights."]));});
  it("keeps the chosen local wall time across daylight-saving changes",()=>{const created=createEvergreenEntry({source:source(),proofId:"proof_1",name:"Weekly guide",mode:"review_first",intervalDays:7,timezone:"America/New_York",firstPublishAt:"2026-03-01T14:00:00.000Z",endAt:"2026-06-01T00:00:00.000Z",maxOccurrences:4,actor:manager,now:"2026-01-01T00:00:00.000Z"});expect(nextEvergreenTime(created.entry).nextPublishAt).toBe("2026-03-08T13:00:00.000Z");});
});
