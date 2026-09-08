import { describe, expect, it } from "vitest";
import { advanceRemoteCorrectionOperation, approveRemoteCorrectionRequest, canonicalSha256, createRemoteCorrectionRequest, type PublishProof, type RemoteCorrectionMutation } from "@originpost/domain";
import { assertRemoteCorrectionObservation, assertRemoteCorrectionOutcome, ConnectorRegistry, MockFacebookConnector, MockInstagramConnector, MockYouTubeConnector, remoteSnapshot, type RemoteCorrectionConnector, type RemoteCorrectionTarget } from "../src/index.js";

const sha = (value: string) => canonicalSha256(value);

function proof(platform: "instagram" | "facebook" | "youtube", externalPostId = "post-1"): PublishProof {
  return {
    id: `proof-${platform}`, contentItemId: "content-1", draftId: "draft-1", draftSha256: sha("draft"),
    platform, accountId: `account-${platform}`, externalPostId, liveUrl: "https://example.invalid/live",
    publishedAt: "2026-08-29T10:00:00.000Z", captionSha256: sha("caption"), mediaSha256: [sha("media")],
    connectorResponseSha256: sha("publish-response"), approvedBy: "editor-1", sourceIds: ["source-1"], disclosure: "none",
  };
}

async function finalizing(connector: RemoteCorrectionConnector, platform: "instagram" | "facebook" | "youtube", mutation: RemoteCorrectionMutation) {
  const published = proof(platform);
  const target: RemoteCorrectionTarget = {
    workspaceId: "workspace-1", brandId: "brand-1", publishProofId: published.id, contentItemId: published.contentItemId,
    draftId: published.draftId, draftSha256: published.draftSha256, platform, accountId: published.accountId,
    externalPostId: published.externalPostId, mutation,
  };
  const before = await connector.preflightCorrection(target);
  const requested = createRemoteCorrectionRequest({
    id: `correction-${platform}`, workspaceId: target.workspaceId, brandId: target.brandId, publishProof: published, mutation,
    reason: "The live publication requires correction.", requestedBy: "manager-1", requestedAt: "2026-08-29T10:01:00.000Z",
  });
  const approved = approveRemoteCorrectionRequest({ operation:requested, approval:{actorId:"owner-1",actorType:"human",approvedAt:"2026-08-29T10:02:00.000Z"},beforeSnapshot:before });
  const preWrite = advanceRemoteCorrectionOperation(approved, "pre_write", "2026-08-29T10:03:00.000Z");
  return { before, operation: advanceRemoteCorrectionOperation(preWrite, "finalizing", "2026-08-29T10:04:00.000Z") };
}

describe("remote correction connector seam", () => {
  it("auto-registers the three correction adapters without disturbing publish registration", () => {
    const registry = new ConnectorRegistry();
    registry.register(new MockInstagramConnector());
    registry.register(new MockFacebookConnector());
    registry.register(new MockYouTubeConnector());
    expect(registry.getRemoteCorrection("instagram").manifest.platform).toBe("instagram");
    expect(registry.getRemoteCorrection("facebook").manifest.platform).toBe("facebook");
    expect(registry.getRemoteCorrection("youtube").manifest.platform).toBe("youtube");
    expect(registry.get("youtube").manifest.platform).toBe("youtube");
  });

  it("requires the durable finalizing state before any provider write", async () => {
    const connector = new MockYouTubeConnector();
    const request = await finalizing(connector, "youtube", { action: "make_private" });
    await expect(connector.executeCorrection({ ...request, operation: { ...request.operation, status: "approved" } })).rejects.toMatchObject({ code: "invalid_request", retrySafety: "reconcile_first" });
  });

  it("rejects a preflight snapshot changed after human approval", async () => {
    const connector = new MockYouTubeConnector();
    const request = await finalizing(connector, "youtube", { action: "make_private" });
    await expect(connector.executeCorrection({ ...request, before: { ...request.before, mutableState: { changed: true } } })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("supports YouTube make-private first and reconciles the verified state", async () => {
    const connector = new MockYouTubeConnector();
    const request = await finalizing(connector, "youtube", { action: "make_private" });
    await expect(connector.executeCorrection(request)).resolves.toMatchObject({ kind: "provider_confirmed", after: { state: "private" } });
    await expect(connector.reconcileCorrection({ operation: request.operation })).resolves.toMatchObject({ result: "matches_desired", snapshot: { state: "private" } });
  });

  it("never reports a manual handoff as provider-confirmed", async () => {
    const connector = new MockFacebookConnector();
    const request = await finalizing(connector, "facebook", { action: "manual_remove" });
    await expect(connector.executeCorrection(request)).resolves.toEqual({
      kind: "manual_action_required",
      reason: "Complete removal in the native provider and attach operator evidence.",
      handoff: "business_manager",
    });
  });

  it("rejects malformed provider receipts, snapshots, owners, and declared reconciliation results", async () => {
    const connector = new MockYouTubeConnector();
    const request = await finalizing(connector, "youtube", { action: "make_private" });
    const outcome = await connector.executeCorrection(request);
    expect(outcome.kind).toBe("provider_confirmed");
    if (outcome.kind !== "provider_confirmed") return;
    expect(assertRemoteCorrectionOutcome(request.operation, outcome)).toBe(outcome);
    expect(() => assertRemoteCorrectionOutcome(request.operation, { ...outcome, receipt: { ...outcome.receipt, externalPostId: "forged" } })).toThrow(/receipt/i);
    expect(() => assertRemoteCorrectionOutcome(request.operation, { ...outcome, after: { ...outcome.after, mutableState: { forged: true } } })).toThrow(/canonical/i);
    const wrongOwner = remoteSnapshot({ ...outcome.after, providerOwnerId: "different-owner" });
    expect(() => assertRemoteCorrectionOutcome(request.operation, { ...outcome, after: wrongOwner })).toThrow(/owner and lineage/i);
    expect(() => assertRemoteCorrectionObservation(request.operation, { snapshot: outcome.after, result: "does_not_match" })).toThrow(/result/i);
  });
});
