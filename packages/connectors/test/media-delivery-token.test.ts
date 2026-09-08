import { describe, expect, it } from "vitest";
import { createMediaDeliveryToken, verifyMediaDeliveryToken } from "../src/index.js";

const secret = "test-media-delivery-secret-with-32-bytes-minimum";
const now = Date.parse("2026-08-29T00:00:00.000Z");

describe("media delivery token", () => {
  it("binds workspace, media, hash, and expiry", () => {
    const token = createMediaDeliveryToken({ workspaceId: "workspace-a", mediaId: "media-a", sha256: "a".repeat(64), expiresAt: now + 60_000 }, secret, now);
    expect(verifyMediaDeliveryToken(token, secret, now + 30_000)).toEqual({ version: 1, workspaceId: "workspace-a", mediaId: "media-a", sha256: "a".repeat(64), expiresAt: now + 60_000 });
  });

  it("rejects tampering, expiry, and overlong grants", () => {
    const token = createMediaDeliveryToken({ workspaceId: "workspace-a", mediaId: "media-a", sha256: "a".repeat(64), expiresAt: now + 60_000 }, secret, now);
    expect(() => verifyMediaDeliveryToken(`${token.slice(0, -1)}x`, secret, now)).toThrow("signature");
    expect(() => verifyMediaDeliveryToken(token, secret, now + 60_000)).toThrow("expired");
    expect(() => createMediaDeliveryToken({ workspaceId: "workspace-a", mediaId: "media-a", sha256: "a".repeat(64), expiresAt: now + 7_200_001 }, secret, now)).toThrow("two hours");
  });
});
