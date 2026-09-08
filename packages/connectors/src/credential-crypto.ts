import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { EncryptedCredential } from "@originpost/domain";

export function decodeCredentialEncryptionKey(value: string | undefined): Buffer | null {
  const input = value?.trim();
  if (!input) return null;
  const decoded = /^[a-f0-9]{64}$/i.test(input) ? Buffer.from(input, "hex") : Buffer.from(input, "base64");
  return decoded.length === 32 ? decoded : null;
}

export function openEncryptedCredential(record: EncryptedCredential, key: Buffer): string {
  if (record.algorithm !== "aes-256-gcm" || key.length !== 32) throw new Error("The protected provider credential cannot be opened.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(`${record.workspaceId}:${record.purpose}:${record.id}:${record.keyVersion}`));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("The protected provider credential cannot be opened.");
  }
}

export function sealEncryptedCredential(input: {
  workspaceId: string;
  purpose: EncryptedCredential["purpose"];
  plaintext: string;
  key: Buffer;
  now?: string;
  id?: string;
  keyVersion?: string;
}): EncryptedCredential {
  if (input.key.length !== 32) throw new Error("The protected provider credential cannot be sealed.");
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? `credential_${randomUUID()}`;
  const keyVersion = input.keyVersion ?? "v1";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(`${input.workspaceId}:${input.purpose}:${id}:${keyVersion}`));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return {
    id,
    workspaceId: input.workspaceId,
    purpose: input.purpose,
    keyVersion,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: now,
    updatedAt: now,
  };
}
