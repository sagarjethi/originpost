import { describe, expect, it } from "vitest";
import config, { resolveApiUpstream } from "./next.config";

describe("Next.js API proxy", () => {
  it("allows both loopback names used by local browser smoke tests", () => {
    expect(config.allowedDevOrigins).toEqual(["127.0.0.1", "localhost"]);
  });

  it("accepts only an origin-only server upstream", () => {
    expect(resolveApiUpstream()).toBe("http://127.0.0.1:4000");
    expect(resolveApiUpstream("http://api:4000")).toBe("http://api:4000");
    expect(resolveApiUpstream("https://private-api.example.test/")).toBe("https://private-api.example.test");
    for (const value of ["api:4000", "ftp://api:4000", "https://user:secret@api.test", "https://api.test/base", "https://api.test/?token=x"]) {
      expect(() => resolveApiUpstream(value)).toThrow(/ORIGINPOST_API_UPSTREAM/u);
    }
  });

  it("proxies both browser API namespaces without exposing the upstream to callers", async () => {
    const rewrites = await config.rewrites?.();
    expect(rewrites).toEqual([
      { source: "/v1/:path*", destination: "http://127.0.0.1:4000/v1/:path*" },
      { source: "/public/v1/:path*", destination: "http://127.0.0.1:4000/public/v1/:path*" },
    ]);
  });
});
