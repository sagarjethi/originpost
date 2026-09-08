import { describe, expect, it } from "vitest";
import { MemoryMediaObjectStore } from "../src/media/media-object-store.js";
import { MediaRangeNotSatisfiableException, parseSingleByteRange } from "../src/media/media-range.js";

describe("provider media byte ranges", () => {
  it("accepts one bounded or open-ended range and clamps the end", () => {
    expect(parseSingleByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseSingleByteRange("bytes=6-", 10)).toEqual({ start: 6, end: 9 });
    expect(parseSingleByteRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
  });

  it.each([
    "bytes=-5",
    "bytes=5-4",
    "bytes=10-",
    "bytes=0-1,4-5",
    "items=0-1",
    "bytes=9007199254740992-",
  ])("rejects unsupported or unsatisfiable range %s", (value) => {
    expect(() => parseSingleByteRange(value, 10)).toThrow(MediaRangeNotSatisfiableException);
  });

  it("asks the object store for only the selected bytes", async () => {
    const result = await new MemoryMediaObjectStore().read("private/object", { start: 4, end: 7 });
    expect(result.contentLength).toBe(4);
    expect(result.body).toEqual(Buffer.alloc(4));
  });

  it("moves a verified upload onto a hash-bound finalized key", async () => {
    const store = new MemoryMediaObjectStore();
    const finalized = await store.finalize({ objectKey: "workspace/pending/video.mp4", contentType: "video/mp4", sizeBytes: 4, sha256: "a".repeat(64) });
    expect(finalized.objectKey).toBe(`workspace/pending/video.mp4.final-${"a".repeat(64)}`);
  });
});
