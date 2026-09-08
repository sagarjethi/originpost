import { describe, expect, it } from "vitest";
import { batchContentItemId, batchTargetId, createBatchPlan, normalizeContentImportRow, type Actor } from "../src/index.js";
const manager: Actor = { id: "manager-1", name: "Manager", role: "manager", actorType: "human" }; const now = "2026-09-01T10:00:00.000Z";
describe("batch operations", () => {
  it("builds deterministic rows and IDs without approving anything", () => { const plan = createBatchPlan({ id: "batch-12345678", workspaceId: "workspace-1", brandId: "brand-1", name: "September reels", actor: manager, rows: [{ externalRef: "reel-01", title: "First reel", caption: "A useful caption", platform: "instagram", format: "reel", mediaAssetIds: ["media-1"], accountId: "account-1", scheduledFor: "2026-09-02T10:00:00.000Z", timezone: "Asia/Kolkata" }] }, now); expect(plan.status).toBe("ready"); expect(plan.rows[0]).toMatchObject({ status: "ready", bulkApprovalEligible: true, errors: [] }); expect(batchContentItemId(plan, plan.rows[0]!)).toMatch(/^content_batch_[a-f0-9]{32}$/); expect(batchTargetId(plan, plan.rows[0]!)).toMatch(/^target_batch_[a-f0-9]{32}$/); });
  it("fails duplicate posts and keeps high-risk work out of batch approval", () => { const row = { externalRef: "same", title: "Same", caption: "Same caption", platform: "instagram" as const, format: "image" as const, mediaAssetIds: ["media-1"], riskLevel: "high" as const }; const plan = createBatchPlan({ id: "batch-12345678", workspaceId: "workspace-1", brandId: "brand-1", name: "Risk check", actor: manager, rows: [row, row] }, now); expect(plan.rows.every((entry) => entry.status === "invalid")).toBe(true); const single = createBatchPlan({ id: "batch-87654321", workspaceId: "workspace-1", brandId: "brand-1", name: "Risk check", actor: manager, rows: [{ ...row, externalRef: "only" }] }, now); expect(single.rows[0]).toMatchObject({ status: "ready", bulkApprovalEligible: false }); expect(single.rows[0]!.warnings[0]).toContain("individual review"); });
  it("shares the original staged-import normalization rules", () => { expect(normalizeContentImportRow({ externalRef: "row-1", title: "Story", riskLevel: "medium" }, 1)).toMatchObject({ status: "valid", researchDepth: "standard", riskLevel: "medium" }); expect(normalizeContentImportRow({ externalRef: "bad ref", title: "" }, 2).errors).toHaveLength(2); });

  it("accepts one-media Instagram Story rows for governed batch review", () => {
    const plan = createBatchPlan({
      id: "batch_story",
      workspaceId: "ws-1",
      brandId: "brand-1",
      name: "Story batch",
      actor: { id: "owner-1", name: "Owner", role: "owner" },
      rows: [{ externalRef: "story-1", title: "Mumbai Story", platform: "instagram", format: "story", caption: "Internal review note", mediaAssetIds: ["media-story-1"] }],
    }, "2026-09-01T00:00:00.000Z");
    expect(plan.rows[0]).toMatchObject({ status: "ready", format: "story", mediaAssetIds: ["media-story-1"] });
  });
});
