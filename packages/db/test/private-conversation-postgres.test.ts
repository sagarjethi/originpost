import { privateConversationBodyIntegrityKey, type AuditEvent, type PrivateReplyIntent } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPrivateConversationRepository } from "../src/postgres-private-conversation-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const encryptionKey = Buffer.alloc(32, 0x41);
const hashKey = Buffer.alloc(32, 0x72);
const workspaceId = "workspace-private-integration";
const brandId = "brand-private-integration";
const accountId = "account-private-integration";
const ownerId = "owner-private-integration";
const at = "2026-08-31T12:00:00.000Z";

suite("Postgres private conversation repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresPrivateConversationRepository(sql, { encryptionKey, hashKey });
  const scope = { workspaceId, brandId };
  const event = (id: string, actorId = ownerId): AuditEvent => ({ id, workspaceId, actorId, actorType: "human", action: id, detail: {}, createdAt: at });
  const eligibility = { state: "eligible", checkedAt: at, expiresAt: "2026-08-31T13:00:00.000Z", evidence: { mode: "standard", qualifyingEventAt: at, durationSeconds: 3600 }, contractVersion: "meta-v1" } as const;

  beforeAll(async () => {
    await sql`insert into workspaces (id, name, slug, created_at) values (${workspaceId}, 'Private integration', 'private-integration', ${at}) on conflict (id) do nothing`;
    await sql`insert into auth_users (id, email, display_name, password_hash, status, created_at, updated_at) values (${ownerId}, 'private-integration@example.invalid', 'Owner', 'disabled', 'active', ${at}, ${at}) on conflict (id) do nothing`;
    await sql`insert into workspace_members (workspace_id, user_id, display_name, role, created_at, updated_at) values (${workspaceId}, ${ownerId}, 'Owner', 'owner', ${at}, ${at}) on conflict (workspace_id, user_id) do nothing`;
    await sql`insert into brands (id, workspace_id, name, slug, primary_language, timezone, status, created_by, created_at, updated_at) values (${brandId}, ${workspaceId}, 'Private brand', 'private', 'English', 'UTC', 'active', ${ownerId}, ${at}, ${at}) on conflict (id) do nothing`;
    await sql`insert into connected_accounts (id, workspace_id, brand_id, platform, display_name, external_account_id, status, created_by, created_at, updated_at, payload) values (${accountId}, ${workspaceId}, ${brandId}, 'instagram', 'Instagram', 'account-provider-id', 'healthy', ${ownerId}, ${at}, ${at}, '{}'::jsonb) on conflict (id) do nothing`;
  });

  afterAll(async () => { await sql.end(); });

  it("round-trips exact execution references while public views and stored clear columns omit them", async () => {
    const ingest = await repository.ingestProviderObservations(scope, { accountId, platform: "instagram", connectionMode: "instagram_login", externalConversationId: "exact-conversation", participants: [{ externalParticipantId: "exact-recipient", role: "customer", displayName: "Reader" }], messages: [{ externalMessageId: "exact-anchor", externalSenderId: "exact-recipient", direction: "incoming", kind: "text", body: "Secret short body", attachments: [], isEcho: false, availability: "available", deliveryState: "unknown", observationKind: "message", observedAt: at }], replyEligibility: eligibility, syncedAt: at }, event("pg-ingest"));
    const view = await repository.get(scope, ingest.conversation.id, ownerId);
    expect(view?.conversation).not.toHaveProperty("providerConversationKey"); expect(view?.messages[0]).not.toHaveProperty("providerMessageKey"); expect(view?.messages[0]).not.toHaveProperty("bodyIntegrityKey");
    const stored = await sql<Record<string, unknown>[]>`select provider_message_key_hash, provider_message_key_envelope, body_envelope, body_integrity_key from private_messages where conversation_id = ${ingest.conversation.id}`;
    expect(JSON.stringify(stored)).not.toContain("exact-anchor"); expect(JSON.stringify(stored)).not.toContain("Secret short body"); expect(stored[0]?.body_integrity_key).toMatch(/^[0-9a-f]{64}$/);
    const body = "Provider reply"; const anchorId = view!.messages[0]!.id; const intent: PrivateReplyIntent = { id: "pg-reply", workspaceId, brandId, conversationId: ingest.conversation.id, inReplyToMessageId: anchorId, body, bodyIntegrityKey: privateConversationBodyIntegrityKey(body, hashKey), status: "pending_approval", idempotencyKey: "pg-reply-v1", requestedBy: ownerId, attemptCount: 0, createdAt: at, updatedAt: at, version: 1 };
    await repository.saveReplyIntent(intent, event("pg-reply-create"));
    expect(await repository.getReplyApprovalContext(scope, intent.id)).toMatchObject({ externalConversationId: "exact-conversation", anchorMessage: { providerMessageKey: "exact-anchor" } });
    const queued = await repository.transitionReplyIntent(scope, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: ownerId, at, approvedBy: ownerId, eligibilityAtApproval: eligibility }, event("pg-reply-queued"));
    const second = { ...intent, id: "pg-reply-second", idempotencyKey: "pg-reply-second-v1" };
    await repository.saveReplyIntent(second, event("pg-reply-second-create"));
    await expect(repository.transitionReplyIntent(scope, { intentId: second.id, expectedVersion: 1, to: "queued", actorId: ownerId, at, approvedBy: ownerId, eligibilityAtApproval: eligibility }, event("pg-reply-second-queued"))).rejects.toMatchObject({ code: "23505" });
    const claimed = await repository.claimReplyIntentForExecution(scope, { intentId: intent.id, expectedVersion: queued!.version, owner: "worker", at, leaseSeconds: 60 }, event("pg-reply-claim"));
    expect(claimed).toMatchObject({ externalConversationId: "exact-conversation", externalRecipientId: "exact-recipient", inReplyToExternalMessageId: "exact-anchor" });
    const sent = await repository.transitionReplyIntent(scope, { intentId: intent.id, expectedVersion: claimed!.intent.version, to: "succeeded", actorId: "worker", at, leaseOwner: claimed!.intent.leaseOwner, providerMessageKey: "exact-outgoing", providerAcceptedAt: at }, { ...event("pg-reply-sent", "worker"), actorType: "system" });
    expect(sent?.providerMessageKey).toBe("exact-outgoing"); expect((await repository.getReplyIntent(scope, intent.id))?.providerMessageKey).toBe("exact-outgoing");
    const purged = await repository.purgeExpired("2027-01-01T00:00:00.000Z");
    expect(purged).toMatchObject({ messages: 1, replyIntents: 1, participants: 1 });
    const retainedView = await repository.get(scope, ingest.conversation.id, ownerId);
    expect(retainedView?.messages[0]).toMatchObject({ availability: "expired", attachments: [] });
    expect(retainedView?.messages[0]).not.toHaveProperty("body");
    await expect(repository.getReplyIntent(scope, intent.id)).resolves.toBeNull();
  });
});
