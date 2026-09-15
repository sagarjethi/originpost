import { describe, expect, it } from "vitest";
import { canonicalSourceUrl, createMonitorRule, createMonitorSuggestion, InMemoryContentItemRepository, InMemoryMonitorRepository, sourceFingerprint, updateMonitorRule, type Actor, type MonitorRun } from "../src/index.js";

const owner: Actor = { id: "owner", name: "Owner", role: "owner" };

describe("monitoring", () => {
  it("stores workspace-scoped schedules, runs, and deduplication fingerprints", async () => {
    const repository = new InMemoryMonitorRepository();
    const rule = createMonitorRule({
      workspaceId: "ws-1",
      brandId: "brand-1",
      name: "Gujarat updates",
      query: "latest Gujarat updates",
      intervalMinutes: 15,
      depth: "standard",
      languages: ["English", "Gujarati", "Gujarati"],
      region: "Gujarat",
      sourceLimit: 8,
      freshnessHours: 24,
      enabled: true,
    }, owner, "2026-08-28T10:00:00.000Z");
    await repository.save(rule);
    const run: MonitorRun = { id: "run-1", workspaceId: "ws-1", monitorId: rule.id, status: "running", trigger: "scheduled", discoveredCount: 0, newCount: 0, startedAt: "2026-08-28T10:15:00.000Z" };
    await repository.startRun(run);
    await repository.finishRun({ ...run, status: "completed", discoveredCount: 2, newCount: 1, contentItemId: "content-1", completedAt: "2026-08-28T10:15:05.000Z" }, [{ workspaceId: "ws-1", monitorId: rule.id, fingerprint: "abc", sourceUrl: "https://example.com/news", contentItemId: "content-1", firstSeenAt: "2026-08-28T10:15:05.000Z" }]);

    expect(rule.languages).toEqual(["English", "Gujarati"]);
    expect(rule.updatedBy).toBe(owner.id);
    expect(updateMonitorRule(rule,{query:"Changed request"},{...owner,id:"another-owner"})).toMatchObject({createdBy:owner.id,updatedBy:"another-owner"});
    expect((await repository.listEnabled()).map((entry) => entry.id)).toEqual([rule.id]);
    expect(await repository.hasFingerprint("ws-1", rule.id, "abc")).toBe(true);
    expect(await repository.get("other", rule.id)).toBeNull();
    expect((await repository.listRuns("ws-1", rule.id))[0]?.newCount).toBe(1);
    expect(updateMonitorRule(rule, { intervalMinutes: 5 }, owner).intervalMinutes).toBe(10);
  });

  it("allows only one active run per monitor", async () => {
    const repository = new InMemoryMonitorRepository();
    const first: MonitorRun = { id: "run-1", workspaceId: "ws-1", monitorId: "monitor-1", status: "running", trigger: "scheduled", discoveredCount: 0, newCount: 0, startedAt: "2026-08-28T10:00:00.000Z" };
    const second: MonitorRun = { ...first, id: "run-2", startedAt: "2026-08-28T10:00:01.000Z" };

    expect(await repository.startRun(first)).toBe(true);
    expect(await repository.startRun(second)).toBe(false);
    await repository.recordSkipped({ ...second, status: "skipped", reason: "monitor_already_running", completedAt: "2026-08-28T10:00:01.000Z" });
    await repository.finishRun({ ...first, status: "completed", completedAt: "2026-08-28T10:00:02.000Z" }, []);
    const third = { ...second, id: "run-3", startedAt: "2026-08-28T10:00:03.000Z" };
    expect(await repository.startRun(third)).toBe(true);
    expect((await repository.listRuns("ws-1", "monitor-1")).some((run) => run.status === "skipped")).toBe(true);
  });

  it("deduplicates tracking variants of the same source URL", () => {
    expect(canonicalSourceUrl("https://NEWS.example.com/story/?utm_source=instagram&b=2&a=1#comments")).toBe("https://news.example.com/story?a=1&b=2");
    expect(sourceFingerprint("https://news.example.com/story?a=1&b=2")).toBe(sourceFingerprint("https://NEWS.example.com/story/?utm_medium=social&b=2&a=1#top"));
  });

  it("creates one reviewable monitor suggestion with completed source provenance", () => {
    const result = createMonitorSuggestion({
      workspaceId: "ws-1", monitorId: "monitor-1", monitorRunId: "run-1", title: "One event", summary: "Two publishers report the same event.", query: "event", depth: "standard", languages: ["English"], freshnessHours: 24, sourceLimit: 6,
      sources: [
        { kind: "url", title: "Official report", url: "https://authority.example/event", publisher: "Authority", publishedAt: "2026-08-29T00:00:00.000Z", retrievedAt: "2026-08-29T00:05:00.000Z", rights: "reference-only", confidence: 98 },
        { kind: "url", title: "Independent report", url: "https://news.example/event", publisher: "News", publishedAt: "2026-08-29T00:02:00.000Z", retrievedAt: "2026-08-29T00:05:00.000Z", rights: "reference-only", confidence: 90 },
      ],
      claims: [{ text: "The event happened.", status: "supported", sourceUrls: ["https://authority.example/event", "https://news.example/event"] }], provider: "hermes", model: "hermes-agent", responseId: "response-1", toolsUsed: ["web_search", "web_extract"],
    }, owner, "2026-08-29T00:05:00.000Z");
    expect(result.item).toMatchObject({ version: 1, status: "inbox", tags: ["monitor", "multi-source"], sources: [{ publisher: "Authority" }, { publisher: "News" }], claims: [{ status: "supported" }], researchRuns: [{ status: "completed", provider: "hermes", responseId: "response-1" }] });
    expect(result.event).toMatchObject({ actorType: "agent", detail: { monitorId: "monitor-1", monitorRunId: "run-1", sourceCount: 2 } });
  });

  it("commits a suggestion and its deduplication fingerprint together", async () => {
    const monitors = new InMemoryMonitorRepository();
    const content = new InMemoryContentItemRepository(undefined, undefined, monitors);
    const created = createMonitorSuggestion({ workspaceId: "ws-1", monitorId: "monitor-1", monitorRunId: "run-1", title: "Atomic suggestion", summary: "Saved with its source fingerprint.", query: "atomic", depth: "quick", languages: ["English"], freshnessHours: 24, sourceLimit: 2, sources: [{ kind: "url", title: "Source", url: "https://example.com/atomic", rights: "reference-only", confidence: 90 }], claims: [], provider: "mock", model: "mock", toolsUsed: ["mock_search"] }, owner);
    const fingerprint = sourceFingerprint("https://example.com/atomic?utm_source=social");
    await content.commit(created.item, created.event, [], [], [{ workspaceId: "ws-1", monitorId: "monitor-1", fingerprint, sourceUrl: "https://example.com/atomic", contentItemId: created.item.id, firstSeenAt: created.item.createdAt }]);
    expect(await monitors.hasFingerprint("ws-1", "monitor-1", fingerprint)).toBe(true);
    expect(await content.get("ws-1", created.item.id)).toMatchObject({ sources: [{ title: "Source" }] });
  });
});
