import type { Actor, ConnectedAccount, EncryptedCredential, ProviderGrant } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnectedAccountRepository } from "../src/postgres-connected-account-repository.js";
import { PostgresOutboxRepository } from "../src/postgres-outbox-repository.js";
import { PostgresProviderLifecycleRepository } from "../src/postgres-provider-lifecycle-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceA = "workspace-provider-lifecycle-a";
const workspaceB = "workspace-provider-lifecycle-b";
const workspaceValidation = "workspace-provider-lifecycle-validation";
const brandA = "brand-provider-lifecycle-a";
const brandB = "brand-provider-lifecycle-b";
const brandValidation = "brand-provider-lifecycle-validation";
const subjectLookupHmac = "a".repeat(64);
const owner: Actor = { id: "provider-lifecycle-owner", name: "Provider Lifecycle Owner", role: "owner" };

suite("Postgres provider lifecycle", () => {
  const sql = postgres(databaseUrl!);
  const accounts = new PostgresConnectedAccountRepository(sql);
  const lifecycle = new PostgresProviderLifecycleRepository(sql);
  const outbox = new PostgresOutboxRepository(sql);
  const createdAt = "2026-09-07T12:00:00.000Z";

  function grant(workspaceId: string, id: string, scopes: string[]): ProviderGrant {
    return { id, workspaceId, provider: "meta", authorizationKind: "facebook_login", clientId: "meta-app-1", lookupKeyVersion: "v1", subjectLookupHmac, status: "active", scopes, version: 1, issuedAt: createdAt, lastCheckedAt: createdAt, lastHealthyAt: createdAt, createdBy: owner.id, createdAt, updatedAt: createdAt };
  }

  function credential(workspaceId: string, id: string): EncryptedCredential {
    return { id, workspaceId, purpose: "provider-token", keyVersion: "v1", algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "ciphertext", createdAt, updatedAt: createdAt };
  }

  async function saveAccount(workspaceId: string, brandId: string, id: string, grantValue: ProviderGrant) {
    const account: ConnectedAccount = { id, workspaceId, brandId, platform: id.includes("instagram") ? "instagram" : "facebook", displayName: id, externalAccountId: `external-${id}`, credentialRef: `secret:credential-${id}`, capabilities: ["profile_read", "media_publish"], status: "healthy", lastCheckedAt: createdAt, lastHealthyAt: createdAt, createdBy: owner.id, createdAt, updatedAt: createdAt };
    await accounts.save(account, { id: `audit-${id}`, workspaceId, actorId: owner.id, actorType: "human", action: "test.provider-connected", detail: {}, createdAt }, { save: credential(workspaceId, `credential-${id}`) }, { grant: grantValue });
  }

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceA},'Provider Lifecycle A','provider-lifecycle-a',${createdAt},${createdAt}),(${workspaceB},'Provider Lifecycle B','provider-lifecycle-b',${createdAt},${createdAt}),(${workspaceValidation},'Provider Validation','provider-lifecycle-validation',${createdAt},${createdAt}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandA},${workspaceA},'Provider A','provider-a','English','UTC','active',${owner.id},${createdAt},${createdAt}),(${brandB},${workspaceB},'Provider B','provider-b','English','UTC','active',${owner.id},${createdAt},${createdAt}),(${brandValidation},${workspaceValidation},'Provider Validation','provider-validation','English','UTC','active',${owner.id},${createdAt},${createdAt}) on conflict(id) do nothing`;
    await saveAccount(workspaceA, brandA, "facebook-provider-a", grant(workspaceA, "grant-provider-a", ["pages_show_list"]));
    await saveAccount(workspaceA, brandA, "instagram-provider-a", grant(workspaceA, "grant-provider-a", ["instagram_basic"]));
    await saveAccount(workspaceB, brandB, "facebook-provider-b", grant(workspaceB, "grant-provider-b", ["pages_show_list"]));
    await saveAccount(workspaceValidation, brandValidation, "facebook-provider-validation", { ...grant(workspaceValidation, "grant-provider-validation", ["pages_manage_posts"]), clientId: "meta-app-validation", subjectLookupHmac: "9".repeat(64), nextValidationAt: "2026-09-07T11:00:00.000Z" });
  });

  afterAll(async () => {
    await sql`delete from outbox_events where workspace_id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql`delete from provider_lifecycle_receipts where client_id='meta-app-1'`;
    await sql`delete from provider_data_deletion_requests where client_id='meta-app-1'`;
    await sql`delete from workspace_notifications where workspace_id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql`delete from audit_events where workspace_id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql`delete from connected_accounts where workspace_id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql`delete from provider_grants where workspace_id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql`delete from brands where workspace_id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql`delete from workspaces where id in (${workspaceA},${workspaceB},${workspaceValidation})`;
    await sql.end();
  });

  it("groups one grant over multiple accounts without exposing its lookup key", async () => {
    const listed = await lifecycle.listProviderGrants(workspaceA, brandA);
    expect(listed).toHaveLength(1);
    expect(new Set(listed[0]!.accountIds)).toEqual(new Set(["facebook-provider-a", "instagram-provider-a"]));
    expect(new Set(listed[0]!.grant.scopes)).toEqual(new Set(["pages_show_list", "instagram_basic"]));
    expect(listed[0]!.grant.version).toBe(2);
    expect(listed[0]!.grant.subjectLookupHmac).toBe(subjectLookupHmac);
  });

  it("recovers due grant validation and atomically records healthy and blocked outcomes", async () => {
    await expect(outbox.recoverProviderGrantValidations(["meta"])).resolves.toBeGreaterThanOrEqual(1);
    const messages = (await outbox.list(workspaceValidation)).filter((message) => message.topic === "provider.grant-validation");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toEqual({ workspaceId: workspaceValidation, grantId: "grant-provider-validation", expectedVersion: 1 });

    await expect(lifecycle.recordProviderGrantValidation({ workspaceId: workspaceValidation, grantId: "grant-provider-validation", expectedVersion: 1, outcome: "healthy", checkedAt: "2026-09-07T12:15:00.000Z", nextValidationAt: "2026-09-14T12:15:00.000Z" })).resolves.toBe(true);
    expect((await lifecycle.listProviderGrants(workspaceValidation))[0]!.grant).toMatchObject({ status: "active", version: 2, lastHealthyAt: "2026-09-07T12:15:00.000Z", nextValidationAt: "2026-09-14T12:15:00.000Z" });
    await expect(lifecycle.recordProviderGrantValidation({ workspaceId: workspaceValidation, grantId: "grant-provider-validation", expectedVersion: 1, outcome: "reauthorization_required", checkedAt: "2026-09-07T12:16:00.000Z" })).resolves.toBe(false);

    await expect(lifecycle.recordProviderGrantValidation({ workspaceId: workspaceValidation, grantId: "grant-provider-validation", expectedVersion: 2, outcome: "reauthorization_required", checkedAt: "2026-09-07T12:17:00.000Z", errorCode: "provider_scope_removed", errorSummary: "Meta removed one or more approved permissions." })).resolves.toBe(true);
    expect((await lifecycle.listProviderGrants(workspaceValidation))[0]!.grant).toMatchObject({ status: "reauthorization_required", version: 3, lastErrorCode: "provider_scope_removed" });
    expect(await accounts.get(workspaceValidation, "facebook-provider-validation")).toMatchObject({ status: "disconnected", capabilities: [], lastErrorCode: "provider_scope_removed" });
    const credentials = await sql<{ count: number }[]>`select count(*)::int as count from encrypted_credentials where workspace_id=${workspaceValidation}`;
    expect(credentials[0]?.count).toBe(0);
    const notifications = await sql<{ action_url: string }[]>`select action_url from workspace_notifications where workspace_id=${workspaceValidation}`;
    expect(notifications).toEqual([{ action_url: "/?module=channels&grant=grant-provider-validation" }]);
  });

  it("fans a verified deauthorization across workspaces and is idempotent", async () => {
    const input = { id: "provider-receipt-deauth", clientId: "meta-app-1", lookupKeyVersion: "v2", subjectLookupHmac: "e".repeat(64), lookupCandidates: [{ version: "v2", digest: "e".repeat(64) }, { version: "v1", digest: subjectLookupHmac }], payloadSha256: "b".repeat(64), receivedAt: "2026-09-07T12:05:00.000Z" };
    await expect(lifecycle.receiveMetaDeauthorization(input)).resolves.toEqual({ created: true, matchedGrants: 2, affectedAccounts: 3 });
    await expect(lifecycle.receiveMetaDeauthorization({ ...input, id: "another-id" })).resolves.toEqual({ created: false, matchedGrants: 2, affectedAccounts: 3 });
    expect(await accounts.get(workspaceA, "facebook-provider-a")).toMatchObject({ status: "disconnected", capabilities: [], lastErrorCode: "provider_deauthorized" });
    expect(await accounts.get(workspaceB, "facebook-provider-b")).toMatchObject({ status: "disconnected", capabilities: [], lastErrorCode: "provider_deauthorized" });
    const credentialRows = await sql<{ count: number }[]>`select count(*)::int as count from encrypted_credentials where workspace_id in (${workspaceA},${workspaceB}) and id like 'credential-%'`;
    expect(credentialRows[0]?.count).toBe(0);
  });

  it("creates one recoverable deletion scope per workspace and never stores a raw subject", async () => {
    const result = await lifecycle.receiveMetaDataDeletion({ receiptId: "provider-receipt-deletion", requestId: "provider-deletion-request", clientId: "meta-app-1", lookupKeyVersion: "v2", subjectLookupHmac: "e".repeat(64), lookupCandidates: [{ version: "v2", digest: "e".repeat(64) }, { version: "v1", digest: subjectLookupHmac }], payloadSha256: "c".repeat(64), confirmationNonce: "confirmation-nonce-1234567890", confirmationCodeSha256: "d".repeat(64), receivedAt: "2026-09-07T12:10:00.000Z" });
    expect(result).toMatchObject({ created: true, matchedGrants: 2, affectedAccounts: 3, request: { status: "pending", scopeCount: 2 } });
    const rotatedRetry = await lifecycle.receiveMetaDataDeletion({ receiptId: "provider-receipt-deletion-rotated", requestId: "provider-deletion-request-rotated", clientId: "meta-app-1", lookupKeyVersion: "v3", subjectLookupHmac: "f".repeat(64), lookupCandidates: [{ version: "v3", digest: "f".repeat(64) }, { version: "v2", digest: "e".repeat(64) }, { version: "v1", digest: subjectLookupHmac }], payloadSha256: "f".repeat(64), confirmationNonce: "different-confirmation-nonce", confirmationCodeSha256: "1".repeat(64), receivedAt: "2026-09-07T12:11:00.000Z" });
    expect(rotatedRetry).toMatchObject({ created: false, matchedGrants: 2, affectedAccounts: 3, request: { id: "provider-deletion-request" } });
    await sql`delete from outbox_events where topic='provider.data-deletion' and workspace_id in (${workspaceA},${workspaceB})`;
    await expect(outbox.recoverProviderDataDeletions()).resolves.toBe(2);
    const messages = (await Promise.all([outbox.list(workspaceA), outbox.list(workspaceB)])).flat().filter((message) => message.topic === "provider.data-deletion");
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => !JSON.stringify(message.payload).includes(subjectLookupHmac))).toBe(true);
    const rawSubjectMatches = await sql<{ count: number }[]>`select count(*)::int as count from provider_grants where workspace_id in (${workspaceA},${workspaceB}) and row_to_json(provider_grants)::text like '%998877665544%'`;
    expect(rawSubjectMatches[0]?.count).toBe(0);
    await lifecycle.failDataDeletionScope("provider-deletion-request", workspaceA, "provider_data_deletion_failed", "2026-09-07T12:20:00.000Z");
    expect((await lifecycle.listProviderGrants(workspaceA))[0]!.grant).toMatchObject({ status: "deletion_pending", lastErrorCode: "provider_data_deletion_failed" });
    const needsReview = await sql<{ title: string }[]>`select title from workspace_notifications where workspace_id=${workspaceA} and dedupe_key=${`provider-deletion:provider-deletion-request:${workspaceA}:needs-review`}`;
    expect(needsReview).toEqual([{ title: "Provider data deletion needs review" }]);
  });
});
