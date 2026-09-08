import { describe, expect, it } from "vitest";
import { instagramGridDate, instagramGridStatusLabel, instagramGridStatusTone } from "./instagram-grid-utils";

describe("Instagram grid utilities", () => {
  it("uses honest workflow labels and tones", () => {
    expect(instagramGridStatusLabel("queued")).toBe("Scheduled");
    expect(instagramGridStatusLabel("action_required")).toBe("Needs action");
    expect(instagramGridStatusTone("published")).toBe("live");
    expect(instagramGridStatusTone("action_required")).toBe("attention");
  });

  it("does not invent a date for malformed records", () => {
    expect(instagramGridDate("not-a-date")).toBe("Date unavailable");
  });
});
