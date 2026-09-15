import { expect, it } from "vitest";
import {
  addSource,
  completeResearch,
  createContentItem,
  hasLiveAgentResearch,
  startResearch,
} from "../src/index.js";
const actor = { id: "owner", name: "Owner", role: "owner" as const };
it("preserves the discovery record and binds supported claims to the new checked source revision", () => {
  let { item } = createContentItem({
    workspaceId: "w",
    title: "Library lead",
    actor,
  });
  ({ item } = addSource(
    item,
    {
      kind: "url",
      title: "Discovery",
      url: "https://example.org/library",
      rights: "reference-only",
      confidence: 0,
    },
    actor,
  ));
  const original = item.sources[0]!;
  const started = startResearch(
    item,
    { depth: "standard", languages: ["English"], sourceLimit: 2 },
    actor,
    "2026-09-15T00:00:00.000Z",
  );
  ({ item } = completeResearch(
    started.item,
    started.run.id,
    {
      provider: "codex-local",
      model: "test",
      toolsUsed: ["web_search"],
      summary: "Checked",
      sources: [
        {
          kind: "url",
          title: "Retrieved release",
          url: original.url!,
          rights: "reference-only",
          confidence: 80,
          excerpt: "The library opens on Monday morning.",
          retrieval: {
            status: "matched",
            checkedAt: "2026-09-15T00:00:01.000Z",
            sha256: "a".repeat(64),
          },
        },
      ],
      claims: [
        {
          text: "The library opens Monday.",
          status: "supported",
          sourceUrls: [original.url!],
        },
      ],
    },
    actor,
  ));
  expect(item.sources).toHaveLength(2);
  expect(item.sources[0]).toEqual(original);
  expect(item.claims[0]!.sourceIds).toEqual([item.sources[1]!.id]);
  expect(hasLiveAgentResearch(item, started.run.id)).toBe(true);
  item.sources[1]!.retrieval!.checkedAt = "2026-09-14T00:00:00.000Z";
  expect(hasLiveAgentResearch(item, started.run.id)).toBe(false);
  item.sources[1]!.retrieval!.checkedAt = "2026-09-15T00:00:01.000Z";
  item.sources[1]!.retrieval!.sha256 = "invalid";
  expect(hasLiveAgentResearch(item, started.run.id)).toBe(false);
  item.sources[1]!.retrieval!.sha256 = "a".repeat(64);
  item.sources[1]!.retrieval!.status = "mismatch";
  expect(hasLiveAgentResearch(item, started.run.id)).toBe(false);
});
