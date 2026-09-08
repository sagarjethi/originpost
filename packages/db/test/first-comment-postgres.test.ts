import { approveFirstCommentIntent, bindFirstCommentToProof, createFirstCommentIntent, submitFirstCommentIntent, type AuditEvent, type ContentItem, type PublishProof } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContentRepository } from "../src/factory.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-first-comment-integration";
const brandId = "brand-first-comment-integration";
const contentItemId = "content-first-comment-integration";
const accountId = "account-first-comment-integration";
const targetId = "target-first-comment-integration";
const at = "2026-09-01T10:00:00.000Z";
const actor = { id: "first-comment-creator", name: "Creator", role: "creator" as const, actorType: "human" as const };
const manager = { id: "first-comment-manager", name: "Manager", role: "manager" as const, actorType: "human" as const };
const event = (id: string, action: string): AuditEvent => ({ id, workspaceId, contentItemId, actorId: "first-comment-test", actorType: "system", action, detail: {}, createdAt: at });

const proof: PublishProof = { id: "proof-first-comment-integration", contentItemId, draftId: "draft-first-comment-integration", draftSha256: "a".repeat(64), platform: "instagram", accountId, externalPostId: "ig-first-comment-post", liveUrl: "https://www.instagram.com/p/example/", publishedAt: at, captionSha256: "b".repeat(64), mediaSha256: [], connectorResponseSha256: "c".repeat(64), approvedBy: manager.id, sourceIds: [], disclosure: "none" };
const item: ContentItem = {
  id: contentItemId, workspaceId, brandId, version: 1, title: "First comment integration", summary: "", status: "published", riskLevel: "low", sources: [], claims: [], tags: [],
  drafts: [{ id: proof.draftId, revision: 1, platform: "instagram", format: "image", title: "Post", caption: "Caption", mediaIds: [], contentSha256: proof.draftSha256, createdBy: actor.id, createdAt: at }],
  approvals: [{ id: "approval-first-comment-integration", draftId: proof.draftId, draftSha256: proof.draftSha256, decision: "approved", actorId: manager.id, actorName: manager.name, actorType: "human", note: "", createdAt: at }],
  reviewComments: [], reviewLinks: [], targets: [{ id: targetId, platform: "instagram", accountId, draftId: proof.draftId, scheduledFor: at, deliveryMode: "auto_publish", status: "published" }],
  publishAttempts: [], proofs: [proof], researchRuns: [], createdBy: actor.id, createdAt: at, updatedAt: at,
};

suite("Postgres first-comment repository", () => {
  const sql = postgres(databaseUrl!);
  let infrastructure: Awaited<ReturnType<typeof createContentRepository>>;

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'First comment integration','first-comment-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'First comment brand','first-comment-brand','English','UTC','active','first-comment-test',${at},${at}) on conflict(id) do nothing`;
    infrastructure = await createContentRepository({ databaseUrl: databaseUrl!, allowMemoryFallback: false });
    await infrastructure.connectedAccountRepository.save({ id: accountId, workspaceId, brandId, platform: "instagram", displayName: "@firstcomment", externalAccountId: "ig-first-comment", capabilities: ["profile_read", "media_publish", "comment_read", "comment_reply"], status: "healthy", createdBy: actor.id, createdAt: at, updatedAt: at }, { ...event("audit-first-comment-account", "test.account-created"), contentItemId: undefined });
    await infrastructure.repository.commit(item, event("audit-first-comment-content", "test.content-created"));
  });

  afterAll(async () => {
    await sql`alter table first_comment_proofs disable trigger first_comment_proofs_append_only`;
    await sql`delete from first_comment_proofs where workspace_id=${workspaceId}`;
    await sql`alter table first_comment_proofs enable trigger first_comment_proofs_append_only`;
    await sql`delete from first_comment_intents where workspace_id=${workspaceId}`.catch(() => undefined);
    await sql`delete from publish_proofs where content_item_id=${contentItemId}`;
    await sql`delete from content_items where workspace_id=${workspaceId}`;
    await sql`delete from connected_accounts where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("elects one writer, fences an expired lease, and appends one provider proof", async () => {
    const requested = createFirstCommentIntent({ id: "first-comment-integration", item, targetId, body: "Full report: https://example.com", actor, now: at });
    const approved = approveFirstCommentIntent(submitFirstCommentIntent(requested, actor, at), { actorId: manager.id, actorType: "human", approvedAt: at, mode: "two_person" });
    const queued = bindFirstCommentToProof(approved, proof, at);
    expect(await infrastructure.firstCommentRepository.create(queued, event("audit-first-comment-created", "first_comment.created"))).toBe(true);
    const claims = await Promise.all([
      infrastructure.firstCommentRepository.claimForExecution(workspaceId, queued.id, "worker-a", 180, event("audit-first-comment-claim-a", "first_comment.processing")),
      infrastructure.firstCommentRepository.claimForExecution(workspaceId, queued.id, "worker-b", 180, event("audit-first-comment-claim-b", "first_comment.processing")),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims[0] ? "worker-a" : "worker-b";
    const acceptedAt = "2026-09-01T10:00:30.000Z";
    await sql`update first_comment_intents set claim_expires_at=clock_timestamp()-interval '1 second' where workspace_id=${workspaceId} and id=${queued.id}`;
    expect(await infrastructure.firstCommentRepository.checkpointProviderEvidence(workspaceId, queued.id, owner, { providerCommentId: "stale-comment", providerAcceptedAt: acceptedAt, providerResponseSha256: "d".repeat(64) }, "2020-01-01T00:00:00.000Z")).toBe(false);
    await sql`update first_comment_intents set claim_expires_at=clock_timestamp()+interval '5 minutes' where workspace_id=${workspaceId} and id=${queued.id}`;
    expect(await infrastructure.firstCommentRepository.checkpointProviderEvidence(workspaceId, queued.id, owner, { providerCommentId: "comment-provider-1", providerAcceptedAt: acceptedAt, providerResponseSha256: "d".repeat(64) }, acceptedAt)).toBe(true);
    const resolved = await infrastructure.firstCommentRepository.resolveWithProof({ workspaceId, intentId: queued.id, owner, proofId: "first-comment-proof-integration", resolvedAt: acceptedAt, evidence: { grade: "provider_confirmed", providerCommentId: "comment-provider-1", providerAcceptedAt: acceptedAt, providerResponseSha256: "e".repeat(64), observedAt: acceptedAt } }, event("audit-first-comment-resolved", "first_comment.provider-confirmed"));
    expect(resolved).toMatchObject({ intent: { status: "succeeded" }, proof: { evidence: { grade: "provider_confirmed" } } });
    await expect(infrastructure.firstCommentRepository.resolveWithProof({ workspaceId, intentId: queued.id, owner, proofId: "forged-second-proof", resolvedAt: acceptedAt, evidence: { grade: "provider_confirmed", providerCommentId: "other", providerAcceptedAt: acceptedAt, providerResponseSha256: "f".repeat(64), observedAt: acceptedAt } }, event("audit-first-comment-duplicate", "first_comment.provider-confirmed"))).resolves.toBeNull();
    await expect(infrastructure.repository.commit({ ...item, version: 2, updatedAt: acceptedAt }, event("audit-first-comment-content-update", "test.content-updated"))).resolves.toBeUndefined();
  });
});
