import { ProviderFirstCommentError, createSafeConnectorRegistry } from "@originpost/connectors";
import {
  approveFirstCommentIntent,
  bindFirstCommentToProof,
  createFirstCommentIntent,
  InMemoryContentItemRepository,
  InMemoryFirstCommentRepository,
  InMemoryNotificationRepository,
  submitFirstCommentIntent,
  transitionFirstComment,
  type ContentItem,
  type PublishProof,
} from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { executeFirstComment } from "../src/first-comment-worker.js";

const creator = { id: "creator-1", name: "Creator", role: "creator" as const, actorType: "human" as const };
const manager = { id: "manager-1", name: "Manager", role: "manager" as const, actorType: "human" as const };

function publicationProof(): PublishProof {
  return {
    id: "proof-1", contentItemId: "content-1", draftId: "draft-1", draftSha256: "a".repeat(64), platform: "instagram", accountId: "account-1",
    externalPostId: "ig-post-1", liveUrl: "https://www.instagram.com/p/example/", publishedAt: "2026-09-01T10:00:00.000Z",
    captionSha256: "b".repeat(64), mediaSha256: [], connectorResponseSha256: "c".repeat(64), approvedBy: manager.id, sourceIds: [], disclosure: "none",
  };
}

function content(proofs: PublishProof[] = [publicationProof()]): ContentItem {
  return {
    id: "content-1", workspaceId: "workspace-1", brandId: "brand-1", version: 1, title: "Mumbai update", summary: "", status: proofs.length ? "published" : "scheduled", riskLevel: "low", sources: [], claims: [], tags: [],
    drafts: [{ id: "draft-1", revision: 1, platform: "instagram", format: "image", title: "Post", caption: "Caption", mediaIds: [], contentSha256: "a".repeat(64), createdBy: creator.id, createdAt: "2026-09-01T09:00:00.000Z" }],
    approvals: [{ id: "approval-1", draftId: "draft-1", draftSha256: "a".repeat(64), decision: "approved", actorId: manager.id, actorName: manager.name, actorType: "human", note: "", createdAt: "2026-09-01T09:01:00.000Z" }],
    reviewComments: [], reviewLinks: [], targets: [{ id: "target-1", platform: "instagram", accountId: "account-1", draftId: "draft-1", scheduledFor: "2026-09-01T10:00:00.000Z", deliveryMode: "auto_publish", status: proofs.length ? "published" : "queued" }],
    publishAttempts: [], proofs, researchRuns: [], createdBy: creator.id, createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z",
  };
}

function approved(item: ContentItem) {
  const draft = createFirstCommentIntent({ id: "first-comment-1", item, targetId: "target-1", body: "Read the full update: https://example.com", actor: creator, now: "2026-09-01T09:05:00.000Z" });
  return approveFirstCommentIntent(submitFirstCommentIntent(draft, creator, "2026-09-01T09:06:00.000Z"), { actorId: manager.id, actorType: "human", approvedAt: "2026-09-01T09:07:00.000Z", mode: "two_person" });
}

async function fixture(intent = bindFirstCommentToProof(approved(content()), publicationProof())) {
  const repository = new InMemoryContentItemRepository();
  const item = content();
  await repository.commit(item, { id: "audit-content", workspaceId: item.workspaceId, contentItemId: item.id, actorId: creator.id, actorType: "human", action: "content.created", detail: {}, createdAt: item.createdAt });
  const firstComments = new InMemoryFirstCommentRepository(repository);
  await firstComments.create(intent, { id: "audit-first", workspaceId: intent.workspaceId, contentItemId: intent.contentItemId, actorId: creator.id, actorType: "human", action: "first_comment.created", detail: {}, createdAt: intent.createdAt });
  return { repository, firstComments, notifications: new InMemoryNotificationRepository() };
}

describe("first-comment worker", () => {
  it("creates, read-backs, and proves one exact comment", async () => {
    const state = await fixture();
    const result = await executeFirstComment({ ...state, connectors: createSafeConnectorRegistry() }, { workspaceId: "workspace-1", contentItemId: "content-1", intentId: "first-comment-1" }, "worker-1");
    expect(result).toMatchObject({ status: "succeeded" });
    await expect(state.firstComments.get("workspace-1", "first-comment-1")).resolves.toMatchObject({ intent: { status: "succeeded" }, proofs: [{ evidence: { grade: "provider_confirmed" } }] });
  });

  it("marks an ambiguous provider write uncertain and never invokes it again", async () => {
    const state = await fixture();
    const create = vi.fn(async () => { throw new ProviderFirstCommentError("Response was lost.", "uncertain"); });
    const connectors = { getFirstComment: () => ({ firstCommentCapability: async () => ({ state: "supported" as const, platform: "instagram" as const, providerVersion: "test", maxCharacters: 2_200 }), createFirstComment: create, inspectFirstComment: vi.fn() }) } as unknown as ReturnType<typeof createSafeConnectorRegistry>;
    await expect(executeFirstComment({ ...state, connectors }, { workspaceId: "workspace-1", contentItemId: "content-1", intentId: "first-comment-1" }, "worker-1")).resolves.toMatchObject({ status: "uncertain" });
    await expect(executeFirstComment({ ...state, connectors }, { workspaceId: "workspace-1", contentItemId: "content-1", intentId: "first-comment-1" }, "worker-2")).resolves.toMatchObject({ skipped: true, reason: "intent-uncertain" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("runs a requested reconciliation as read-only provider inspection", async () => {
    const queued = { ...transitionFirstComment({ ...bindFirstCommentToProof(approved(content()), publicationProof()), status: "processing" as const }, "uncertain", "2026-09-01T10:01:00.000Z", "Unknown provider result"), status: "queued" as const, executionMode: "reconcile" as const };
    const state = await fixture(queued);
    const create = vi.fn();
    const inspect = vi.fn(async () => ({ state: "matched" as const, providerCommentId: "comment-1", providerAcceptedAt: "2026-09-01T10:00:30.000Z", providerResponseSha256: "d".repeat(64), observedAt: "2026-09-01T10:02:00.000Z" }));
    const connectors = { getFirstComment: () => ({ firstCommentCapability: vi.fn(), createFirstComment: create, inspectFirstComment: inspect }) } as unknown as ReturnType<typeof createSafeConnectorRegistry>;
    await expect(executeFirstComment({ ...state, connectors }, { workspaceId: "workspace-1", contentItemId: "content-1", intentId: "first-comment-1" }, "worker-1")).resolves.toMatchObject({ status: "succeeded" });
    expect(create).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(1);
    await expect(state.firstComments.get("workspace-1", "first-comment-1")).resolves.toMatchObject({ proofs: [{ evidence: { grade: "provider_reconciled" } }] });
  });
});
