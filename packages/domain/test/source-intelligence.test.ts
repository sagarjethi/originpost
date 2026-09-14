import { describe, expect, it } from "vitest";
import { InMemorySourceSignalRepository, prepareSourceIntelligenceConfig, rankSourceSignals, signalToContentItem, sourceIntelligenceResearchContext, type MonitorRule } from "../src/index.js";

const actor = { id: "editor-1", name: "Editor", role: "owner" as const, actorType: "human" as const };
const monitor: MonitorRule = {
  id: "monitor_local", workspaceId: "workspace-1", brandId: "brand-1", name: "Ahmedabad public sources", query: "Important Ahmedabad civic changes",
  intervalMinutes: 30, depth: "standard", languages: ["Gujarati", "English"], region: "Gujarat", sourceLimit: 10, freshnessHours: 48, enabled: true,
  sourceIntelligence: prepareSourceIntelligenceConfig({ sources: [
    { label: "AMC feed", url: "https://ahmedabadcity.gov.in/news", kind: "rss_atom", priority: "primary", enabled: true },
    { label: "Local publisher feed", url: "https://news.example/ahmedabad", kind: "rss_atom", priority: "trusted", enabled: true },
  ], includeTerms: ["road", "closure"], excludeTerms: ["advertisement"], minimumScore: 50 }),
  createdBy: actor.id, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};

const discovery = {
  monitorRunId: "run-1", provider: "hermes", model: "research", toolsUsed: ["web_search", "web_extract"],
  suggestions: [{ title: "Major road closure announced", summary: "The city announced a road closure for repair work.", sourceUrls: ["https://ahmedabadcity.gov.in/news/road-closure?utm_source=feed", "https://news.example/ahmedabad/road-closure"] }],
  sources: [
    { title: "Official notice", url: "https://ahmedabadcity.gov.in/news/road-closure?utm_source=feed", publisher: "AMC", publishedAt: "2026-09-01T01:00:00.000Z", confidence: 95 },
    { title: "Local report", url: "https://news.example/ahmedabad/road-closure", publisher: "Local News", publishedAt: "2026-09-01T01:15:00.000Z", confidence: 85 },
    { title: "Untracked copy", url: "https://untrusted.example/copy", publisher: "Copy", confidence: 90 },
  ],
  claims: [{ text: "The road will close for repair work.", status: "supported" as const, sourceUrls: ["https://ahmedabadcity.gov.in/news/road-closure?utm_source=feed"] }],
};

describe("source intelligence", () => {
  it("normalizes a bounded public watchlist and produces a provider-safe research context", () => {
    expect(monitor.sourceIntelligence?.sources[0]?.url).toBe("https://ahmedabadcity.gov.in/news");
    const context = sourceIntelligenceResearchContext(monitor.sourceIntelligence!);
    expect(context).toContain("Do not bypass login");
    expect(context).toContain("https://ahmedabadcity.gov.in/news");
  });

  it("keeps only tracked URLs, ranks transparent reasons, and creates stable signals", () => {
    const [signal] = rankSourceSignals(monitor, discovery, "2026-09-01T02:00:00.000Z");
    expect(signal).toMatchObject({ state: "new", urgency: "high", score: 90, occurrenceCount: 1 });
    expect(signal!.sources).toHaveLength(2);
    expect(signal!.rankReasons).toEqual(expect.arrayContaining(["Tracked source", "Primary source", "Multiple publishers", "Fresh result"]));
    expect(rankSourceSignals(monitor, discovery, "2026-09-01T02:00:00.000Z")[0]!.id).toBe(signal!.id);
  });

  it("drops excluded or off-watchlist findings", () => {
    expect(rankSourceSignals(monitor, { ...discovery, suggestions: [{ ...discovery.suggestions[0]!, title: "Advertisement for a road product" }] })).toEqual([]);
    expect(rankSourceSignals(monitor, { ...discovery, suggestions: [{ title: "Other", summary: "Other", sourceUrls: ["https://untrusted.example/copy"] }] })).toEqual([]);
  });

  it("upserts occurrences, preserves triage, and converts saved signals into governed content", async () => {
    const repository = new InMemorySourceSignalRepository(); const signal = rankSourceSignals(monitor, discovery, "2026-09-01T02:00:00.000Z")[0]!;
    expect((await repository.ingest([signal])).newCount).toBe(1);
    const repeated = await repository.ingest([{ ...signal, monitorRunId: "run-2", lastSeenAt: "2026-09-01T03:00:00.000Z" }]);
    expect(repeated.signals[0]).toMatchObject({ occurrenceCount: 2, version: 2 });
    const created = signalToContentItem(repeated.signals[0]!, actor, "2026-09-01T03:01:00.000Z");
    expect(created.item).toMatchObject({ status: "inbox", riskLevel: "medium" });
    expect(created.item.sources.every((source) => source.rights === "reference-only")).toBe(true);
    const claimed = await repository.claimSave({ workspaceId: signal.workspaceId, id: signal.id, expectedVersion: 2, actorId: actor.id, at: "2026-09-01T03:02:00.000Z", claimId: "claim-1", leaseExpiresAt: "2026-09-01T03:04:00.000Z", contentItemId: created.item.id });
    expect(claimed).toMatchObject({ state: "saving", pendingContentItemId: created.item.id });
    const saved = await repository.finishSave({ workspaceId: signal.workspaceId, id: signal.id, expectedVersion: 3, actorId: actor.id, at: "2026-09-01T03:03:00.000Z", claimId: "claim-1", contentItemId: created.item.id });
    expect(saved).toMatchObject({ state: "saved", contentItemId: created.item.id });
    const afterThirdRun = await repository.ingest([{ ...signal, monitorRunId: "run-3", lastSeenAt: "2026-09-01T04:00:00.000Z" }]);
    expect(afterThirdRun.signals[0]).toMatchObject({ state: "saved", occurrenceCount: 3, contentItemId: created.item.id });
  });

  it("permits browser-backed publisher pages while keeping social profiles off", () => {
    expect(prepareSourceIntelligenceConfig({ sources: [{ label: "Website", url: "https://example.com", kind: "publisher_site", enabled: true }] }).sources[0]?.enabled).toBe(true);
    expect(() => prepareSourceIntelligenceConfig({ sources: [{ label: "Profile", url: "https://example.com", kind: "public_profile", enabled: true }] })).toThrow(/official adapter/i);
    const config = prepareSourceIntelligenceConfig({ sources: [{ label: "Luma Mumbai", url: "https://luma.com/mumbai", kind: "luma_city", priority: "primary", enabled: true }] });
    expect(config.sources[0]).toMatchObject({ kind: "luma_city", priority: "primary" });
    expect(sourceIntelligenceResearchContext(config)).toContain("Never collect attendee or guest-list identities");
  });

  it("does not award freshness for a missing or future publication time", () => {
    const future = { ...discovery, sources: discovery.sources.map((source) => ({ ...source, publishedAt: "2026-09-03T00:00:00.000Z" })) };
    const [signal] = rankSourceSignals(monitor, future, "2026-09-01T02:00:00.000Z");
    expect(signal?.rankReasons).not.toContain("Fresh result");
    expect(signal?.rankReasons).not.toContain("Strong source confidence");
  });
});

describe("feed provenance and freshness", () => {
 const feedMonitor = { ...monitor, sourceIntelligence: prepareSourceIntelligenceConfig({sources:[{label:"Feed",url:"https://feed.example/rss.xml",kind:"rss_atom",priority:"trusted",enabled:true}],minimumScore:35}) };
 const feedDiscovery = { monitorRunId:"feed-run",provider:"public-feeds",model:"rss-atom-v1",toolsUsed:["public_rss_atom"], sources:[{title:"Report",url:"https://publisher.example/article",feedUrl:"https://feed.example/rss.xml",publishedAt:"2026-09-01T01:00:00.000Z",confidence:50}], suggestions:[{title:"Report",summary:"A report",sourceUrls:["https://publisher.example/article"]}],claims:[{text:"Claim",status:"unverified" as const,sourceUrls:["https://publisher.example/article"]}] };
 it("uses collector-attested feed provenance, and keeps the same identity when a headline changes", () => {
  const first = rankSourceSignals(feedMonitor,feedDiscovery,"2026-09-01T02:00:00.000Z")[0]!;
  expect(first.sources[0]?.url).toBe("https://publisher.example/article"); expect(first.claims[0]?.status).toBe("unverified");
  expect(rankSourceSignals(feedMonitor,{...feedDiscovery,suggestions:[{...feedDiscovery.suggestions[0]!,title:"Corrected report"}]},"2026-09-01T02:00:00.000Z")[0]?.id).toBe(first.id);
  expect(rankSourceSignals(feedMonitor,{...feedDiscovery,provider:"hermes"},"2026-09-01T02:00:00.000Z")).toEqual([]);
 });
 it("filters publication time before limiting, sorts newest, and never confuses repeat observation with publication", async () => {
  const repository = new InMemorySourceSignalRepository();
  const first = rankSourceSignals(feedMonitor,feedDiscovery,"2026-09-01T02:00:00.000Z")[0]!;
  await repository.ingest([{...first,id:"old",publishedAt:"2026-08-01T00:00:00.000Z",score:100,lastSeenAt:"2026-09-02T00:00:00.000Z"},{...first,id:"new",score:40},{...first,id:"unknown",publishedAt:undefined,score:90}]);
  const recent = await repository.list({workspaceId:"workspace-1",brandId:"brand-1",sort:"newest",publishedAfter:"2026-09-01T00:00:00.000Z",limit:1});
  expect(recent.map(signal=>signal.id)).toEqual(["new"]);
  expect((await repository.list({workspaceId:"workspace-1",sort:"newest"})).map(signal=>signal.id)).toEqual(["new","old","unknown"]);
  expect(await repository.list({workspaceId:"other"})).toEqual([]);
 });
});
