import { describe, expect, it, vi } from "vitest";
import {
  WebsiteSourcingProvider,
  ensureSourceSnapshotBucket,
  type WebsiteCapture,
} from "../src/website-sourcing.js";
import {
  prepareSourceIntelligenceConfig,
  rankSourceSignals,
  sourceSnapshotKey,
  type MonitorRule,
} from "@originpost/domain";
const config = prepareSourceIntelligenceConfig({
  sources: [
    {
      label: "Publisher",
      url: "https://example.org/news",
      kind: "publisher_site",
      enabled: true,
    },
  ],
  minimumScore: 35,
});
const request = {
  sessionKey: "test",
  query: "News",
  depth: "standard" as const,
  languages: ["English"],
  sourceLimit: 20,
  freshnessHours: 24,
};
const now = () => new Date("2026-09-15T00:00:00Z");
const capture: WebsiteCapture = {
  pageUrl: "https://example.org/news",
  capturedAt: now().toISOString(),
  screenshot: Buffer.from("test-only"),
  stories: [
    {
      title: "New verified-source lead",
      url: "https://example.org/article/1",
      excerpt: "A source lead to verify",
      publishedAt: "2026-09-14T20:00:00Z",
    },
    {
      title: "No publication date",
      url: "https://example.org/article/2",
      excerpt: "Unknown date",
    },
    {
      title: "Old source",
      url: "https://example.org/article/old",
      excerpt: "Old",
      publishedAt: "2025-01-01T00:00:00Z",
    },
    {
      title: "Future date",
      url: "https://example.org/article/future",
      excerpt: "Future",
      publishedAt: "2027-01-01T00:00:00Z",
    },
  ],
};
describe("publisher browser sourcing", () => {
  it("keeps screenshot provenance and unknown dates without inventing verification", async () => {
    const store = vi.fn(async () => "a".repeat(64));
    const provider = new WebsiteSourcingProvider(
      config.sources,
      async () => capture,
      store,
      now,
    );
    const result = await provider.research(request);
    expect(result.sources).toHaveLength(2);
    expect(result.claims.every((claim) => claim.status === "unverified")).toBe(
      true,
    );
    expect(result.sources[0]?.snapshot).toMatchObject({
      sha256: "a".repeat(64),
      width: 1440,
      height: 1000,
    });
    const monitor: MonitorRule = {
      id: "m",
      workspaceId: "w",
      brandId: "b",
      name: "Publisher",
      query: "news",
      depth: "standard",
      languages: ["English"],
      intervalMinutes: 120,
      sourceLimit: 20,
      freshnessHours: 24,
      enabled: true,
      sourceIntelligence: config,
    };
    const signals = rankSourceSignals(
      monitor,
      { ...result, monitorRunId: "run" },
      now().toISOString(),
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]?.sources[0]).toMatchObject({
      rights: "reference-only",
      snapshot: { pageUrl: capture.pageUrl },
    });
    expect(signals[1]?.rankReasons).not.toContain("Fresh result");
    const changed = rankSourceSignals(
      monitor,
      {
        ...result,
        suggestions: result.suggestions.map((s) => ({
          ...s,
          title: "Updated headline",
        })),
        monitorRunId: "next",
      },
      now().toISOString(),
    );
    expect(changed.map((s) => s.id)).toEqual(signals.map((s) => s.id));
  });
  it("retains successful publishers and records partial failures", async () => {
    const sources = [
      ...config.sources,
      {
        ...config.sources[0]!,
        id: "bad",
        label: "Unavailable",
        url: "https://bad.example/news",
      },
    ];
    const provider = new WebsiteSourcingProvider(
      sources,
      async (url) => {
        if (url.includes("bad.")) throw new Error("unavailable");
        return capture;
      },
      async () => "a".repeat(64),
      now,
    );
    const result = await provider.research(request);
    expect(result.sources).toHaveLength(2);
    expect(result.toolsUsed).toContain("collector_failed:Unavailable");
  });
  it("does not emit a screenshot receipt when storage fails", async () => {
    const provider = new WebsiteSourcingProvider(
      config.sources,
      async () => capture,
      async () => {
        throw new Error("storage unavailable");
      },
      now,
    );
    await expect(provider.research(request)).rejects.toThrow(
      "All publisher pages failed",
    );
  });
  it("binds screenshot keys to workspace and brand", () => {
    expect(sourceSnapshotKey("w", "b", "a".repeat(64))).not.toBe(
      sourceSnapshotKey("other", "b", "a".repeat(64)),
    );
    expect(() => sourceSnapshotKey("w", "b", "../../secret")).toThrow();
  });
  it("creates a missing private bucket but never treats access denial as absence", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({});
    await ensureSourceSnapshotBucket(
      { send } as never,
      "private-sources",
      "us-east-1",
    );
    expect(send).toHaveBeenCalledTimes(2);
    const denied = vi
      .fn()
      .mockRejectedValue({ $metadata: { httpStatusCode: 403 } });
    await expect(
      ensureSourceSnapshotBucket(
        { send: denied } as never,
        "private-sources",
        "us-east-1",
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
