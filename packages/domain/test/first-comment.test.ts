import { describe, expect, it } from "vitest";
import { approveFirstCommentIntent, bindFirstCommentToProof, createFirstCommentIntent, createFirstCommentProof, firstCommentBodySha256, InMemoryFirstCommentRepository, reviseFirstCommentIntent, submitFirstCommentIntent, transitionFirstComment, type ContentItem, type PublishProof } from "../src/index.js";

const actor = { id: "creator-1", name: "Creator", role: "creator" as const, actorType: "human" as const };
const manager = { id: "manager-1", name: "Manager", role: "manager" as const, actorType: "human" as const };
const item: ContentItem = {
  id: "content-1", workspaceId: "workspace-1", brandId: "brand-1", version: 1, title: "Post", summary: "", status: "scheduled", riskLevel: "low", sources: [], claims: [], tags: [],
  drafts: [{ id: "draft-1", revision: 1, platform: "instagram", format: "image", title: "Post", caption: "Caption", mediaIds: [], contentSha256: "a".repeat(64), createdBy: actor.id, createdAt: "2026-09-01T09:00:00.000Z" }],
  approvals: [{ id: "approval-1", draftId: "draft-1", draftSha256: "a".repeat(64), decision: "approved", actorId: manager.id, actorName: manager.name, actorType: "human", note: "", createdAt: "2026-09-01T09:01:00.000Z" }],
  reviewComments: [], reviewLinks: [], targets: [{ id: "target-1", platform: "instagram", accountId: "account-1", draftId: "draft-1", scheduledFor: "2026-09-01T10:00:00.000Z", deliveryMode: "auto_publish", status: "queued" }], publishAttempts: [], proofs: [], researchRuns: [], createdBy: actor.id, createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T09:01:00.000Z",
};

function proof(): PublishProof { return { id: "proof-1", contentItemId: item.id, draftId: "draft-1", draftSha256: "a".repeat(64), platform: "instagram", accountId: "account-1", externalPostId: "ig-123", liveUrl: "https://instagram.com/p/test", publishedAt: "2026-09-01T10:00:00.000Z", captionSha256: "b".repeat(64), mediaSha256: [], connectorResponseSha256: "c".repeat(64), approvedBy: manager.id, sourceIds: [], disclosure: "none" }; }

describe("governed first comments", () => {
  it("binds exact approved target, draft hash, account, body and publication proof", () => {
    const draft = createFirstCommentIntent({ id: "first-1", item, targetId: "target-1", body: "  Link in bio #Mumbai  ", actor, now: "2026-09-01T09:02:00.000Z" });
    expect(draft.body).toBe("Link in bio #Mumbai");
    expect(draft.bodySha256).toBe(firstCommentBodySha256("Link in bio #Mumbai"));
    const revised = reviseFirstCommentIntent(draft, { body: "Full story: https://example.com", actor, at: "2026-09-01T09:03:00.000Z" });
    const submitted = submitFirstCommentIntent(revised, actor, "2026-09-01T09:04:00.000Z");
    const approved = approveFirstCommentIntent(submitted, { actorId: manager.id, actorType: "human", approvedAt: "2026-09-01T09:05:00.000Z", mode: "two_person" });
    const queued = bindFirstCommentToProof(approved, proof(), "2026-09-01T10:00:01.000Z");
    expect(queued).toMatchObject({ status: "queued", publishProofId: "proof-1", externalPostId: "ig-123" });
  });

  it("rejects unapproved drafts and mismatched publication proof lineage", () => {
    const unapproved = { ...item, approvals: [] };
    expect(() => createFirstCommentIntent({ item: unapproved, targetId: "target-1", body: "Comment", actor })).toThrow(/Approve the exact target draft/);
    const intent = approveFirstCommentIntent(submitFirstCommentIntent(createFirstCommentIntent({ item, targetId: "target-1", body: "Comment", actor }), actor), { actorId: manager.id, actorType: "human", approvedAt: new Date().toISOString(), mode: "two_person" });
    expect(() => bindFirstCommentToProof(intent, { ...proof(), accountId: "other" })).toThrow(/does not match/);
  });

  it("requires an active execution lease for provider-grade proof and never requeues expired work", async () => {
    let now = new Date("2026-09-01T10:00:00.000Z");
    const publishedItem = { ...item, proofs: [proof()] };
    const repo = new InMemoryFirstCommentRepository({ get: async () => publishedItem }, () => now);
    const created = approveFirstCommentIntent(submitFirstCommentIntent(createFirstCommentIntent({ id: "first-1", item, targetId: "target-1", body: "Comment", actor, now: "2026-09-01T09:02:00.000Z" }), actor, "2026-09-01T09:03:00.000Z"), { actorId: manager.id, actorType: "human", approvedAt: "2026-09-01T09:04:00.000Z", mode: "two_person" });
    const queued = bindFirstCommentToProof(created, proof(), "2026-09-01T10:00:00.000Z");
    await repo.create(queued, { id: "audit-1", workspaceId: item.workspaceId, actorId: actor.id, actorType: "human", action: "first_comment.created", detail: {}, createdAt: queued.createdAt });
    const context = await repo.claimForExecution(item.workspaceId, queued.id, "worker-1", 60, { id: "audit-2", workspaceId: item.workspaceId, actorId: "worker", actorType: "system", action: "first_comment.claimed", detail: {}, createdAt: now.toISOString() });
    expect(context?.intent.status).toBe("processing");
    now = new Date("2026-09-01T10:02:00.000Z");
    const result = await repo.resolveWithProof({ workspaceId: item.workspaceId, intentId: queued.id, owner: "worker-1", proofId: "comment-proof-1", resolvedAt: now.toISOString(), evidence: { grade: "provider_confirmed", providerCommentId: "comment-1", providerAcceptedAt: now.toISOString(), providerResponseSha256: "d".repeat(64), observedAt: now.toISOString() } }, { id: "audit-3", workspaceId: item.workspaceId, actorId: "worker", actorType: "system", action: "first_comment.succeeded", detail: {}, createdAt: now.toISOString() });
    expect(result).toBeNull();
    const recovered = await repo.recoverExpiredProcessing();
    expect(recovered[0]?.status).toBe("uncertain");
  });

  it("verifies canonical operator evidence rather than relabeling it as provider proof", () => {
    const approved = approveFirstCommentIntent(submitFirstCommentIntent(createFirstCommentIntent({ item, targetId: "target-1", body: "Comment", actor }), actor), { actorId: manager.id, actorType: "human", approvedAt: new Date().toISOString(), mode: "two_person" });
    const uncertain = transitionFirstComment({ ...bindFirstCommentToProof(approved, proof()), status: "processing" }, "uncertain", new Date().toISOString(), "Unknown outcome");
    expect(() => createFirstCommentProof(uncertain, { grade: "operator_attested", actorId: manager.id, occurredAt: new Date().toISOString(), evidenceUrl: "https://instagram.com/p/test", noteSha256: "e".repeat(64), observationSha256: "f".repeat(64), observedAt: new Date().toISOString() }, "first-proof", new Date().toISOString())).toThrow(/canonical digest/);
  });
});
