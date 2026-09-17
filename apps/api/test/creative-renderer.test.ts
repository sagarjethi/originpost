import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateMeasuredMedia, type CreativeSpec } from "@originpost/domain";
import { boundedObjectBytes, CreativeRenderFailure, wrapCreativeText, renderCreativeImage } from "../src/creative-studio/creative-renderer.js";

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

it("places original logo pixels at the selected corner and rejects changed bytes", async () => {
  const { createHash } = await import("node:crypto");
  const logo = await sharp({create:{width:80,height:40,channels:3,background:"#FF0000"}}).png().toBuffer();
  const configured = spec("portrait", {headline:"Library opens",logo:{mediaId:"logo",sha256:createHash("sha256").update(logo).digest("hex"),position:"top-left",widthPercent:15,marginPercent:3,background:"#FFFFFF",crop:"full"}});
  const rendered = await renderCreativeImage(configured,await source(),logo);
  const pixel = await sharp(rendered.bytes).extract({left:55,top:55,width:1,height:1}).removeAlpha().raw().toBuffer();
  expect([...pixel]).toEqual([255,0,0]);
  await expect(renderCreativeImage(configured,await source(),Buffer.from("changed"))).rejects.toMatchObject({code:"logo_hash_mismatch"});
});

it("keeps Story branding below the top control area and text above the bottom controls", async()=>{
  const {createHash}=await import("node:crypto");
  const logo=await sharp({create:{width:80,height:40,channels:3,background:"#FF0000"}}).png().toBuffer();
  const input=await source();
  const base=spec("story",{layout:"headline-top",headline:"નમૂનાનું શીર્ષક",subtitle:"",kicker:"",footer:"@examplepublisher",disclosure:"AI દ્વારા બનાવેલ પ્રતીકાત્મક તસવીર"});
  const branded=await renderCreativeImage({...base,logo:{mediaId:"logo",sha256:createHash("sha256").update(logo).digest("hex"),position:"top-left",widthPercent:20,marginPercent:2,background:"#FFFFFF",crop:"full"}},input,logo);
  const pixel=await sharp(branded.bytes).extract({left:150,top:250,width:1,height:1}).removeAlpha().raw().toBuffer();
  expect(pixel[0]).toBeGreaterThan(240);expect(pixel[1]).toBeLessThan(15);
  const plain=await renderCreativeImage(base,input);
  const top=(bytes:Buffer)=>sharp(bytes).extract({left:0,top:0,width:1080,height:210}).raw().toBuffer();
  expect(await top(branded.bytes)).toEqual(await top(plain.bytes));
  const noFooter=await renderCreativeImage({...base,footer:""},input);
  const bottom=(bytes:Buffer)=>sharp(bytes).extract({left:0,top:1600,width:1080,height:320}).raw().toBuffer();
  expect(await bottom(plain.bytes)).toEqual(await bottom(noFooter.bytes));
});

it("wraps Gujarati words without treating dependent vowel marks as full letters",()=>{
 expect(wrapCreativeText("અહીં સમાચારનું શીર્ષક",94,840,3,"headline")).toEqual(["અહીં સમાચારનું","શીર્ષક"]);
});
it("fits a short Gujarati news headline within three large top-headline lines", async () => {
  const rendered = await renderCreativeImage(spec("story", {layout:"headline-top",headline:"NASAના 10 અવકાશયાત્રી ઉમેદવારોની તાલીમ ચાલુ",subtitle:"",kicker:""}), await source());
  expect(await sharp(rendered.bytes).metadata()).toMatchObject({width:1080,height:1920});
  await expect(renderCreativeImage(spec("story", {layout:"headline-top",headline:"Longwordwithoutbreak".repeat(15),subtitle:"",kicker:""}),await source())).rejects.toMatchObject({code:"headline_overflow"});
});
it("keeps the source picture out of the top headline and footer panels", async () => {
  const config = spec("story", {layout:"headline-top",headline:"Training update",subtitle:"",kicker:""});
  const solid = (background:string) => sharp({create:{width:1024,height:1536,channels:3,background}}).png().toBuffer();
  const red = await renderCreativeImage(config,await solid("#ff0000"));
  const blue = await renderCreativeImage(config,await solid("#0000ff"));
  const region = (bytes:Buffer,top:number,height:number) => sharp(bytes).extract({left:0,top,width:1080,height}).raw().toBuffer();
  expect((await region(red.bytes,0,640)).equals(await region(blue.bytes,0,640))).toBe(true);
  expect((await region(red.bytes,1600,320)).equals(await region(blue.bytes,1600,320))).toBe(true);
  expect((await region(red.bytes,1000,200)).equals(await region(blue.bytes,1000,200))).toBe(false);
});
