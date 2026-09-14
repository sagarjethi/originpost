import { describe, expect, it } from "vitest";
import { getHelpJourney, HELP_JOURNEYS } from "./help-journeys";

describe("help journeys", () => {
  it("covers the four primary OriginPost jobs without duplicate destinations", () => {
    expect(HELP_JOURNEYS.map((journey) => journey.id)).toEqual(["publish", "image", "board", "channels"]);
    expect(new Set(HELP_JOURNEYS.map((journey) => journey.action.destination)).size).toBe(HELP_JOURNEYS.length);
  });

  it("keeps generated-image review and disclosure in the journey", () => {
    const image = getHelpJourney("image");
    expect(image.capability).toBe("runtime");
    expect(image.steps.map((step) => step.label)).toEqual(["Brief", "Generate", "Finish", "Check", "Disclose", "Attach"]);
    expect(image.summary).toContain("visual layer");
  });

  it("describes Hermes as Board-internal and human-reviewed", () => {
    const board = getHelpJourney("board");
    expect(board.capability).toBe("available");
    expect(board.summary).toContain("internal helper");
    expect(board.steps.find((step) => step.label === "Release")?.detail).toContain("manager or owner");
    expect(board.steps.find((step) => step.label === "Work")?.detail).toContain("approved memory and skills");
    expect(board.steps.find((step) => step.label === "Review")?.detail).toContain("separately");
  });
});
