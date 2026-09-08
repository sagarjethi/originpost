import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignedRequest } from "./meta-signed-request.js";

const secret = "meta-app-secret-for-tests";

function signedBody(payload: Record<string, unknown>, signatureSecret = secret): Buffer {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signatureSecret).update(encoded).digest("base64url");
  return Buffer.from(new URLSearchParams({ signed_request: `${signature}.${encoded}` }).toString());
}

describe("Meta signed request verification", () => {
  it("accepts one canonical, correctly signed app-user payload", () => {
    const body = signedBody({ algorithm: "HMAC-SHA256", user_id: "123456789", issued_at: 1_787_000_000 });
    expect(verifyMetaSignedRequest(body, "application/x-www-form-urlencoded; charset=utf-8", secret)).toMatchObject({ userId: "123456789", issuedAt: 1_787_000_000 });
  });

  it.each([
    ["wrong signature", signedBody({ algorithm: "HMAC-SHA256", user_id: "123" }, "wrong")],
    ["wrong algorithm", signedBody({ algorithm: "none", user_id: "123" })],
    ["missing subject", signedBody({ algorithm: "HMAC-SHA256" })],
    ["extra field", Buffer.from(`${signedBody({ algorithm: "HMAC-SHA256", user_id: "123" }).toString()}&workspaceId=attacker`)],
  ])("rejects %s", (_name, body) => {
    expect(() => verifyMetaSignedRequest(body, "application/x-www-form-urlencoded", secret)).toThrow("invalid_signed_request");
  });

  it("rejects an oversized or incorrectly typed body", () => {
    expect(() => verifyMetaSignedRequest(Buffer.alloc(16 * 1024 + 1), "application/x-www-form-urlencoded", secret)).toThrow("invalid_signed_request");
    expect(() => verifyMetaSignedRequest(signedBody({ algorithm: "HMAC-SHA256", user_id: "123" }), "application/json", secret)).toThrow("invalid_signed_request");
  });
});
