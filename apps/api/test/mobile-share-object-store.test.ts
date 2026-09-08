import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryMediaObjectStore } from "../src/media/media-object-store.js";

async function body(value: Buffer): Promise<AsyncIterable<Uint8Array>> {
  return (async function* () { yield value.subarray(0, 2); yield value.subarray(2) })();
}

describe("mobile Share Capture object storage", () => {
  it("verifies streamed quarantine bytes and promotes only the exact receipt", async () => {
    const store = new MemoryMediaObjectStore();
    const bytes = Buffer.from("real captured bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await store.writeCaptured({ objectKey: "workspace/quarantine/receipt", contentType: "image/png", sizeBytes: bytes.byteLength, sha256 }, await body(bytes));
    await store.promoteCaptured("workspace/quarantine/receipt", { objectKey: "workspace/final/asset", contentType: "image/png", sizeBytes: bytes.byteLength, sha256 });
    const stored = await store.read("workspace/final/asset");
    expect(Buffer.from(stored.body as Uint8Array)).toEqual(bytes);
    expect(stored).toMatchObject({ contentType: "image/png", contentLength: bytes.byteLength });
  });

  it("does not retain a quarantine object when the observed hash changes", async () => {
    const store = new MemoryMediaObjectStore();
    const bytes = Buffer.from("changed bytes");
    await expect(store.writeCaptured({ objectKey: "workspace/quarantine/bad", contentType: "image/png", sizeBytes: bytes.byteLength, sha256: "a".repeat(64) }, await body(bytes))).rejects.toThrow(/bytes changed/u);
    expect((await store.read("workspace/quarantine/bad")).contentLength).toBe(0);
  });
});
