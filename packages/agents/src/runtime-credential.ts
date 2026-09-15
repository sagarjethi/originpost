import { createDecipheriv } from "node:crypto";
export function openAgentRuntimeCredential(
  workspaceId: string,
  profileId: string,
  credential: { iv: string; authTag: string; ciphertext: string },
  key: Buffer,
): string {
  if (key.length !== 32) throw new Error("Invalid runtime encryption key.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(credential.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`${workspaceId}:${profileId}:agent-runtime:v1`));
  decipher.setAuthTag(Buffer.from(credential.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(credential.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
