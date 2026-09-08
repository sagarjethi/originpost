import { describe, expect, it } from "vitest";
import { parseProviderLookupKeyring, providerLookupCandidates, providerLookupHmac } from "./provider-lookup-keyring.js";

describe("provider lookup keyring", () => {
  it("uses the active version and context-separates provider subjects", () => {
    const keyring = parseProviderLookupKeyring(`v1:${Buffer.alloc(32, 1).toString("base64")},v2:${Buffer.alloc(32, 2).toString("base64")}`, "v2");
    const meta = providerLookupHmac(keyring, "meta", "app-1", "123");
    expect(meta.version).toBe("v2");
    expect(meta.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(providerLookupHmac(keyring, "meta", "app-2", "123").digest).not.toBe(meta.digest);
    expect(providerLookupHmac(keyring, "google", "app-1", "123").digest).not.toBe(meta.digest);
    expect(providerLookupCandidates(keyring, "meta", "app-1", "123").map((candidate) => candidate.version)).toEqual(["v1", "v2"]);
  });

  it("rejects short, duplicate, or missing active keys", () => {
    expect(() => parseProviderLookupKeyring("v1:c2hvcnQ=", "v1")).toThrow();
    expect(() => parseProviderLookupKeyring(`v1:${Buffer.alloc(32).toString("base64")},v1:${Buffer.alloc(32, 1).toString("base64")}`, "v1")).toThrow();
    expect(() => parseProviderLookupKeyring(`v1:${Buffer.alloc(32).toString("base64")}`, "v2")).toThrow();
  });
});
