import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const maximumBodyBytes = 16 * 1024;
const base64urlPattern = /^[A-Za-z0-9_-]+$/;

export interface VerifiedMetaSignedRequest {
  userId: string;
  payloadSha256: string;
  issuedAt?: number | undefined;
}

function decodeCanonicalBase64url(value: string): Buffer {
  if (!value || !base64urlPattern.test(value) || value.includes("=")) throw new Error("invalid_signed_request");
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== value) throw new Error("invalid_signed_request");
  return decoded;
}

export function verifyMetaSignedRequest(rawBody: Buffer | undefined, contentType: string | undefined, appSecret: string): VerifiedMetaSignedRequest {
  if (!appSecret || !rawBody || rawBody.length === 0 || rawBody.length > maximumBodyBytes) throw new Error("invalid_signed_request");
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType ?? "")) throw new Error("invalid_signed_request");
  let formText: string;
  try { formText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody); }
  catch { throw new Error("invalid_signed_request"); }
  const form = new URLSearchParams(formText);
  if ([...form.keys()].some((key) => key !== "signed_request") || form.getAll("signed_request").length !== 1) throw new Error("invalid_signed_request");
  const signed = form.get("signed_request") ?? "";
  const segments = signed.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) throw new Error("invalid_signed_request");
  const signature = decodeCanonicalBase64url(segments[0]);
  if (signature.length !== 32) throw new Error("invalid_signed_request");
  const expected = createHmac("sha256", appSecret).update(segments[1]).digest();
  if (!timingSafeEqual(signature, expected)) throw new Error("invalid_signed_request");
  let payload: unknown;
  try { payload = JSON.parse(decodeCanonicalBase64url(segments[1]).toString("utf8")); }
  catch { throw new Error("invalid_signed_request"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_signed_request");
  const record = payload as Record<string, unknown>;
  if (String(record.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") throw new Error("invalid_signed_request");
  const rawUserId = record.user_id;
  const userId = typeof rawUserId === "string" ? rawUserId : typeof rawUserId === "number" && Number.isSafeInteger(rawUserId) ? String(rawUserId) : "";
  if (!/^[1-9][0-9]{0,39}$/.test(userId)) throw new Error("invalid_signed_request");
  const issuedAt = record.issued_at;
  if (issuedAt !== undefined && (!Number.isSafeInteger(issuedAt) || Number(issuedAt) <= 0)) throw new Error("invalid_signed_request");
  return { userId, payloadSha256: createHash("sha256").update(rawBody).digest("hex"), ...(issuedAt === undefined ? {} : { issuedAt: Number(issuedAt) }) };
}

