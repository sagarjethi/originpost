import { describe, expect, it } from "vitest";
import { validateMeasuredMedia } from "../src/index.js";

const image = { id: "image-1", type: "image" as const, inspectionStatus: "ready" as const, widthPixels: 1080, heightPixels: 1350 };
const video = { id: "video-1", type: "video" as const, inspectionStatus: "ready" as const, widthPixels: 1080, heightPixels: 1920, durationMs: 60_000 };
const storyImage = { ...image, mimeType: "image/jpeg", widthPixels: 1080, heightPixels: 1920, rights: "owned" as const };
const storyVideo = { ...video, rights: "cleared" as const };

describe("measured media policy", () => {
  it("fails closed when server measurement is missing", () => {
    expect(validateMeasuredMedia({ platform: "instagram", format: "image", media: [{ ...image, inspectionStatus: "unavailable" }] }))
      .toContainEqual(expect.objectContaining({ code: "media_inspection_required" }));
  });

  it("fails closed for infected or unscanned persisted media", () => {
    expect(validateMeasuredMedia({ platform: "instagram", format: "image", media: [{ ...image, malwareScanStatus: "infected" }] }))
      .toContainEqual(expect.objectContaining({ code: "media_malware_scan_required" }));
    expect(validateMeasuredMedia({ platform: "instagram", format: "image", media: [{ ...image, malwareScanStatus: "unavailable" }] }).map((entry) => entry.code))
      .toEqual(["media_malware_scan_required"]);
    expect(validateMeasuredMedia({ platform: "instagram", format: "image", media: [{ ...image, malwareScanStatus: "clean" }] })).toEqual([]);
    expect(validateMeasuredMedia({ platform: "instagram", format: "image", media: [{ ...image, malwareScanStatus: "disabled" }] })).toEqual([]);
  });

  it("accepts measured Instagram, Facebook, and YouTube release shapes", () => {
    expect(validateMeasuredMedia({ platform: "instagram", format: "image", media: [image] })).toEqual([]);
    expect(validateMeasuredMedia({ platform: "facebook", format: "image", media: [image] })).toEqual([]);
    expect(validateMeasuredMedia({ platform: "youtube", format: "short", media: [video] })).toEqual([]);
  });

  it("uses measured duration and orientation for the Shorts release contract", () => {
    expect(validateMeasuredMedia({ platform: "youtube", format: "short", media: [{ ...video, durationMs: 180_001, widthPixels: 1920, heightPixels: 1080 }] }).map((entry) => entry.code))
      .toEqual(["youtube_short_too_long", "youtube_short_not_vertical"]);
  });

  it("accepts one inspected, rights-cleared 9:16 Story image or 3–60 second video", () => {
    expect(validateMeasuredMedia({ platform: "instagram", format: "story", media: [storyImage] })).toEqual([]);
    expect(validateMeasuredMedia({ platform: "instagram", format: "story", media: [storyVideo] })).toEqual([]);
  });

  it("rejects Story count, type, inspection, rights, image MIME, aspect, and duration violations", () => {
    const codes = (media: Parameters<typeof validateMeasuredMedia>[0]["media"]) =>
      validateMeasuredMedia({ platform: "instagram", format: "story", media }).map((entry) => entry.code);

    expect(codes([])).toEqual(["instagram_story_media_required"]);
    expect(codes([storyImage, storyImage])).toEqual(["instagram_story_media_required"]);
    expect(codes([{ ...storyImage, inspectionStatus: "pending" }])).toEqual(["media_inspection_required"]);
    expect(codes([{ ...storyImage, rights: "reference-only" }])).toContain("instagram_story_rights_required");
    expect(codes([{ ...storyImage, mimeType: "image/png" }])).toContain("instagram_story_image_must_be_jpeg");
    expect(codes([{ ...storyImage, widthPixels: 1080, heightPixels: 1350 }])).toContain("instagram_story_aspect_ratio");
    expect(codes([{ ...storyVideo, durationMs: 2_999 }])).toContain("instagram_story_video_too_short");
    expect(codes([{ ...storyVideo, durationMs: 60_001 }])).toContain("instagram_story_video_too_long");
  });
});
