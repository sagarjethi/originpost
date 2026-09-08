import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { EncryptedCredential } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";

@Injectable()
export class CredentialVaultService {
  constructor(
    private readonly config: ConfigService,
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
  ) {}

  private key(): Buffer | null {
    const value = this.config.get<string>("CREDENTIAL_ENCRYPTION_KEY")?.trim();
    if (!value) return null;
    const decoded = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  }

  configured(): boolean { return Boolean(this.key()); }

  seal(workspaceId: string, purpose: EncryptedCredential["purpose"], plaintext: string, now = new Date().toISOString()): EncryptedCredential {
    const key = this.key();
    if (!key) throw new ConflictException("Credential encryption is not configured. Set a 32-byte CREDENTIAL_ENCRYPTION_KEY.");
    const id = `credential_${randomUUID()}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${workspaceId}:${purpose}:${id}:v1`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { id, workspaceId, purpose, keyVersion: "v1", algorithm: "aes-256-gcm", iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"), createdAt: now, updatedAt: now };
  }

  async open(workspaceId: string, id: string): Promise<string> {
    const key = this.key();
    if (!key) throw new ConflictException("Credential encryption is not configured.");
    const record = await this.infrastructure.oauthRepository.getCredential(workspaceId, id);
    if (!record) throw new ConflictException("The protected provider credential is missing. Reconnect the account.");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(Buffer.from(`${workspaceId}:${record.purpose}:${record.id}:${record.keyVersion}`));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}
