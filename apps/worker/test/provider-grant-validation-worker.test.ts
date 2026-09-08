import { randomBytes } from "node:crypto";
import { providerLookupHmac, sealEncryptedCredential, type ProviderLookupKeyring } from "@originpost/connectors";
import {
  InMemoryConnectedAccountRepository,
  InMemoryNotificationRepository,
  InMemoryOAuthRepository,
  type ConnectedAccount,
  type ProviderGrant,
} from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { processProviderGrantValidation } from "../src/provider-grant-validation-worker.js";

const workspaceId = "workspace-provider-validation";
const brandId = "brand-provider-validation";
const now = "2026-09-07T12:00:00.000Z";

async function setup(
  provider: "meta" | "google",
  accountsToCreate: Array<{ id: string; platform: "instagram" | "facebook" | "youtube"; externalAccountId: string }>,
) {
  const key = randomBytes(32);
  const providerLookupKeyring: ProviderLookupKeyring = { activeVersion: "v1", keys: new Map([["v1", randomBytes(32)]]) };
  const oauth = new InMemoryOAuthRepository();
  const notifications = new InMemoryNotificationRepository();
  const accounts = new InMemoryConnectedAccountRepository(oauth, notifications);
  const clientId = provider === "google" ? "google-client" : "meta-client";
  const providerSubject = provider === "google" ? "google-refresh" : "meta-user-1";
  const lookup = providerLookupHmac(providerLookupKeyring, provider, clientId, providerSubject);
  const grant: ProviderGrant = {
    id: `grant-${provider}`,
    workspaceId,
    provider,
    authorizationKind: provider === "google" ? "google_oauth" : "facebook_login",
    clientId,
    lookupKeyVersion: lookup.version,
    ...(provider === "google" ? { refreshTokenLookupHmac: lookup.digest } : { subjectLookupHmac: lookup.digest }),
    status: "active",
    scopes: provider === "google" ? ["https://www.googleapis.com/auth/youtube.upload"] : ["pages_manage_posts"],
    version: 1,
    issuedAt: now,
    nextValidationAt: now,
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  };
  for (const [index, input] of accountsToCreate.entries()) {
    const credentialId = `credential-${input.id}`;
    const account: ConnectedAccount = {
      ...input,
      workspaceId,
      brandId,
      displayName: input.id,
      credentialRef: `secret:${credentialId}`,
      capabilities: input.platform === "youtube" ? ["channel_read", "video_upload"] : ["profile_read", "media_publish"],
      status: "healthy",
      createdBy: "owner",
      createdAt: now,
      updatedAt: now,
    };
    const credential = sealEncryptedCredential({
      workspaceId,
      purpose: "provider-token",
      plaintext: JSON.stringify({
        provider: input.platform,
        externalAccountId: input.externalAccountId,
        accessToken: `access-${input.id}`,
        ...(input.platform === "youtube" ? { refreshToken: providerSubject } : {}),
        ...(input.platform === "instagram" ? { connectionMode: "facebook_login" } : {}),
      }),
      key,
      now,
      id: credentialId,
    });
    await oauth.saveCredential(credential);
    await accounts.save(
      account,
      { id: `audit-seed-${index}`, workspaceId, actorId: "owner", actorType: "human", action: "test.seed", detail: {}, createdAt: now },
      undefined,
      { grant },
    );
  }
  const current = (await accounts.listProviderGrants(workspaceId))[0]!;
  return { key, providerLookupKeyring, oauth, notifications, accounts, grant: current.grant, accountIds: current.accountIds };
}

describe("provider grant validation", () => {
  it("validates every account linked to a shared Meta grant and schedules its next check", async () => {
    const deps = await setup("meta", [
      { id: "page", platform: "facebook", externalAccountId: "page-1" },
      { id: "instagram", platform: "instagram", externalAccountId: "ig-1" },
    ]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/debug_token")) return new Response(JSON.stringify({ data: { app_id: "meta-client", user_id: "meta-user-1", is_valid: true, expires_at: 0, data_access_expires_at: 0, scopes: ["pages_manage_posts"] } }), { status: 200 });
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return new Response(JSON.stringify({ id, ...(id === "page-1" ? { tasks: ["CREATE_CONTENT", "ANALYZE"] } : {}) }), { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(processProviderGrantValidation(
      { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version },
      { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: deps.providerLookupKeyring, metaAppId: "meta-client", metaAppSecret: "meta-secret", metaApiVersion: "v24.0", fetch, now: () => now },
    )).resolves.toEqual({ skipped: false, validatedAccounts: 2 });

    expect(fetch).toHaveBeenCalledTimes(4);
    const updated = (await deps.accounts.listProviderGrants(workspaceId))[0]!.grant;
    expect(updated).toMatchObject({ status: "active", version: deps.grant.version + 1, lastCheckedAt: now, lastHealthyAt: now, nextValidationAt: "2026-09-14T12:00:00.000Z" });
    await expect(deps.notifications.list(workspaceId)).resolves.toEqual([]);
  });

  it("keeps every sibling credential intact when one Meta token response needs review", async () => {
    const deps = await setup("meta", [
      { id: "page", platform: "facebook", externalAccountId: "page-1" },
      { id: "instagram", platform: "instagram", externalAccountId: "ig-1" },
    ]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { app_id: "meta-client", user_id: "meta-user-1", is_valid: false } }), { status: 200 })) as typeof globalThis.fetch;

    await expect(processProviderGrantValidation(
      { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version },
      { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: deps.providerLookupKeyring, metaAppId: "meta-client", metaAppSecret: "meta-secret", metaApiVersion: "v24.0", fetch, now: () => now },
    )).resolves.toEqual({ skipped: false, validatedAccounts: 0 });

    for (const accountId of deps.accountIds) {
      expect(await deps.accounts.get(workspaceId, accountId)).toMatchObject({ status: "healthy" });
      expect((await deps.accounts.get(workspaceId, accountId))?.credentialRef).toBe(`secret:credential-${accountId}`);
      await expect(deps.oauth.getCredential(workspaceId, `credential-${accountId}`)).resolves.not.toBeNull();
    }
    expect((await deps.accounts.listProviderGrants(workspaceId))[0]!.grant).toMatchObject({ status: "refresh_failed", lastErrorCode: "provider_validation_review_required" });
    await expect(deps.notifications.list(workspaceId)).resolves.toHaveLength(1);
  });

  it("retries a temporary outage before recording a bounded transient failure", async () => {
    const deps = await setup("google", [{ id: "youtube", platform: "youtube", externalAccountId: "channel-1" }]);
    const fetch = vi.fn(async () => new Response("{}", { status: 503 })) as typeof globalThis.fetch;
    const job = { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version };
    const workerDeps = { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: deps.providerLookupKeyring, googleClientId: "google-client", googleClientSecret: "google-secret", fetch, now: () => now };

    await expect(processProviderGrantValidation(job, workerDeps, 1, 5)).rejects.toMatchObject({ retryable: true, code: "provider_validation_unavailable" });
    expect((await deps.accounts.listProviderGrants(workspaceId))[0]!.grant).toMatchObject({ status: "active", version: deps.grant.version });
    await expect(processProviderGrantValidation(job, workerDeps, 5, 5)).resolves.toEqual({ skipped: false, validatedAccounts: 0 });
    expect((await deps.accounts.listProviderGrants(workspaceId))[0]!.grant).toMatchObject({ status: "refresh_failed", version: deps.grant.version + 1, nextValidationAt: "2026-09-07T13:00:00.000Z" });
    expect((await deps.accounts.get(workspaceId, "youtube"))?.credentialRef).toBe("secret:credential-youtube");
    await expect(deps.notifications.list(workspaceId)).resolves.toEqual([]);
  });

  it("validates the exact YouTube channel returned for the Google grant", async () => {
    const deps = await setup("google", [{ id: "youtube", platform: "youtube", externalAccountId: "channel-1" }]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.origin === "https://oauth2.googleapis.com") return new Response(JSON.stringify({ access_token: "fresh-google-access", expires_in: 3600 }), { status: 200 });
      expect(url.searchParams.get("mine")).toBe("true");
      expect(url.searchParams.get("part")).toBe("id");
      expect((fetch.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.headers).toEqual({ authorization: "Bearer fresh-google-access" });
      return new Response(JSON.stringify({ items: [{ id: "channel-1" }] }), { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(processProviderGrantValidation(
      { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version },
      { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: deps.providerLookupKeyring, googleClientId: "google-client", googleClientSecret: "google-secret", fetch, now: () => now },
    )).resolves.toEqual({ skipped: false, validatedAccounts: 1 });
    expect((await deps.accounts.listProviderGrants(workspaceId))[0]!.grant).toMatchObject({ status: "active", nextValidationAt: "2026-10-07T12:00:00.000Z" });
  });

  it("blocks the Google grant only after the refresh endpoint returns invalid_grant", async () => {
    const deps = await setup("google", [{ id: "youtube", platform: "youtube", externalAccountId: "channel-1" }]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof globalThis.fetch;
    await expect(processProviderGrantValidation(
      { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version },
      { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: deps.providerLookupKeyring, googleClientId: "google-client", googleClientSecret: "google-secret", fetch, now: () => now },
    )).resolves.toEqual({ skipped: false, validatedAccounts: 0 });
    expect((await deps.accounts.listProviderGrants(workspaceId))[0]!.grant).toMatchObject({ status: "reauthorization_required", lastErrorCode: "provider_grant_revoked" });
    expect(await deps.accounts.get(workspaceId, "youtube")).toMatchObject({ status: "disconnected", capabilities: [] });
    await expect(deps.oauth.getCredential(workspaceId, "credential-youtube")).resolves.toBeNull();
  });

  it("keeps Google credentials intact when the protected refresh-grant identity does not match", async () => {
    const deps = await setup("google", [{ id: "youtube", platform: "youtube", externalAccountId: "channel-1" }]);
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const wrongKeyring: ProviderLookupKeyring = { activeVersion: "v1", keys: new Map([["v1", randomBytes(32)]]) };
    await expect(processProviderGrantValidation(
      { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version },
      { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: wrongKeyring, googleClientId: "google-client", googleClientSecret: "google-secret", fetch, now: () => now },
    )).resolves.toEqual({ skipped: false, validatedAccounts: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect((await deps.accounts.listProviderGrants(workspaceId))[0]!.grant).toMatchObject({ status: "refresh_failed", lastErrorCode: "provider_grant_identity_mismatch" });
    expect((await deps.accounts.get(workspaceId, "youtube"))?.credentialRef).toBe("secret:credential-youtube");
  });

  it("fences stale work before decrypting or contacting a provider", async () => {
    const deps = await setup("google", [{ id: "youtube", platform: "youtube", externalAccountId: "channel-1" }]);
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(processProviderGrantValidation(
      { workspaceId, grantId: deps.grant.id, expectedVersion: deps.grant.version - 1 },
      { lifecycle: deps.accounts, accounts: deps.accounts, oauth: deps.oauth, credentialEncryptionKey: deps.key, providerLookupKeyring: deps.providerLookupKeyring, googleClientId: "google-client", googleClientSecret: "google-secret", fetch },
    )).resolves.toEqual({ skipped: true, reason: "stale-validation-job" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
