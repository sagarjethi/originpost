import { privateConversationBodyIntegrityKey, type AuditEvent, type PrivateProviderObservationBatch, type PrivateReplyIntent } from "@originpost/domain";
import { describe, expect, it } from "vitest";
import { InMemoryPrivateConversationRepository } from "../src/in-memory-private-conversation-repository.js";

const encryptionKey = Buffer.alloc(32, 0x31);
const hashKey = Buffer.alloc(32, 0x71);
const scope = { workspaceId: "workspace-a", brandId: "brand-a" };
const at = "2026-08-31T10:00:00.000Z";
const audit = (id: string, actorId = "owner"): AuditEvent => ({ id, workspaceId: scope.workspaceId, actorId, actorType: "human", action: id, detail: {}, createdAt: at });
const eligible = { state: "eligible", checkedAt: at, expiresAt: "2026-08-31T11:00:00.000Z", evidence: { mode: "standard", qualifyingEventAt: at, durationSeconds: 3600 }, contractVersion: "meta-v1" } as const;
const batch: PrivateProviderObservationBatch = { accountId: "account-a", platform: "instagram", connectionMode: "instagram_login", externalConversationId: "ig-conversation-secret", participants: [{ externalParticipantId: "ig-user-secret", role: "customer", username: "reader" }], messages: [{ externalMessageId: "ig-message-secret", externalSenderId: "ig-user-secret", direction: "incoming", kind: "text", body: "Hello", attachments: [], isEcho: false, availability: "available", deliveryState: "unknown", observationKind: "message", observedAt: at }], replyEligibility: eligible, syncedAt: at };

describe("private conversation repository", () => {
  it("keeps provider IDs and integrity digests out of inbox views but exposes exact server-only approval/send context", async () => {
    const repository = new InMemoryPrivateConversationRepository({ encryptionKey, hashKey });
    const ingest = await repository.ingestProviderObservations(scope, batch, audit("ingest"));
    const page = await repository.list(scope, { viewerId: "owner" });
    expect(page.items[0]?.conversation).not.toHaveProperty("providerConversationKey");
    expect(page.items[0]?.participants[0]).not.toHaveProperty("providerParticipantKey");
    expect(page.items[0]?.latestMessage).not.toHaveProperty("providerMessageKey");
    expect(page.items[0]?.latestMessage).not.toHaveProperty("bodyIntegrityKey");

    const anchor = (await repository.get(scope, ingest.conversation.id, "owner"))!.messages[0]!;
    const body = "Thanks"; const intent: PrivateReplyIntent = { id: "reply-a", workspaceId: scope.workspaceId, brandId: scope.brandId, conversationId: ingest.conversation.id, inReplyToMessageId: anchor.id, body, bodyIntegrityKey: privateConversationBodyIntegrityKey(body, hashKey), status: "pending_approval", idempotencyKey: "reply-a-v1", requestedBy: "owner", attemptCount: 0, createdAt: at, updatedAt: at, version: 1 };
    await repository.saveReplyIntent(intent, audit("reply-create"));
    await expect(repository.getReplyApprovalContext(scope, intent.id)).resolves.toMatchObject({ externalConversationId: "ig-conversation-secret", anchorMessage: { providerMessageKey: "ig-message-secret" } });
    const queued = await repository.transitionReplyIntent(scope, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: "owner", at, approvedBy: "owner", eligibilityAtApproval: eligible }, audit("reply-approve"));
    const claimed = await repository.claimReplyIntentForExecution(scope, { intentId: intent.id, expectedVersion: queued!.version, owner: "worker", at, leaseSeconds: 60 }, audit("reply-claim"));
    expect(claimed).toMatchObject({ externalConversationId: "ig-conversation-secret", externalRecipientId: "ig-user-secret", inReplyToExternalMessageId: "ig-message-secret" });
    const sent = await repository.transitionReplyIntent(scope, { intentId: intent.id, expectedVersion: claimed!.intent.version, to: "succeeded", actorId: "worker", at, leaseOwner: claimed!.intent.leaseOwner, providerMessageKey: "provider-outgoing-exact", providerAcceptedAt: at }, { ...audit("reply-sent", "worker"), actorType: "system" });
    expect(sent?.providerMessageKey).toBe("provider-outgoing-exact");
    expect((await repository.getReplyIntent(scope, intent.id))?.providerMessageKey).toBe("provider-outgoing-exact");
  });

  it("uses repository time and fencing to recover an expired send without allowing stale completion", async () => {
    let now = new Date(at); const repository = new InMemoryPrivateConversationRepository({ encryptionKey, hashKey }, () => now);
    const ingest = await repository.ingestProviderObservations(scope, batch, audit("ingest-2")); const anchor = (await repository.get(scope, ingest.conversation.id, "owner"))!.messages[0]!; const body = "Reply";
    await repository.saveReplyIntent({ id: "reply-b", workspaceId: scope.workspaceId, brandId: scope.brandId, conversationId: ingest.conversation.id, inReplyToMessageId: anchor.id, body, bodyIntegrityKey: privateConversationBodyIntegrityKey(body, hashKey), status: "queued", idempotencyKey: "reply-b-v1", requestedBy: "owner", approvedBy: "owner", eligibilityAtApproval: eligible, attemptCount: 0, createdAt: at, updatedAt: at, version: 1 }, audit("reply-b"));
    const claim = await repository.claimReplyIntentForExecution(scope, { intentId: "reply-b", expectedVersion: 1, owner: "worker", at, leaseSeconds: 60 }, audit("claim-b"));
    now = new Date("2026-08-31T10:01:01.000Z");
    expect((await repository.listReplyIntentsForRecovery(["processing"])).map((entry) => entry.id)).toEqual(["reply-b"]);
    const recovered = await repository.recoverExpiredReplyIntent(scope, { intentId: "reply-b", expectedVersion: claim!.intent.version, actorId: "recovery", at: now.toISOString() }, { ...audit("recover-b", "recovery"), actorType: "system", createdAt: now.toISOString() });
    expect(recovered).toMatchObject({ status: "uncertain", version: claim!.intent.version + 1 });
    await expect(repository.transitionReplyIntent(scope, { intentId: "reply-b", expectedVersion: claim!.intent.version, to: "succeeded", actorId: "worker", at: now.toISOString(), leaseOwner: claim!.intent.leaseOwner, providerMessageKey: "late", providerAcceptedAt: now.toISOString() }, { ...audit("late-b", "worker"), actorType: "system" })).rejects.toMatchObject({ code: "private_reply_version_conflict" });
  });

  it("immediately erases a provider-deleted message by its account-scoped ID and remains idempotent", async () => {
    const repository = new InMemoryPrivateConversationRepository({ encryptionKey, hashKey });
    const ingest = await repository.ingestProviderObservations(scope, batch, audit("ingest-delete"));
    const first = await repository.applyProviderMessageDeletion(scope, { accountId: batch.accountId, platform: batch.platform, connectionMode: batch.connectionMode, externalMessageId: "ig-message-secret", observedAt: at, rawPayloadSha256: "a".repeat(64) }, audit("provider-delete", "worker"));
    expect(first).toEqual({ found: true, alreadyDeleted: false });
    const message = (await repository.get(scope, ingest.conversation.id, "owner"))!.messages[0]!;
    expect(message).toMatchObject({ availability: "deleted", observationKind: "deleted", attachments: [] });
    expect(message).not.toHaveProperty("body");
    expect(message).not.toHaveProperty("bodyIntegrityKey");

    await expect(repository.applyProviderMessageDeletion(scope, { accountId: batch.accountId, platform: batch.platform, connectionMode: batch.connectionMode, externalMessageId: "ig-message-secret", observedAt: at }, audit("provider-delete-replay", "worker"))).resolves.toEqual({ found: true, alreadyDeleted: true });
    await expect(repository.applyProviderMessageDeletion({ workspaceId: "workspace-b", brandId: "brand-b" }, { accountId: batch.accountId, platform: batch.platform, connectionMode: batch.connectionMode, externalMessageId: "ig-message-secret", observedAt: at }, { ...audit("cross-scope", "worker"), workspaceId: "workspace-b" })).resolves.toEqual({ found: false, alreadyDeleted: false });
  });
});
