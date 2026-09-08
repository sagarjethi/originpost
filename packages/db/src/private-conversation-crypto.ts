import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export interface PrivateEnvelope {
  keyVersion: "v1";
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface PrivateConversationKeys {
  encryptionKey: Buffer;
  hashKey: Buffer;
}

export function decodePrivateKey(value: string | Buffer | undefined, minimum = 32): Buffer | null {
  if (Buffer.isBuffer(value)) return value.length >= minimum ? Buffer.from(value) : null;
  const input = value?.trim();
  if (!input) return null;
  const decoded = /^[a-f0-9]{64}$/i.test(input) ? Buffer.from(input, "hex") : Buffer.from(input, "base64");
  return decoded.length >= minimum ? decoded : null;
}

export class PrivateConversationCipher {
  readonly keyVersion = "v1" as const;

  constructor(private readonly keys: PrivateConversationKeys) {
    if (keys.encryptionKey.length !== 32) throw new Error("PRIVATE_MESSAGE_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    if (keys.hashKey.length < 32) throw new Error("PRIVATE_MESSAGE_HASH_KEY must decode to at least 32 bytes.");
  }

  hash(workspaceId: string, accountId: string, kind: string, value: string): string {
    return createHmac("sha256", this.keys.hashKey)
      .update(["originpost.private-message.hash.v1", workspaceId, accountId, kind, value.normalize("NFC")].join("\0"))
      .digest("hex");
  }

  bodyIntegrityKey(body: string): string {
    return createHmac("sha256", this.keys.hashKey).update(body.normalize("NFC")).digest("hex");
  }

  seal(workspaceId: string, purpose: string, id: string, value: unknown): PrivateEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.encryptionKey, iv);
    cipher.setAAD(this.aad(workspaceId, purpose, id));
    const plaintext = typeof value === "string" ? value : JSON.stringify(value);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      keyVersion: this.keyVersion,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  open(workspaceId: string, purpose: string, id: string, envelope: PrivateEnvelope): string {
    if (envelope.algorithm !== "aes-256-gcm" || envelope.keyVersion !== this.keyVersion) throw new Error("The private-message envelope is unsupported.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.keys.encryptionKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(this.aad(workspaceId, purpose, id));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("The private-message envelope could not be opened.");
    }
  }

  openJson<T>(workspaceId: string, purpose: string, id: string, envelope: PrivateEnvelope): T {
    try { return JSON.parse(this.open(workspaceId, purpose, id, envelope)) as T; }
    catch (error) {
      if (error instanceof Error && error.message === "The private-message envelope could not be opened.") throw error;
      throw new Error("The private-message envelope contains invalid JSON.");
    }
  }

  private aad(workspaceId: string, purpose: string, id: string): Buffer {
    return Buffer.from(["originpost.private-message.envelope", workspaceId, purpose, id, this.keyVersion].join(":"));
  }
}
