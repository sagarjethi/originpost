import { describe, expect, it } from "vitest";
import { BoundedMediaInspector } from "../src/media/media-inspector.js";
import { memoryFixtureFor } from "../src/media/memory-media-fixtures.js";

describe("bounded server media inspector", () => {
  it("measures a real PNG from its bytes", async () => {
    const bytes = memoryFixtureFor("image/png");
    const result = await new BoundedMediaInspector().inspect({ kind: "image", contentType: "image/png", sizeBytes: bytes.byteLength }, bytes);
    expect(result).toMatchObject({ status: "ready", detectedContentType: "image/png", widthPixels: 16, heightPixels: 16, inspector: "sharp/v1" });
  });

  it("measures a real MP4 with bounded ffprobe", async () => {
    const bytes = memoryFixtureFor("video/mp4");
    const result = await new BoundedMediaInspector({ timeoutMs: 5_000 }).inspect({ kind: "video", contentType: "video/mp4", sizeBytes: bytes.byteLength }, bytes);
    expect(result).toMatchObject({ status: "ready", detectedContentType: "video/mp4", widthPixels: 16, heightPixels: 16, durationMs: 1000, inspector: "ffprobe/v1" });
  });

  it("separates a missing inspection tool from an invalid file", async () => {
    const bytes = memoryFixtureFor("video/mp4");
    const unavailable = await new BoundedMediaInspector({ ffprobePath: "originpost-missing-ffprobe" }).inspect({ kind: "video", contentType: "video/mp4", sizeBytes: bytes.byteLength }, bytes);
    const failed = await new BoundedMediaInspector().inspect({ kind: "image", contentType: "image/png", sizeBytes: 4 }, Buffer.from("nope"));
    expect(unavailable).toMatchObject({ status: "unavailable", errorCode: "inspector_unavailable" });
    expect(failed).toMatchObject({ status: "failed", errorCode: "invalid_image" });
  });

  it("rejects unsupported image containers instead of routing them through optional parsers", async () => {
    const icnsHeader = Buffer.from([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 8]);
    const result = await new BoundedMediaInspector({ timeoutMs: 1_000 }).inspect(
      { kind: "image", contentType: "image/png", sizeBytes: icnsHeader.byteLength },
      icnsHeader,
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_image", inspector: "sharp/v1" });
  });
});
