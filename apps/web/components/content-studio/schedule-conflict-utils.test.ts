import { describe, expect, it } from "vitest";
import { scheduleConflictHeadline, scheduleConflictReady } from "./schedule-conflict-utils";

describe("schedule conflict presentation", () => {
  it("keeps exact duplicates distinct from nearby-time warnings", () => {
    expect(scheduleConflictHeadline({ kinds: ["exact_content_duplicate", "account_time_overlap"], minutesApart: 30 })).toBe("Exact approved content is already scheduled nearby");
    expect(scheduleConflictHeadline({ kinds: ["exact_content_duplicate"], minutesApart: 1440 })).toBe("Exact approved content is already scheduled");
    expect(scheduleConflictHeadline({ kinds: ["account_time_overlap"], minutesApart: 15 })).toBe("Another post is scheduled nearby");
  });

  it("requires the exact current acknowledgement hash only when warnings exist", () => {
    expect(scheduleConflictReady(null, "")).toBe(false);
    expect(scheduleConflictReady({ requiresConfirmation: false, acknowledgementSha256: "clear" }, "")).toBe(true);
    expect(scheduleConflictReady({ requiresConfirmation: true, acknowledgementSha256: "current" }, "stale")).toBe(false);
    expect(scheduleConflictReady({ requiresConfirmation: true, acknowledgementSha256: "current" }, "current")).toBe(true);
  });
});
