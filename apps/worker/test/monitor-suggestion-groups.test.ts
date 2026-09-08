import { describe, expect, it } from "vitest";
import type { SourcingResult } from "@originpost/agents";
import { groupMonitorSuggestions } from "../src/monitor-suggestion-groups.js";

const sources = [
  { title: "A official", url: "https://a.example/story", publisher: "A", confidence: 95 },
  { title: "A follow-up", url: "https://b.example/story", publisher: "B", confidence: 90 },
  { title: "Unrelated B", url: "https://c.example/other", publisher: "C", confidence: 85 },
];
const result: SourcingResult = { provider: "test", model: "test", summary: "Several findings.", sources, claims: [], suggestions: [{ title: "Story A", summary: "Two reports about A.", sourceUrls: [sources[0]!.url, sources[1]!.url] }], toolsUsed: [], raw: {} };

describe("monitor suggestion groups", () => {
  it("keeps unrelated events in separate content suggestions", () => {
    const groups = groupMonitorSuggestions(result, sources.map((source, index) => ({ source, fingerprint: `fingerprint-${index}` })));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ suggestion: { title: "Story A" }, candidates: [{ source: { publisher: "A" } }, { source: { publisher: "B" } }] });
    expect(groups[1]).toMatchObject({ suggestion: { title: "Unrelated B" }, candidates: [{ source: { publisher: "C" } }] });
  });

  it("includes only URLs that are new for this monitor", () => {
    const groups = groupMonitorSuggestions(result, [{ source: sources[1]!, fingerprint: "new-only" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.candidates.map((candidate) => candidate.source.url)).toEqual([sources[1]!.url]);
  });
});
