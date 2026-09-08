import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function aad(workspaceId: string, targetId: string): Buffer {
  return Buffer.from(`originpost:youtube-upload-session:${workspaceId}:${targetId}`, "utf8");
}

export function sealProviderSessionUri(value: string, key: Buffer, workspaceId: string, targetId: string): string {
  if (key.length !== 32) throw new Error("Provider operation encryption requires a 32-byte key.");
  if (!value.startsWith("https://")) throw new Error("Only secure provider upload sessions can be stored.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(workspaceId, targetId));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function openProviderSessionUri(value: string, key: Buffer, workspaceId: string, targetId: string): string {
  if (key.length !== 32) throw new Error("Provider operation encryption requires a 32-byte key.");
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) throw new Error("The saved provider upload session is invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(aad(workspaceId, targetId));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
    if (!clear.startsWith("https://")) throw new Error("invalid session scheme");
    return clear;
  } catch {
    throw new Error("The saved provider upload session could not be opened.");
  }
}
