import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBasePath, apiFetch, browserApiRoute } from "./api-client";

describe("browser API routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps private and public API requests on the current web origin", () => {
    expect(apiBasePath).toBe("/v1");
    expect(browserApiRoute("/v1/auth/me")).toBe("/v1/auth/me");
    expect(browserApiRoute("/public/v1/imports/preview")).toBe("/public/v1/imports/preview");
  });

  it("rejects absolute, protocol-relative, and unrelated browser destinations", () => {
    for (const path of ["https://api.example.test/v1/auth/me", "//api.example.test/v1/auth/me", "/health", "v1/auth/me"]) {
      expect(() => browserApiRoute(path)).toThrow(/relative \/v1 or \/public\/v1 path/u);
    }
  });

  it("sends credentials and the CSRF token through the relative proxy path", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await apiFetch("/v1/content-items", { method: "POST", body: "{}" }, "csrf-test");

    expect(fetch).toHaveBeenCalledOnce();
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/v1/content-items");
    expect(init.credentials).toBe("include");
    expect((init.headers as Headers).get("x-originpost-csrf")).toBe("csrf-test");
  });
});
