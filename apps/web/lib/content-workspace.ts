export function belongsToContentWorkspace(view: string, item: { sources: unknown[]; researchRuns: unknown[]; proofs: unknown[] }): boolean {
  if (view === "Research") return item.sources.length > 0 || item.researchRuns.length > 0;
  if (view === "Proof") return item.proofs.length > 0;
  return true;
}
