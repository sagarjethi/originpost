import type { SourcingResult } from "@originpost/agents";

export type MonitorCandidate = { source: SourcingResult["sources"][number]; fingerprint: string };
export type MonitorSuggestionGroup = { suggestion: SourcingResult["suggestions"][number]; candidates: MonitorCandidate[] };

export function groupMonitorSuggestions(result: SourcingResult, candidates: MonitorCandidate[]): MonitorSuggestionGroup[] {
  const candidateByUrl = new Map(candidates.map((candidate) => [candidate.source.url, candidate]));
  const unusedUrls = new Set(candidateByUrl.keys());
  const grouped = result.suggestions.map((suggestion) => ({
    suggestion,
    candidates: suggestion.sourceUrls.flatMap((url) => {
      const candidate = candidateByUrl.get(url);
      return candidate && unusedUrls.has(candidate.source.url) ? [candidate] : [];
    }),
  })).filter((entry) => entry.candidates.length > 0);
  for (const entry of grouped) for (const candidate of entry.candidates) unusedUrls.delete(candidate.source.url);
  for (const url of unusedUrls) {
    const candidate = candidateByUrl.get(url)!;
    grouped.push({ suggestion: { title: candidate.source.title, summary: candidate.source.excerpt ?? result.summary, sourceUrls: [url] }, candidates: [candidate] });
  }
  return grouped;
}
