import "reflect-metadata";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { PublicDraftDto, PublicScheduleDto } from "../src/automation/automation.dto.js";

describe("automation Instagram Story contract", () => {
  it("accepts Story drafts and manual or automatic schedules through the public DTOs", async () => {
    const draft = Object.assign(new PublicDraftDto(), {
      platform: "instagram",
      format: "story",
      title: "Mumbai event",
      caption: "Internal Story review note",
      mediaIds: ["media-story-1"],
    });
    expect(await validate(draft)).toEqual([]);

    for (const deliveryMode of ["manual_handoff", "auto_publish"] as const) {
      const schedule = Object.assign(new PublicScheduleDto(), {
        platform: "instagram",
        accountId: "ig-main",
        draftId: "draft-story-1",
        scheduledFor: "2099-01-01T00:00:00.000Z",
        deliveryMode,
      });
      expect(await validate(schedule)).toEqual([]);
    }
  });
});
