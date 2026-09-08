import { describe, expect, it, vi } from "vitest";
import { browserTimeZone, calendarEntriesForMonth, dateKeyInZone, flattenCalendarEntries, monthDays, monthRangeInZone, shiftMonth, toLocalInputValue, zonedDateTimeToUtc } from "./calendar-utils";

describe("calendar time handling", () => {
  it("turns an intended IANA wall-clock time into the exact UTC instant", () => {
    expect(zonedDateTimeToUtc("2026-09-01T09:30", "Asia/Kolkata")).toBe("2026-09-01T04:00:00.000Z");
    expect(toLocalInputValue("2026-09-01T04:00:00.000Z", "Asia/Kolkata")).toBe("2026-09-01T09:30");
  });

  it("rejects a wall-clock time skipped by daylight saving", () => {
    expect(() => zonedDateTimeToUtc("2026-03-08T02:30", "America/New_York")).toThrow("does not exist");
  });

  it("uses the viewing zone for calendar date grouping", () => {
    expect(dateKeyInZone("2026-09-01T00:15:00.000Z", "America/Los_Angeles")).toBe("2026-08-31");
    expect(dateKeyInZone("2026-09-01T00:15:00.000Z", "Asia/Kolkata")).toBe("2026-09-01");
  });

  it("normalizes the legacy Calcutta alias shown by some browsers", () => {
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ locale: "en", calendar: "gregory", numberingSystem: "latn", timeZone: "Asia/Calcutta" });
    expect(browserTimeZone()).toBe("Asia/Kolkata");
    resolved.mockRestore();
  });
});

describe("calendar structure", () => {
  it("builds a Monday-first month grid and shifts across year boundaries", () => {
    const cells = monthDays("2026-08");
    expect(cells).toHaveLength(42);
    expect(cells.findIndex((cell) => cell.key === "2026-08-01")).toBe(5);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("flattens and sorts targets while preserving the content version", () => {
    const entries = flattenCalendarEntries([
      { id: "later", version: 4, title: "Later", summary: "", status: "scheduled", targets: [{ id: "t2", platform: "youtube", accountId: "yt", draftId: "d2", status: "queued", scheduledFor: "2026-09-02T10:00:00.000Z" }] },
      { id: "first", version: 2, title: "First", summary: "", status: "scheduled", targets: [{ id: "t1", platform: "instagram", accountId: "ig", draftId: "d1", status: "queued", scheduledFor: "2026-09-01T10:00:00.000Z", timezone: "Asia/Kolkata" }] },
    ]);
    expect(entries.map((entry) => entry.contentId)).toEqual(["first", "later"]);
    expect(entries[0]).toMatchObject({ contentVersion: 2, target: { timezone: "Asia/Kolkata" } });
  });

  it("keeps a Facebook Page target distinct in the schedule", () => {
    const entries = flattenCalendarEntries([{ id: "page-post", version: 3, title: "Page update", summary: "", status: "scheduled", targets: [{ id: "fb-target", platform: "facebook", accountId: "page-123", draftId: "fb-draft", deliveryMode: "auto_publish", status: "queued", scheduledFor: "2026-09-03T10:00:00.000Z" }] }]);
    expect(entries[0]).toMatchObject({ target: { platform: "facebook", accountId: "page-123", deliveryMode: "auto_publish" } });
  });

  it("keeps month and list views on the same visible-month interval", () => {
    const entries = flattenCalendarEntries([
      { id: "september", title: "September", summary: "", status: "scheduled", targets: [{ id: "t1", platform: "instagram", accountId: "ig", draftId: "d1", status: "queued", scheduledFor: "2026-09-30T18:29:59.000Z" }] },
      { id: "october", title: "October", summary: "", status: "scheduled", targets: [{ id: "t2", platform: "instagram", accountId: "ig", draftId: "d2", status: "queued", scheduledFor: "2026-09-30T18:30:00.000Z" }] },
    ]);
    expect(calendarEntriesForMonth(entries, "2026-09", "Asia/Kolkata").map((entry) => entry.contentId)).toEqual(["september"]);
    expect(monthRangeInZone("2026-09", "Asia/Kolkata")).toEqual({ from: "2026-08-31T18:30:00.000Z", to: "2026-09-30T18:30:00.000Z" });
  });
});
