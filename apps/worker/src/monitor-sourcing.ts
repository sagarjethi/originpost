import { RssAtomSourcingProvider, type SourcingProvider } from "@originpost/agents";
import type { MonitorRule } from "@originpost/domain";

export function selectMonitorSourcingProvider(
  monitor: Pick<MonitorRule, "sourceIntelligence">,
  fallback: SourcingProvider,
  lumaMumbai: SourcingProvider,
): SourcingProvider {
  const enabled = monitor.sourceIntelligence?.sources.filter((source) => source.enabled) ?? [];
  if (!enabled.length) return fallback;
  if (enabled.every(source => source.kind === "luma_city")) return lumaMumbai;
  const feeds = enabled.filter(source => source.kind === "rss_atom");
  const rss = new RssAtomSourcingProvider(feeds);
  if (feeds.length === enabled.length) return rss;
  return {
    id: "public-tracked", health: async () => true,
    async research(request) {
      const providers = [...(feeds.length ? [rss] : []), ...(enabled.some(source => source.kind === "luma_city") ? [lumaMumbai] : [])];
      const settled = await Promise.allSettled(providers.map(provider => provider.research(request)));
      const results = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (!results.length) throw new Error("All configured public source collectors failed.");
      return { provider: "public-tracked", model: "public-tracked-v1", summary: results.map(result => result.summary).join("\n"), sources: results.flatMap(result => result.sources), claims: results.flatMap(result => result.claims), suggestions: results.flatMap(result => result.suggestions), toolsUsed: [...results.flatMap(result => result.toolsUsed), ...settled.flatMap((result,index) => result.status === "rejected" ? [`collector_failed:${providers[index]!.id}`] : [])], raw: { collectors: providers.map(provider => provider.id), failures: settled.filter(result => result.status === "rejected").length } };
    },
  };
}
