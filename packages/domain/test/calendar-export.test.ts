import { describe, expect, it } from "vitest";
import { calendarScheduleCsv, spreadsheetSafeCsvCell, type ContentItem } from "../src/index.js";

function item(input: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "content-1", workspaceId: "workspace-1", brandId: "brand-1", version: 1, title: "મુંબઈ, launch", summary: "", status: "scheduled",
    researchDepth: "quick", riskLevel: "low", tags: [], sources: [], claims: [], researchRuns: [], drafts: [], approvals: [], reviewComments: [], reviewLinks: [], publishAttempts: [], proofs: [], createdBy: "owner", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    targets: [{ id: "target-1", platform: "instagram", accountId: "account-1", draftId: "draft-1", scheduledFor: "2026-09-01T04:00:00.000Z", timezone: "Asia/Kolkata", deliveryMode: "auto_publish", status: "queued" }],
    ...input,
  };
}

describe("calendar schedule CSV", () => {
  it("exports only the selected workspace, brand, month, platform, and status with stable safe columns", () => {
    const csv = calendarScheduleCsv([
      item(),
      item({ id: "wrong-brand", brandId: "brand-2", title: "Never exported" }),
      item({ id: "october", title: "Later", targets: [{ id: "target-2", platform: "instagram", accountId: "account-1", draftId: "draft-2", scheduledFor: "2026-09-30T19:00:00.000Z", timezone: "Asia/Kolkata", deliveryMode: "manual_handoff", status: "queued" }] }),
    ], new Map([["account-1", "Main Instagram"]]), { workspaceId: "workspace-1", brandId: "brand-1", month: "2026-09", timeZone: "Asia/Kolkata", platform: "instagram", status: "queued" });
    expect(csv.startsWith('\uFEFF"content_title","platform","account"')).toBe(true);
    expect(csv).toContain('"મુંબઈ, launch","instagram","Main Instagram","2026-09-01 09:30:00","Asia/Kolkata","2026-09-01 09:30:00"');
    expect(csv).not.toContain("Never exported");
    expect(csv).not.toContain("Later");
    expect(csv).not.toContain("account-1");
    expect(csv).not.toContain("draft-1");
  });

  it("returns a deterministic header-only file when no rows match", () => {
    const csv = calendarScheduleCsv([item()], new Map(), { workspaceId: "workspace-1", brandId: "brand-1", month: "2026-08", timeZone: "UTC" });
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("neutralizes formula prefixes and quotes every UTF-8 cell", () => {
    for (const value of ["=cmd", "  +SUM(1,1)", "@HYPERLINK", "-1", "\t=cmd", "\r+cmd", "\n-cmd"]) {
      expect(spreadsheetSafeCsvCell(value).startsWith('"\'')).toBe(true);
    }
    expect(spreadsheetSafeCsvCell('Gujarati ગુજરાતી, "quoted"\nline')).toBe('"Gujarati ગુજરાતી, ""quoted""\nline"');
  });

  it("rejects invalid month and time-zone boundaries", () => {
    expect(() => calendarScheduleCsv([], new Map(), { workspaceId: "workspace-1", brandId: "brand-1", month: "2026-13", timeZone: "UTC" })).toThrow("YYYY-MM");
    expect(() => calendarScheduleCsv([], new Map(), { workspaceId: "workspace-1", brandId: "brand-1", month: "2026-09", timeZone: "Not/AZone" })).toThrow("valid IANA");
  });
});
