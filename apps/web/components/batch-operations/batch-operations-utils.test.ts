import { describe, expect, it } from "vitest";
import { addBatchMinutes, buildBatchRows, cleanBatchFileStem } from "./batch-operations-utils";

describe("batch operations row builder", () => {
  it("builds stable Instagram rows with interval scheduling", () => {
    const rows = buildBatchRows([
      { id: "media_1", fileName: "first_launch.png", kind: "image" },
      { id: "media_2", fileName: "second-launch.mp4", kind: "video" },
    ], { batchName: "Mumbai Launch", platform: "instagram", captionTemplate: "See {filename}", accountId: "ig-main", startAtIso: "2026-09-02T04:00:00.000Z", intervalMinutes: 45, timezone: "Asia/Kolkata", riskLevel: "low", madeForKids: false, containsSyntheticMedia: false });
    expect(rows).toMatchObject([
      { externalRef: "mumbai-launch:media_1", title: "first launch", format: "image", caption: "See first launch", scheduledFor: "2026-09-02T04:00:00.000Z" },
      { externalRef: "mumbai-launch:media_2", title: "second launch", format: "reel", scheduledFor: "2026-09-02T04:45:00.000Z" },
    ]);
  });

  it("keeps draft-only rows unscheduled and binds YouTube declarations only when publishing", () => {
    const draft = buildBatchRows([{ id: "clip", fileName: "Short.mov", kind: "video" }], { batchName: "Shorts", platform: "youtube", captionTemplate: "{filename}", startAtIso: "2026-09-02T04:00:00.000Z", intervalMinutes: 60, timezone: "UTC", riskLevel: "sensitive", madeForKids: true, containsSyntheticMedia: true })[0]!;
    expect(draft).toMatchObject({ format: "short", riskLevel: "sensitive" });
    expect(draft).not.toHaveProperty("scheduledFor");
    expect(draft).not.toHaveProperty("youtubeSettings");
    const scheduled = buildBatchRows([{ id: "clip", fileName: "Short.mov", kind: "video" }], { batchName: "Shorts", platform: "youtube", captionTemplate: "{filename}", accountId: "yt", startAtIso: "2026-09-02T04:00:00.000Z", intervalMinutes: 60, timezone: "UTC", riskLevel: "low", madeForKids: true, containsSyntheticMedia: true })[0]!;
    expect(scheduled.youtubeSettings).toEqual({ privacyStatus: "private", madeForKids: true, containsSyntheticMedia: true, notifySubscribers: false });
  });

  it("normalizes file labels and time arithmetic", () => {
    expect(cleanBatchFileStem("  city_update-final.png")).toBe("city update final");
    expect(addBatchMinutes("2026-09-02T04:00:00.000Z", 90)).toBe("2026-09-02T05:30:00.000Z");
  });
});
