import { describe, expect, it } from "vitest";
import type { SourcingProvider } from "@originpost/agents";
import { selectMonitorSourcingProvider } from "../src/monitor-sourcing.js";

const provider = (id: string) => ({ id, health: async () => true, research: async () => { throw new Error("not used"); } }) satisfies SourcingProvider;

describe("monitor sourcing selection", () => {
  const fallback = provider("fallback");
  const luma = provider("luma-public");

  it("routes an enabled Luma-only tracked monitor to the bounded public adapter", () => {
    expect(selectMonitorSourcingProvider({ sourceIntelligence: { mode: "tracked_sources", sources: [{ id: "luma", label: "Luma Mumbai", url: "https://luma.com/mumbai", kind: "luma_city", priority: "primary", enabled: true }], includeTerms: [], excludeTerms: [], minimumScore: 35 } }, fallback, luma)).toBe(luma);
  });

  it("keeps mixed or non-Luma research on the configured fallback provider", () => {
    const mixed = { sourceIntelligence: { mode: "tracked_sources" as const, sources: [
      { id: "luma", label: "Luma Mumbai", url: "https://luma.com/mumbai", kind: "luma_city" as const, priority: "primary" as const, enabled: true },
      { id: "rss", label: "Official feed", url: "https://example.com/feed.xml", kind: "rss_atom" as const, priority: "trusted" as const, enabled: true },
    ], includeTerms: [], excludeTerms: [], minimumScore: 35 } };
    expect(selectMonitorSourcingProvider(mixed, fallback, luma)).toBe(fallback);
    expect(selectMonitorSourcingProvider({}, fallback, luma)).toBe(fallback);
  });
});
