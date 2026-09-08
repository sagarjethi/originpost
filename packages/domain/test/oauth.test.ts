import { describe, expect, it } from "vitest";
import { InMemoryOAuthRepository, type OAuthConnectionState } from "../src/index.js";

const state: OAuthConnectionState = { id: "oauth-1", workspaceId: "default", brandId: "brand-default", platform: "instagram", actorId: "owner", stateHash: "hash", returnUrl: "http://localhost:3000/", createdAt: "2026-08-29T00:00:00.000Z", expiresAt: "2026-08-29T00:10:00.000Z" };

describe("InMemoryOAuthRepository", () => {
  it("consumes valid state exactly once and rejects expired or cross-provider state", async () => {
    const repository = new InMemoryOAuthRepository();
    await repository.createState(state);
    await expect(repository.consumeState("hash", "youtube", "2026-08-29T00:01:00.000Z")).resolves.toBeNull();
    await expect(repository.consumeState("hash", "instagram", "2026-08-29T00:01:00.000Z")).resolves.toMatchObject({ id: "oauth-1", consumedAt: "2026-08-29T00:01:00.000Z" });
    await expect(repository.consumeState("hash", "instagram", "2026-08-29T00:02:00.000Z")).resolves.toBeNull();
    await repository.createState({ ...state, id: "oauth-2", stateHash: "expired" });
    await expect(repository.consumeState("expired", "instagram", "2026-08-29T00:11:00.000Z")).resolves.toBeNull();
  });

  it("keeps encrypted credentials workspace scoped", async () => {
    const repository = new InMemoryOAuthRepository();
    await repository.saveCredential({ id: "credential-1", workspaceId: "default", purpose: "provider-token", keyVersion: "v1", algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "ciphertext", createdAt: state.createdAt, updatedAt: state.createdAt });
    await expect(repository.hasCredential("default", "credential-1")).resolves.toBe(true);
    await expect(repository.getCredential("other", "credential-1")).resolves.toBeNull();
    await repository.deleteCredential("other", "credential-1");
    await expect(repository.hasCredential("default", "credential-1")).resolves.toBe(true);
    await repository.deleteCredential("default", "credential-1");
    await expect(repository.hasCredential("default", "credential-1")).resolves.toBe(false);
  });
});
