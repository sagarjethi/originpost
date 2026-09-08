import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateMeasuredMedia, type CreativeSpec } from "@originpost/domain";
import { boundedObjectBytes, CreativeRenderFailure, renderCreativeImage } from "../src/creative-studio/creative-renderer.js";

const palette: CreativeSpec["palette"] = ["#303A36", "#1E2623", "#FFFFFF", "#D1AA7B", "#E6EEE9"];

async function source() {
  return sharp({ create: { width: 1400, height: 1000, channels: 3, background: "#8FAD96" } }).png().toBuffer();
}

function spec(format: CreativeSpec["format"], overrides: Partial<CreativeSpec> = {}): CreativeSpec {
  return {
    format,
    sourceMediaId: "media_source",
    sourceMediaSha256: "a".repeat(64),
    headline: "મુંબઈમાં નવી શરૂઆત · नई शुरुआत · Built with proof",
    subtitle: "One source image becomes an exact, reviewable social rendition.",
    kicker: "ORIGINPOST CREATIVE",
    footer: "Owned media · deterministic render",
    layout: "headline",
    font: "manrope",
    textAlign: "left",
    focalPoint: { x: 50, y: 50 },
    zoom: 1,
    palette,
    ...overrides,
  };
}

describe("creative renderer", () => {
  it.each([
    ["square", 1080, 1080, "png", "image/png", "png"],
    ["portrait", 1080, 1350, "png", "image/png", "png"],
    ["story", 1080, 1920, "jpeg", "image/jpeg", "jpg"],
  ] as const)("renders an exact provider-compatible %s image", async (format, width, height, imageFormat, contentType, extension) => {
    const rendered = await renderCreativeImage(spec(format), await source());
    const metadata = await sharp(rendered.bytes).metadata();
    expect(metadata).toMatchObject({ format: imageFormat, width, height });
    expect(rendered).toMatchObject({ contentType, extension });
    expect(rendered.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 15_000);

  it("is byte deterministic for one source, spec, and renderer version", async () => {
    const bytes = await source();
    const deterministicSpec = spec("portrait", { layout: "editorial", font: "newsreader", headline: "મુંબઈ · मुंबई · Mumbai", subtitle: "Exact multilingual output." });
    const first = await renderCreativeImage(deterministicSpec, bytes);
    const second = await renderCreativeImage(deterministicSpec, bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });

  it("produces a Story JPEG accepted by the measured provider policy", async () => {
    const rendered = await renderCreativeImage(spec("story"), await source());
    expect(validateMeasuredMedia({ platform: "instagram", format: "story", media: [{ id: "rendered-story", type: "image", mimeType: rendered.contentType, inspectionStatus: "ready", widthPixels: rendered.width, heightPixels: rendered.height, rights: "owned" }] })).toEqual([]);
  });

  it("fails visibly instead of clipping an overflowing headline", async () => {
    await expect(renderCreativeImage(spec("square", { headline: "Longwordwithoutbreak".repeat(15), layout: "editorial" }), await source()))
      .rejects.toMatchObject<Partial<CreativeRenderFailure>>({ code: "headline_overflow", field: "headline" });
  });

  it("bounds streamed source bytes", async () => {
    const body = (async function* () { yield Buffer.alloc(4); yield Buffer.alloc(5); })();
    await expect(boundedObjectBytes(body, 8)).rejects.toMatchObject({ code: "source_size_invalid" });
  });
});
