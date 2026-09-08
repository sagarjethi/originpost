import { createHmac, timingSafeEqual } from "node:crypto";

export interface MediaDeliveryGrant {
  version: 1;
  workspaceId: string;
  mediaId: string;
  sha256: string;
  expiresAt: number;
}

function requireSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("MEDIA_DELIVERY_SECRET must contain at least 32 bytes.");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createMediaDeliveryToken(input: Omit<MediaDeliveryGrant, "version">, secret: string, now = Date.now()): string {
  requireSecret(secret);
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Media delivery requires a lowercase SHA-256 hash.");
  if (input.expiresAt <= now || input.expiresAt > now + 7_200_000) throw new Error("Media delivery expiry must be within the next two hours.");
  const payload = Buffer.from(JSON.stringify({ version: 1, ...input } satisfies MediaDeliveryGrant), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyMediaDeliveryToken(token: string, secret: string, now = Date.now()): MediaDeliveryGrant {
  requireSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid media delivery token.");
  const expected = Buffer.from(signature(parts[0], secret));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("Invalid media delivery signature.");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new Error("Invalid media delivery payload."); }
  const grant = value as Partial<MediaDeliveryGrant>;
  if (grant.version !== 1 || typeof grant.workspaceId !== "string" || !grant.workspaceId || typeof grant.mediaId !== "string" || !grant.mediaId || typeof grant.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(grant.sha256) || typeof grant.expiresAt !== "number") throw new Error("Invalid media delivery payload.");
  if (grant.expiresAt <= now) throw new Error("Media delivery token expired.");
  return grant as MediaDeliveryGrant;
}
