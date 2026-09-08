import { ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AutomationSecretEnvelope } from "@originpost/domain";

@Injectable()
export class AutomationSecretVaultService {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const value = this.config.get<string>("CREDENTIAL_ENCRYPTION_KEY")?.trim() ?? "";
    const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
    if (key.length !== 32) throw new ConflictException("Set a 32-byte CREDENTIAL_ENCRYPTION_KEY before creating webhook subscriptions.");
    return key;
  }

  seal(workspaceId: string, subscriptionId: string, plaintext: string): AutomationSecretEnvelope {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(`${workspaceId}:automation-webhook:${subscriptionId}:v1`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { keyVersion: "v1", algorithm: "aes-256-gcm", iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  open(workspaceId: string, subscriptionId: string, envelope: AutomationSecretEnvelope): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(`${workspaceId}:automation-webhook:${subscriptionId}:${envelope.keyVersion}`));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new ConflictException("The webhook signing secret cannot be opened. Rotate the subscription.");
    }
  }
}
