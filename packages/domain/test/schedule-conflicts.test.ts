import { describe, expect, it } from "vitest";
import { assertScheduleConflictAcknowledgement, createContentItem, inspectScheduleConflicts, type ContentItem } from "../src/index.js";

const base = createContentItem({ contentId: "content-current", workspaceId: "workspace-1", brandId: "brand-1", title: "Current", summary: "", actor: { id: "owner", name: "Owner", role: "owner" } }, "2026-09-01T10:00:00.000Z").item;
const request = { workspaceId: "workspace-1", brandId: "brand-1", contentItemId: base.id, draftId: "draft-current", draftSha256: "a".repeat(64), platform: "instagram" as const, accountId: "account-1", scheduledFor: "2026-09-02T10:00:00.000Z" };

function scheduled(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    ...base,
    id: "content-existing",
    title: "Existing campaign",
    drafts: [{ id: "draft-existing", platform: "instagram", format: "image", title: "Same", caption: "Same", mediaIds: ["media-1"], revision: 1, contentSha256: "a".repeat(64), createdBy: "owner", createdAt: "2026-09-01T10:00:00.000Z" }],
    targets: [{ id: "target-existing", platform: "instagram", accountId: "account-1", draftId: "draft-existing", scheduledFor: "2026-09-02T10:30:00.000Z", deliveryMode: "auto_publish", status: "queued" }],
    ...overrides,
  };
}

describe("schedule conflict preflight", () => {
  it("finds exact-content and same-account time warnings and binds acknowledgement to the live set", () => {
    const preflight = inspectScheduleConflicts([scheduled()], request);
    expect(preflight.conflicts).toEqual([expect.objectContaining({ targetId: "target-existing", kinds: ["exact_content_duplicate", "account_time_overlap"], minutesApart: 30 })]);
    expect(() => assertScheduleConflictAcknowledgement(preflight)).toThrowError(expect.objectContaining({ code: "schedule_conflict_confirmation_required" }));
    expect(() => assertScheduleConflictAcknowledgement(preflight, preflight.acknowledgementSha256)).not.toThrow();
    const changed = inspectScheduleConflicts([scheduled({ targets: [{ ...scheduled().targets[0]!, scheduledFor: "2026-09-03T10:30:00.000Z" }] })], request);
    expect(changed.acknowledgementSha256).not.toBe(preflight.acknowledgementSha256);
  });

  it("ignores other accounts, other brands, terminal targets, and the target being rescheduled", () => {
    const terminal = scheduled({ targets: [{ ...scheduled().targets[0]!, status: "published" }] });
    const otherAccount = scheduled({ id: "other-account", targets: [{ ...scheduled().targets[0]!, id: "other-target", accountId: "account-2" }] });
    const otherBrand = scheduled({ id: "other-brand", brandId: "brand-2" });
    const excluded = inspectScheduleConflicts([scheduled(), terminal, otherAccount, otherBrand], { ...request, excludeTargetId: "target-existing" });
    expect(excluded.conflicts).toEqual([]);
    expect(excluded.requiresConfirmation).toBe(false);
  });
});
