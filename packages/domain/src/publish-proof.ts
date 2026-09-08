import type { PublishEvidenceMode, PublishProof } from "./types.js";

const modes = new Set<PublishEvidenceMode>(["official", "manual_attestation", "provider_reconciliation", "simulation", "legacy_unknown"]);

/**
 * Gives old proof rows an honest, fail-closed classification without rewriting
 * their immutable payload. New proof writers always persist evidenceMode.
 */
export function publishProofEvidenceMode(proof: Pick<PublishProof, "evidenceMode" | "externalPostId" | "liveUrl">): PublishEvidenceMode {
  if (proof.evidenceMode && modes.has(proof.evidenceMode)) return proof.evidenceMode;
  if (/^(mock|simulated)[_:-]/iu.test(proof.externalPostId)) return "simulation";
  try {
    if (new URL(proof.liveUrl).hostname.endsWith(".invalid")) return "simulation";
  } catch {
    return "legacy_unknown";
  }
  return "legacy_unknown";
}

export function isSimulationPublishProof(proof: Pick<PublishProof, "evidenceMode" | "externalPostId" | "liveUrl">): boolean {
  return publishProofEvidenceMode(proof) === "simulation";
}

export function isClientReportEligibleEvidenceMode(mode: PublishEvidenceMode | undefined): boolean {
  return mode === "official" || mode === "manual_attestation" || mode === "provider_reconciliation";
}
