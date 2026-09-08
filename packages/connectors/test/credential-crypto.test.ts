import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EncryptedCredential } from "@originpost/domain";
import { decodeCredentialEncryptionKey, openEncryptedCredential, sealEncryptedCredential } from "../src/index.js";

function seal(plaintext: string, key: Buffer): EncryptedCredential {
  const record = { id: "credential-1", workspaceId: "workspace-1", purpose: "provider-token" as const, keyVersion: "v1", algorithm: "aes-256-gcm" as const, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${record.workspaceId}:${record.purpose}:${record.id}:${record.keyVersion}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ...record, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

describe("provider credential crypto", () => {
  it("opens the workspace-bound AES-GCM record", () => {
    const key = randomBytes(32);
    const plaintext = JSON.stringify({ accessToken: "server-only-token" });
    expect(openEncryptedCredential(seal(plaintext, key), key)).toBe(plaintext);
    expect(decodeCredentialEncryptionKey(key.toString("base64"))).toEqual(key);
  });

  it("returns a safe error and never leaks plaintext on authentication failure", () => {
    const record = seal("secret-token-must-not-leak", randomBytes(32));
    expect(() => openEncryptedCredential(record, randomBytes(32))).toThrow("cannot be opened");
    try { openEncryptedCredential(record, randomBytes(32)); } catch (error) { expect(String(error)).not.toContain("secret-token-must-not-leak"); }
  });

  it("seals a new workspace-bound credential that can be opened", () => {
    const key = randomBytes(32);
    const record = sealEncryptedCredential({ workspaceId: "workspace-1", purpose: "provider-token", plaintext: "rotated-secret", key, now: "2026-09-07T00:00:00.000Z", id: "credential-rotated" });
    expect(record).toMatchObject({ id: "credential-rotated", workspaceId: "workspace-1", purpose: "provider-token", keyVersion: "v1", algorithm: "aes-256-gcm" });
    expect(openEncryptedCredential(record, key)).toBe("rotated-secret");
  });
});
