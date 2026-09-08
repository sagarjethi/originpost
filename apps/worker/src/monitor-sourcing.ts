import type { SourcingProvider } from "@originpost/agents";
import type { MonitorRule } from "@originpost/domain";

export function selectMonitorSourcingProvider(
  monitor: Pick<MonitorRule, "sourceIntelligence">,
  fallback: SourcingProvider,
  lumaMumbai: SourcingProvider,
): SourcingProvider {
  const enabled = monitor.sourceIntelligence?.sources.filter((source) => source.enabled) ?? [];
  return enabled.length > 0 && enabled.every((source) => source.kind === "luma_city") ? lumaMumbai : fallback;
}
