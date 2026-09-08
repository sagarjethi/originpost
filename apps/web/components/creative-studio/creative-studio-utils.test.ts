import { describe, expect, it } from "vitest";
import { buildCreativeSpec, canEditCreative, creativeDimensions, creativeDraftTarget, defaultCreativeSpec, isCreativeSource, type CreativeMediaAsset } from "./creative-studio-utils";

const readyImage: CreativeMediaAsset = {
  id: "media-1",
  kind: "image",
  fileName: "source.png",
  contentType: "image/png",
  sizeBytes: 2048,
  sha256: "a".repeat(64),
  status: "ready",
  inspectionStatus: "ready",
  rights: "owned",
};

describe("Creative Studio web contract", () => {
  it("uses the exact platform dimensions", () => {
    expect(creativeDimensions).toEqual({
      square: { width: 1080, height: 1080, label: "Square" },
      portrait: { width: 1080, height: 1350, label: "Portrait" },
      story: { width: 1080, height: 1920, label: "Story" },
    });
  });

  it("only exposes ready, inspected, rights-cleared images with a hash", () => {
    expect(isCreativeSource(readyImage)).toBe(true);
    expect(isCreativeSource({ ...readyImage, kind: "video" })).toBe(false);
    expect(isCreativeSource({ ...readyImage, inspectionStatus: "pending" })).toBe(false);
    expect(isCreativeSource({ ...readyImage, rights: "reference-only" })).toBe(false);
    expect(isCreativeSource({ ...readyImage, sha256: "missing" })).toBe(false);
  });

  it("builds a strict normalized snapshot with uppercase palette colors", () => {
    const result = buildCreativeSpec({
      ...defaultCreativeSpec,
      sourceMediaId: readyImage.id,
      sourceMediaSha256: readyImage.sha256.toUpperCase(),
      contentItemId: "  content-1  ",
      kicker: "  NEWS  ",
      headline: "  Exact headline  ",
      subtitle: " ",
      zoom: 3,
      focalPoint: { x: -1, y: 120 },
      palette: ["#2f3a34", "#f5f0e7", "#d86c4f", "#d5a94e", "#ffffff"],
    });

    expect(result).toMatchObject({
      sourceMediaSha256: readyImage.sha256,
      contentItemId: "content-1",
      kicker: "NEWS",
      headline: "Exact headline",
      zoom: 2,
      focalPoint: { x: 0, y: 100 },
      palette: ["#2F3A34", "#F5F0E7", "#D86C4F", "#D5A94E", "#FFFFFF"],
    });
    expect("subtitle" in result).toBe(false);
  });

  it("keeps viewers read-only while allowing creator roles", () => {
    expect(canEditCreative("viewer")).toBe(false);
    expect(canEditCreative("creator")).toBe(true);
    expect(canEditCreative("manager")).toBe(true);
    expect(canEditCreative("owner")).toBe(true);
  });

  it("routes Story renders only to Instagram Story drafts", () => {
    expect(creativeDraftTarget("story", "facebook")).toEqual({ platform: "instagram", format: "story" });
    expect(creativeDraftTarget("portrait", "facebook")).toEqual({ platform: "facebook", format: "image" });
    expect(creativeDraftTarget("square", "instagram")).toEqual({ platform: "instagram", format: "image" });
  });
});
