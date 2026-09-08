import { describe, expect, it } from "vitest";
import { openProviderSessionUri, sealProviderSessionUri } from "../src/provider-operation-secret.js";

const key = Buffer.alloc(32, 7);

describe("provider operation secrets", () => {
  it("encrypts a resumable session and binds it to workspace and target", () => {
    const clear = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret";
    const sealed = sealProviderSessionUri(clear, key, "workspace-1", "target-1");
    expect(sealed).not.toContain("upload_id");
    expect(openProviderSessionUri(sealed, key, "workspace-1", "target-1")).toBe(clear);
    expect(() => openProviderSessionUri(sealed, key, "workspace-2", "target-1")).toThrow("could not be opened");
    expect(() => openProviderSessionUri(sealed, key, "workspace-1", "target-2")).toThrow("could not be opened");
  });

  it("rejects insecure or malformed sessions", () => {
    expect(() => sealProviderSessionUri("http://upload.test/session", key, "workspace-1", "target-1")).toThrow("secure");
    expect(() => openProviderSessionUri("not-an-envelope", key, "workspace-1", "target-1")).toThrow("invalid");
  });
});
