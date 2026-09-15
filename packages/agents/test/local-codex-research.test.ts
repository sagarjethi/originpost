import { expect, it, vi } from "vitest";
import {
  sourcePageText,
  verifySourceExcerpts,
} from "../src/local-codex-research.js";
import type { SourcingResult } from "../src/research.js";
const quote = "The public library opens on Monday at nine.";
const result: SourcingResult = {
  provider: "codex-local",
  model: "test",
  summary: "Test",
  sources: [
    {
      title: "Release",
      url: "https://example.org/release",
      excerpt: quote,
      confidence: 100,
    },
    {
      title: "Other",
      url: "https://example.org/other",
      excerpt: "This quote has not appeared on the page.",
      confidence: 100,
    },
  ],
  claims: [
    {
      text: "Opening",
      status: "supported",
      sourceUrls: ["https://example.org/release"],
    },
    {
      text: "Other claim",
      status: "supported",
      sourceUrls: ["https://example.org/other"],
    },
    {
      text: "Dispute",
      status: "disputed",
      sourceUrls: ["https://example.org/release"],
    },
  ],
  suggestions: [],
  toolsUsed: ["web_search"],
  raw: {},
};
it("checks actual response text, hashes the bytes and downgrades unsupported claims", async () => {
  const fetch = vi.fn(async (url: string) => ({
    url,
    status: 200,
    contentType: "text/html",
    body: Buffer.from(
      `<script>${result.sources[1]!.excerpt}</script><p>${quote}</p>`,
    ),
  }));
  const checked = await verifySourceExcerpts(result, fetch);
  expect(checked.sources[0]).toMatchObject({
    confidence: 80,
    retrieval: {
      status: "matched",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(checked.sources[1]).toMatchObject({
    confidence: 0,
    retrieval: { status: "mismatch" },
  });
  expect(checked.claims.map((claim) => claim.status)).toEqual([
    "supported",
    "unverified",
    "disputed",
  ]);
  expect(result.sources[0]!.confidence).toBe(100);
});
it("keeps unavailable sources visible without treating them as support", async () => {
  const checked = await verifySourceExcerpts(result, async () => {
    throw new Error("Blocked");
  });
  expect(
    checked.sources.every(
      (source) => source.retrieval?.status === "unavailable",
    ),
  ).toBe(true);
  expect(checked.claims[0]!.status).toBe("unverified");
});
it("normalizes markup and entities without counting script text as page evidence", () => {
  expect(
    sourcePageText(
      "<style>fake</style><p>ગુજરાત &amp; news&#160;today</p><script>hidden</script>",
    ),
  ).toBe("ગુજરાત & news today");
});
