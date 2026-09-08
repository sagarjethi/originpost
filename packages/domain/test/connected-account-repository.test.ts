import type { AuditEvent, ConnectedAccount, EncryptedCredential } from "../src/types.js";
import { InMemoryConnectedAccountRepository, InMemoryOAuthRepository } from "../src/repository.js";
import { describe, expect, it } from "vitest";

function fixture(workspaceId = "one"): ConnectedAccount {
  const now = "2026-08-28T12:00:00.000Z";
  return { id: "account_one", workspaceId, brandId: "brand-one", platform: "instagram", displayName: "Newsroom", externalAccountId: "ig-1", capabilities: [], status: "setup_required", createdBy: "owner", createdAt: now, updatedAt: now };
}

function event(account: ConnectedAccount): AuditEvent {
  return { id: "audit_one", workspaceId: account.workspaceId, actorId: "owner", actorType: "human", action: "channel.account-created", detail: {}, createdAt: account.createdAt };
}

function credential(id: string, purpose: EncryptedCredential["purpose"] = "provider-token"): EncryptedCredential {
  return { id, workspaceId: "one", purpose, keyVersion: "v1", algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "ciphertext", createdAt: "2026-08-28T12:00:00.000Z", updatedAt: "2026-08-28T12:00:00.000Z" };
}

describe("InMemoryConnectedAccountRepository", () => {
  it("keeps reads inside the requested workspace", async () => {
    const repository = new InMemoryConnectedAccountRepository();
    const account = fixture();
    await repository.save(account, event(account));
    expect(await repository.get("one", account.id)).toMatchObject({ id: account.id });
    expect(await repository.get("two", account.id)).toBeNull();
    expect(await repository.list("two")).toEqual([]);
  });

  it("rejects an audit event from another workspace", async () => {
    const repository = new InMemoryConnectedAccountRepository();
    const account = fixture();
    await expect(repository.save(account, { ...event(account), workspaceId: "two" })).rejects.toThrow("same workspace");
  });

  it("atomically consumes an OAuth selection exactly once under concurrent completion", async () => {
    const oauth = new InMemoryOAuthRepository(); const repository = new InMemoryConnectedAccountRepository(oauth); const account = fixture();
    await oauth.saveCredential(credential("selection", "provider-discovery"));
    const entry = { account, event: event(account), credentialChange: { save: credential("provider-token") } };
    const results = await Promise.all([repository.completeOAuthSelection("one", "selection", [entry]), repository.completeOAuthSelection("one", "selection", [entry])]);
    expect(results.sort()).toEqual([false, true]);
    expect(await repository.list("one")).toEqual([account]);
    expect(await oauth.hasCredential("one", "selection")).toBe(false);
  });

  it("restores the selection and all account writes when a multi-account completion fails", async () => {
    class FailingOAuthRepository extends InMemoryOAuthRepository { override async saveCredential(value: EncryptedCredential) { if (value.id === "provider-token-bad") throw new Error("injected credential failure"); return super.saveCredential(value); } }
    const oauth = new FailingOAuthRepository(); const repository = new InMemoryConnectedAccountRepository(oauth); await oauth.saveCredential(credential("selection", "provider-discovery"));
    const first = fixture(); const second = { ...fixture(), id: "account_two", externalAccountId: "ig-2" };
    await expect(repository.completeOAuthSelection("one", "selection", [
      { account: first, event: event(first), credentialChange: { save: credential("provider-token-good") } },
      { account: second, event: { ...event(second), id: "audit_two" }, credentialChange: { save: credential("provider-token-bad") } },
    ])).rejects.toThrow("injected credential failure");
    expect(await repository.list("one")).toEqual([]);
    expect(await oauth.hasCredential("one", "provider-token-good")).toBe(false);
    expect(await oauth.hasCredential("one", "selection")).toBe(true);
  });
});
