import { type Actor, type ConnectedAccount } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresConnectedAccountRepository } from "../src/postgres-connected-account-repository.js";
import { PostgresOutboxRepository } from "../src/postgres-outbox-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-credential-refresh-integration";
const brandId = "brand-credential-refresh-integration";
const owner: Actor = { id: "credential-refresh-owner", name: "Credential Refresh Owner", role: "owner" };

suite("Postgres credential refresh recovery", () => {
  const sql = postgres(databaseUrl!);
  const accounts = new PostgresConnectedAccountRepository(sql);
  const outbox = new PostgresOutboxRepository(sql);
  const createdAt = new Date().toISOString();

  async function saveAccount(id: string, platform: ConnectedAccount["platform"], expiresAt: string, status: ConnectedAccount["status"] = "healthy") {
    const account: ConnectedAccount = { id, workspaceId, brandId, platform, displayName: id, externalAccountId: `external-${id}`, credentialRef: `secret:credential-${id}`, capabilities: platform === "youtube" ? ["channel_read", "video_upload"] : platform === "facebook" ? ["page_read", "media_publish"] : ["profile_read", "media_publish"], status, expiresAt, lastHealthyAt: platform === "instagram" ? new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString() : createdAt, createdBy: owner.id, createdAt, updatedAt: createdAt };
    await accounts.save(account, { id: `audit-${id}-${Date.now()}`, workspaceId, actorId: owner.id, actorType: "human", action: "test.account-saved", detail: {}, createdAt: new Date().toISOString() });
    return account;
  }

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Credential Refresh Integration','credential-refresh-integration',${createdAt},${createdAt}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Credential Refresh Brand','credential-refresh-brand','English','UTC','active',${owner.id},${createdAt},${createdAt}) on conflict(id) do nothing`;
    await saveAccount("youtube-due", "youtube", new Date(Date.now() + 10 * 60_000).toISOString());
    await saveAccount("instagram-due", "instagram", new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString());
    await saveAccount("youtube-future", "youtube", new Date(Date.now() + 60 * 60_000).toISOString());
    await saveAccount("youtube-failed", "youtube", new Date(Date.now() + 5 * 60_000).toISOString(), "refresh_failed");
    await saveAccount("facebook-due", "facebook", new Date(Date.now() + 5 * 60_000).toISOString());
  });

  afterAll(async () => {
    await sql`delete from outbox_events where workspace_id=${workspaceId}`;
    await sql`delete from audit_events where workspace_id=${workspaceId}`;
    await sql`delete from connected_accounts where workspace_id=${workspaceId}`;
    await sql`delete from brands where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("enqueues only due managed platforms and deduplicates the exact credential generation", async () => {
    await expect(outbox.recoverCredentialRefreshes(["instagram", "youtube"])).resolves.toBe(2);
    const messages = await outbox.list(workspaceId);
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.payload.accountId))).toEqual(new Set(["youtube-due", "instagram-due"]));
    for (const message of messages) {
      expect(message).toMatchObject({ topic: "channel.credential-refresh", status: "pending", attempts: 0 });
      expect(message.payload).toMatchObject({ workspaceId, expectedCredentialRef: `secret:credential-${message.payload.accountId}` });
      expect(Date.parse(String(message.payload.expectedExpiresAt))).toBeGreaterThan(Date.now());
    }
    await expect(outbox.recoverCredentialRefreshes(["instagram", "youtube"])).resolves.toBe(0);
  });

  it("creates a new command after a successful rotation changes the expiry generation", async () => {
    const current = (await accounts.get(workspaceId, "youtube-due"))!;
    const rotated = { ...current, credentialRef: "secret:credential-youtube-rotated", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), updatedAt: new Date().toISOString() };
    await accounts.save(rotated, { id: `audit-youtube-rotated-${Date.now()}`, workspaceId, actorId: "originpost-worker", actorType: "system", action: "channel.oauth-refreshed", detail: {}, createdAt: new Date().toISOString() });
    await expect(outbox.recoverCredentialRefreshes(["youtube"])).resolves.toBe(1);
    const messages = await outbox.list(workspaceId);
    expect(messages.filter((message) => message.payload.accountId === "youtube-due")).toHaveLength(2);
  });

  it("never lets a stale automatic result win over a concurrent reconnect", async () => {
    const current = (await accounts.get(workspaceId, "instagram-due"))!;
    const automatic = { ...current, credentialRef: "secret:credential-instagram-automatic", expiresAt: "2026-11-06T12:00:00.000Z", updatedAt: "2026-09-07T12:00:00.000Z" };
    const reconnected = { ...current, credentialRef: "secret:credential-instagram-reconnected", expiresAt: "2026-11-06T12:00:01.000Z", updatedAt: "2026-09-07T12:00:01.000Z" };
    const [automaticSaved] = await Promise.all([
      accounts.saveCredentialRefreshResult(automatic, { id: "audit-instagram-automatic", workspaceId, actorId: "originpost-worker", actorType: "system", action: "channel.oauth-refreshed", detail: {}, createdAt: "2026-09-07T12:00:00.000Z" }, { expectedCredentialRef: current.credentialRef!, expectedExpiresAt: current.expiresAt! }),
      accounts.save(reconnected, { id: "audit-instagram-reconnected", workspaceId, actorId: owner.id, actorType: "human", action: "channel.oauth-reconnected", detail: {}, createdAt: "2026-09-07T12:00:01.000Z" }),
    ]);
    expect(typeof automaticSaved).toBe("boolean");
    expect(await accounts.get(workspaceId, current.id)).toMatchObject({ credentialRef: "secret:credential-instagram-reconnected", expiresAt: "2026-11-06T12:00:01.000Z" });
  });
});
