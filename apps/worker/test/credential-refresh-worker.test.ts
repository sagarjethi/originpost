import { randomBytes } from "node:crypto";
import { openEncryptedCredential, sealEncryptedCredential } from "@originpost/connectors";
import { InMemoryConnectedAccountRepository, InMemoryNotificationRepository, InMemoryOAuthRepository, type ConnectedAccount } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { CredentialRefreshError, processCredentialRefreshJob, type CredentialRefreshJob } from "../src/credential-refresh-worker.js";

const workspaceId = "workspace-refresh";
const brandId = "brand-refresh";
const now = "2026-09-07T12:00:00.000Z";
const oldExpiry = "2026-09-07T12:10:00.000Z";

async function setup(platform: "youtube" | "instagram", overrides: Partial<Record<string, unknown>> = {}) {
  const key = randomBytes(32);
  const oauth = new InMemoryOAuthRepository();
  const notifications = new InMemoryNotificationRepository();
  const accounts = new InMemoryConnectedAccountRepository(oauth, notifications);
  const account: ConnectedAccount = {
    id: `account-${platform}`,
    workspaceId,
    brandId,
    platform,
    displayName: platform === "youtube" ? "OriginPost Channel" : "@originpost",
    externalAccountId: `external-${platform}`,
    credentialRef: "secret:credential-old",
    capabilities: platform === "youtube" ? ["channel_read", "video_upload"] : ["profile_read", "media_publish"],
    status: "healthy",
    expiresAt: oldExpiry,
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  };
  const payload = platform === "youtube"
    ? { provider: "youtube", externalAccountId: account.externalAccountId, accessToken: "youtube-old-access-secret", refreshToken: "youtube-refresh-secret", tokenType: "bearer", scope: "youtube.upload", issuedAt: now, expiresAt: oldExpiry, ...overrides }
    : { provider: "instagram", externalAccountId: account.externalAccountId, accessToken: "instagram-old-access-secret", connectionMode: "instagram_login", tokenType: "bearer", scope: "instagram_business_basic", issuedAt: now, expiresAt: oldExpiry, ...overrides };
  const secret = sealEncryptedCredential({ workspaceId, purpose: "provider-token", plaintext: JSON.stringify(payload), key, now, id: "credential-old" });
  await oauth.saveCredential(secret);
  await accounts.save(account, { id: "audit-seed", workspaceId, actorId: "owner", actorType: "human", action: "test.seed", detail: {}, createdAt: now });
  const job: CredentialRefreshJob = { workspaceId, accountId: account.id, platform, expectedExpiresAt: oldExpiry, expectedCredentialRef: account.credentialRef! };
  return { key, oauth, accounts, notifications, account, job };
}

describe("automatic provider credential refresh", () => {
  it("persists a rotated YouTube access token and preserves an omitted refresh token", async () => {
    const deps = await setup("youtube");
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain("refresh_token=youtube-refresh-secret");
      return new Response(JSON.stringify({ access_token: "youtube-new-access-secret", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, googleClientId: "client", googleClientSecret: "client-secret", fetch, now: () => now })).resolves.toEqual({ skipped: false, expiresAt: "2026-09-07T13:00:00.000Z" });
    const updated = await deps.accounts.get(workspaceId, deps.account.id);
    expect(updated).toMatchObject({ status: "healthy", expiresAt: "2026-09-07T13:00:00.000Z", lastHealthyAt: now });
    expect(updated?.credentialRef).not.toBe(deps.account.credentialRef);
    await expect(deps.oauth.getCredential(workspaceId, "credential-old")).resolves.toBeNull();
    const rotated = await deps.oauth.getCredential(workspaceId, updated!.credentialRef!.slice(7));
    const opened = JSON.parse(openEncryptedCredential(rotated!, deps.key)) as Record<string, unknown>;
    expect(opened).toMatchObject({ accessToken: "youtube-new-access-secret", refreshToken: "youtube-refresh-secret", expiresAt: "2026-09-07T13:00:00.000Z" });
  });

  it("renews direct Instagram access through the Instagram refresh endpoint", async () => {
    const deps = await setup("instagram");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
      expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
      return new Response(JSON.stringify({ access_token: "instagram-new-access-secret", token_type: "bearer", expires_in: 5_184_000 }), { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, fetch, now: () => now })).resolves.toMatchObject({ skipped: false });
    expect(await deps.accounts.get(workspaceId, deps.account.id)).toMatchObject({ status: "healthy", expiresAt: "2026-11-06T12:00:00.000Z" });
  });

  it("fences a stale job before reading or sending credentials", async () => {
    const deps = await setup("youtube");
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(processCredentialRefreshJob({ ...deps.job, expectedExpiresAt: "2026-09-07T12:09:00.000Z" }, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, googleClientId: "client", googleClientSecret: "secret", fetch })).resolves.toEqual({ skipped: true, reason: "stale-refresh-job" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discards an in-flight success when the account is disconnected", async () => {
    const deps = await setup("youtube");
    const fetch = vi.fn(async () => {
      const current = (await deps.accounts.get(workspaceId, deps.account.id))!;
      await deps.accounts.save({ ...current, status: "disconnected", credentialRef: undefined, expiresAt: undefined, updatedAt: "2026-09-07T12:00:01.000Z" }, { id: "audit-disconnect", workspaceId, actorId: "owner", actorType: "human", action: "channel.disconnected", detail: {}, createdAt: "2026-09-07T12:00:01.000Z" }, { deleteId: "credential-old" });
      return new Response(JSON.stringify({ access_token: "must-not-be-committed", expires_in: 3600 }), { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, googleClientId: "client", googleClientSecret: "secret", fetch, now: () => now })).resolves.toEqual({ skipped: true, reason: "stale-refresh-result" });
    expect(await deps.accounts.get(workspaceId, deps.account.id)).toMatchObject({ status: "disconnected" });
    expect((await deps.accounts.get(workspaceId, deps.account.id))?.credentialRef).toBeUndefined();
    await expect(deps.oauth.getCredential(workspaceId, "credential-old")).resolves.toBeNull();
  });

  it("does not overwrite a reconnect that wins during an in-flight provider failure", async () => {
    const deps = await setup("instagram");
    const fetch = vi.fn(async () => {
      const current = (await deps.accounts.get(workspaceId, deps.account.id))!;
      await deps.accounts.save({ ...current, credentialRef: "secret:credential-reconnected", expiresAt: "2026-11-06T12:00:01.000Z", status: "healthy", updatedAt: "2026-09-07T12:00:01.000Z" }, { id: "audit-reconnect", workspaceId, actorId: "owner", actorType: "human", action: "channel.oauth-reconnected", detail: {}, createdAt: "2026-09-07T12:00:01.000Z" });
      return new Response("{}", { status: 400 });
    }) as typeof globalThis.fetch;
    await expect(processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, fetch, now: () => now })).resolves.toEqual({ skipped: true, reason: "stale-refresh-result" });
    expect(await deps.accounts.get(workspaceId, deps.account.id)).toMatchObject({ credentialRef: "secret:credential-reconnected", expiresAt: "2026-11-06T12:00:01.000Z", status: "healthy" });
    await expect(deps.notifications.list(workspaceId)).resolves.toEqual([]);
  });

  it("preserves unrelated account fields changed while renewal is in flight", async () => {
    const deps = await setup("youtube");
    const fetch = vi.fn(async () => {
      const current = (await deps.accounts.get(workspaceId, deps.account.id))!;
      await deps.accounts.save({ ...current, displayName: "Renamed channel", capabilities: ["channel_read"], updatedAt: "2026-09-07T12:00:01.000Z" }, { id: "audit-account-metadata", workspaceId, actorId: "owner", actorType: "human", action: "channel.metadata-updated", detail: {}, createdAt: "2026-09-07T12:00:01.000Z" });
      return new Response(JSON.stringify({ access_token: "youtube-new-access-secret", expires_in: 3600 }), { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, googleClientId: "client", googleClientSecret: "secret", fetch, now: () => "2026-09-07T12:00:02.000Z" })).resolves.toMatchObject({ skipped: false });
    expect(await deps.accounts.get(workspaceId, deps.account.id)).toMatchObject({ displayName: "Renamed channel", capabilities: ["channel_read"], status: "healthy" });
  });

  it("commits only one rotation when two refresh workers race", async () => {
    const deps = await setup("youtube");
    let calls = 0;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: `youtube-race-${++calls}`, expires_in: 3600 }), { status: 200 })) as typeof globalThis.fetch;
    const workerDeps = { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, googleClientId: "client", googleClientSecret: "secret", fetch, now: () => now };
    const results = await Promise.all([processCredentialRefreshJob(deps.job, workerDeps), processCredentialRefreshJob(deps.job, workerDeps)]);
    expect(results.filter((result) => !result.skipped)).toHaveLength(1);
    expect(results.filter((result) => result.reason === "stale-refresh-result")).toHaveLength(1);
    const current = (await deps.accounts.get(workspaceId, deps.account.id))!;
    await expect(deps.oauth.getCredential(workspaceId, current.credentialRef!.slice(7))).resolves.not.toBeNull();
    await expect(deps.oauth.getCredential(workspaceId, "credential-old")).resolves.toBeNull();
  });

  it("keeps a retryable provider outage in expiring state without notifying early", async () => {
    const deps = await setup("youtube");
    const fetch = vi.fn(async () => new Response("{}", { status: 503 })) as typeof globalThis.fetch;
    const promise = processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, googleClientId: "client", googleClientSecret: "secret", fetch, now: () => now }, 1, 5);
    await expect(promise).rejects.toMatchObject({ retryable: true });
    expect(await deps.accounts.get(workspaceId, deps.account.id)).toMatchObject({ status: "expiring", lastErrorSummary: "YouTube access renewal will retry automatically." });
    await expect(deps.notifications.list(workspaceId)).resolves.toEqual([]);
  });

  it("moves a terminal rejection to action-needed state without leaking provider secrets", async () => {
    const deps = await setup("instagram");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "instagram-old-access-secret" } }), { status: 400 })) as typeof globalThis.fetch;
    let thrown: unknown;
    try { await processCredentialRefreshJob(deps.job, { accounts: deps.accounts, oauth: deps.oauth, notifications: deps.notifications, credentialEncryptionKey: deps.key, fetch, now: () => now }, 1, 5); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(CredentialRefreshError);
    expect(String(thrown)).not.toContain("instagram-old-access-secret");
    const updated = await deps.accounts.get(workspaceId, deps.account.id);
    expect(updated).toMatchObject({ status: "refresh_failed", lastErrorSummary: "Instagram access could not be renewed. Reconnect the account." });
    expect(JSON.stringify(updated)).not.toContain("instagram-old-access-secret");
    const notifications = await deps.notifications.list(workspaceId);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toContain("instagram-old-access-secret");
  });
});
