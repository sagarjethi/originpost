import { describe, expect, it } from "vitest";
import { firstCommentEvidenceLabel, firstCommentNeedsPoll, firstCommentPermission, firstCommentStatusCopy, parseFirstCommentRecords } from "./first-comment-utils";

describe("first-comment UI contract", () => {
  it("parses only sanitized records and ignores provider internals", () => {
    const records = parseFirstCommentRecords({ data: [{ intent: { id: "first-1", targetId: "target-1", platform: "instagram", body: "Full story", bodySha256: "a".repeat(64), status: "uncertain", executionMode: "reconcile", version: 4, requestedBy: "creator", providerAcceptedAt: "2026-09-01T10:00:00.000Z", providerCommentId: "not-needed-by-ui", claimOwner: "secret-worker", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" }, proofs: [] }] });
    expect(records).toHaveLength(1);
    expect(records[0]?.intent).not.toHaveProperty("claimOwner");
    expect(records[0]?.intent).not.toHaveProperty("providerCommentId");
    expect(parseFirstCommentRecords({ data: [{ intent: { platform: "youtube" } }] })).toEqual([]);
  });

  it("keeps approval and operator evidence honest", () => {
    expect(firstCommentPermission("creator")).toEqual({ canDraft: true, canApprove: false, canAttest: false });
    expect(firstCommentPermission("manager").canApprove).toBe(true);
    expect(firstCommentEvidenceLabel("operator_attested")).toBe("Operator attested");
    expect(firstCommentStatusCopy("uncertain", "write").detail).toContain("never send another comment blindly");
  });

  it("polls only provider-bound in-flight states", () => {
    expect(["approved", "queued", "processing"].every((status) => firstCommentNeedsPoll(status as never))).toBe(true);
    expect(firstCommentNeedsPoll("uncertain")).toBe(false);
  });
});
