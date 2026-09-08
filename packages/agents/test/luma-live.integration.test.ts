import { describe, expect, it } from "vitest";
import { LumaMumbaiSourcingProvider } from "../src/index.js";

const suite = process.env.TEST_LUMA_PUBLIC === "true" ? describe : describe.skip;

suite("Luma Mumbai live public contract", () => {
  it("reads current public events without retaining attendee or guest-list fields", async () => {
    const result = await new LumaMumbaiSourcingProvider({ timeoutMs: 20_000 }).research({
      sessionKey: "luma-live-contract",
      query: "Upcoming public Luma events in Mumbai with public hosts",
      depth: "standard",
      languages: ["English"],
      region: "Mumbai",
      sourceLimit: 3,
    });
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.every((source) => /^https:\/\/luma\.com\/[a-z0-9][a-z0-9-]{2,80}$/iu.test(source.url))).toBe(true);
    expect(result.toolsUsed).toEqual(["luma_public_city_page"]);
    expect(JSON.stringify(result.raw)).not.toMatch(/guest_count|guest_info|featured_guests|email|attendee/iu);
  });
});
