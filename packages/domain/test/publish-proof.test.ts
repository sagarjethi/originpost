import { describe, expect, it } from "vitest";
import { isClientReportEligibleEvidenceMode, publishProofEvidenceMode } from "../src/index.js";

describe("publication proof provenance", () => {
  it("preserves explicit evidence and classifies legacy mock URLs as simulations", () => {
    expect(publishProofEvidenceMode({ evidenceMode: "official", externalPostId: "provider-1", liveUrl: "https://www.instagram.com/p/1" })).toBe("official");
    expect(publishProofEvidenceMode({ externalPostId: "mock_post", liveUrl: "https://instagram.example.invalid/p/mock_post" })).toBe("simulation");
    expect(publishProofEvidenceMode({ externalPostId: "provider-legacy", liveUrl: "https://www.instagram.com/p/legacy" })).toBe("legacy_unknown");
  });

  it("allows client reporting only for established publication evidence", () => {
    expect(isClientReportEligibleEvidenceMode("official")).toBe(true);
    expect(isClientReportEligibleEvidenceMode("manual_attestation")).toBe(true);
    expect(isClientReportEligibleEvidenceMode("provider_reconciliation")).toBe(true);
    expect(isClientReportEligibleEvidenceMode("simulation")).toBe(false);
    expect(isClientReportEligibleEvidenceMode("legacy_unknown")).toBe(false);
    expect(isClientReportEligibleEvidenceMode(undefined)).toBe(false);
  });
});
