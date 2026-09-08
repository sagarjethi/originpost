import { createHash } from "node:crypto";
import { creativeDimensions, type CreativeSpec } from "@originpost/domain";
import sharp from "sharp";

export const CREATIVE_TEMPLATE_VERSION = "originpost-templates-v1";
export const CREATIVE_FONT_VERSION = "noto-latin-gujarati-devanagari-v1";
// Output encoding is part of immutable render identity. Bump whenever the
// renderer changes bytes or MIME so an older ready asset cannot satisfy a new
// render request (Story images changed from PNG to provider-safe JPEG in v3).
export const CREATIVE_RENDERER_VERSION = `originpost-sharp-${sharp.versions.sharp}-vips-${sharp.versions.vips}-layout-v3-story-jpeg`;

export class CreativeRenderFailure extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = "CreativeRenderFailure";
  }
}

export interface RenderedCreativeImage {
  bytes: Buffer;
  width: number;
  height: number;
  contentType: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
  sha256: string;
  rendererVersion: string;
  templateVersion: string;
  fontVersion: string;
}

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function characterUnits(value: string): number {
  return [...value].reduce((total, character) => total + (/\p{Script=Latin}|[0-9.,:;!?'"()\-–—]/u.test(character) ? 0.55 : /\s/u.test(character) ? 0.3 : 0.72), 0);
}

export function wrapCreativeText(value: string, fontSize: number, maxWidth: number, maxLines: number, field: string): string[] {
  const paragraphs = value.normalize("NFC").trim().split(/\r?\n/u);
  const lines: string[] = [];
  const fits = (candidate: string) => characterUnits(candidate) * fontSize <= maxWidth;
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) continue;
    let current = "";
    for (const word of words) {
      if (!fits(word)) {
        const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)].map((entry) => entry.segment);
        let fragment = "";
        for (const grapheme of graphemes) {
          if (fragment && !fits(fragment + grapheme)) { if (current) { lines.push(current); current = ""; } lines.push(fragment); fragment = grapheme; }
          else fragment += grapheme;
        }
        if (fragment) { if (current) lines.push(current); current = fragment; }
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (fits(candidate)) current = candidate;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    if (lines.length > maxLines) break;
  }
  if (lines.length > maxLines) throw new CreativeRenderFailure(`${field}_overflow`, `${field[0]!.toUpperCase()}${field.slice(1)} does not fit this template. Shorten it or choose another layout.`, field);
  return lines;
}

function tspans(lines: string[], x: number, y: number, lineHeight: number): string {
  return lines.map((line, index) => `<tspan x="${x}" y="${Math.round(y + index * lineHeight)}">${xml(line)}</tspan>`).join("");
}

function textLayer(spec: CreativeSpec, width: number, height: number): string {
  const [background, panel, primary, accent, secondary] = spec.palette;
  const story = spec.format === "story";
  const margin = story ? 86 : 72;
  const maxWidth = spec.layout === "editorial" ? width * 0.58 - margin * 1.2 : width - margin * 2;
  const headlineSize = story ? 94 : spec.format === "portrait" ? 82 : 74;
  const subtitleSize = story ? 38 : 32;
  const kickerSize = story ? 25 : 22;
  const footerSize = story ? 24 : 20;
  const headlineLines = wrapCreativeText(spec.headline, headlineSize, maxWidth, spec.layout === "quote" ? 5 : 4, "headline");
  const subtitleLines = spec.subtitle ? wrapCreativeText(spec.subtitle, subtitleSize, maxWidth, 4, "subtitle") : [];
  const kickerLines = spec.kicker ? wrapCreativeText(spec.kicker, kickerSize, maxWidth, 2, "kicker") : [];
  const footerLines = spec.footer ? wrapCreativeText(spec.footer, footerSize, width - margin * 2, 2, "footer") : [];
  const fontFamily = spec.font === "newsreader"
    ? "Noto Serif Gujarati, Noto Serif Devanagari, Noto Serif, serif"
    : "Noto Sans Gujarati, Noto Sans Devanagari, Noto Sans, sans-serif";
  const anchor = spec.textAlign === "center" ? "middle" : "start";
  const x = spec.textAlign === "center" && spec.layout !== "editorial" ? width / 2 : margin;
  const headlineHeight = headlineLines.length * headlineSize * 1.08;
  const subtitleHeight = subtitleLines.length * subtitleSize * 1.32;
  const kickerHeight = kickerLines.length * kickerSize * 1.24;
  let startY: number;
  let panels: string;
  if (spec.layout === "editorial") {
    startY = height * 0.22;
    panels = `<rect width="${Math.round(width * 0.64)}" height="${height}" fill="${panel}" fill-opacity="0.94"/><rect x="${margin}" y="${Math.round(startY - 48)}" width="74" height="8" rx="4" fill="${accent}"/>`;
  } else if (spec.layout === "quote") {
    startY = height * 0.3;
    panels = `<rect x="${margin * 0.55}" y="${Math.round(height * 0.16)}" width="${Math.round(width - margin * 1.1)}" height="${Math.round(height * 0.68)}" rx="34" fill="${panel}" fill-opacity="0.9"/><text x="${margin}" y="${Math.round(height * 0.28)}" fill="${accent}" font-family="${fontFamily}" font-size="120" font-weight="800">“</text>`;
  } else {
    startY = height - margin - (footerLines.length ? footerLines.length * footerSize * 1.25 + 38 : 0) - subtitleHeight - (subtitleLines.length ? 28 : 0) - headlineHeight - kickerHeight - 55;
    panels = `<defs><linearGradient id="creativeShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${background}" stop-opacity="0"/><stop offset="0.43" stop-color="${panel}" stop-opacity="0.16"/><stop offset="1" stop-color="${panel}" stop-opacity="0.97"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#creativeShade)"/>`;
  }
  const requiredBottom = startY + kickerHeight + headlineHeight + subtitleHeight + 75 + footerLines.length * footerSize * 1.25;
  if (startY < margin || requiredBottom > height - margin / 2) throw new CreativeRenderFailure("layout_overflow", "The text layers do not fit this output size. Shorten the copy or choose another layout.", "headline");
  let cursor = startY;
  const kicker = kickerLines.length ? `<text text-anchor="${anchor}" fill="${accent}" font-family="${fontFamily}" font-size="${kickerSize}" font-weight="800" letter-spacing="2">${tspans(kickerLines, x, cursor, kickerSize * 1.24)}</text>` : "";
  cursor += kickerHeight + (kickerLines.length ? 25 : 0);
  const headline = `<text text-anchor="${anchor}" fill="${primary}" font-family="${fontFamily}" font-size="${headlineSize}" font-weight="800">${tspans(headlineLines, x, cursor, headlineSize * 1.08)}</text>`;
  cursor += headlineHeight + (subtitleLines.length ? 27 : 0);
  const subtitle = subtitleLines.length ? `<text text-anchor="${anchor}" fill="${secondary}" font-family="${fontFamily}" font-size="${subtitleSize}" font-weight="520">${tspans(subtitleLines, x, cursor, subtitleSize * 1.32)}</text>` : "";
  const footerY = height - margin;
  const footer = footerLines.length ? `<line x1="${margin}" x2="${width - margin}" y1="${Math.round(footerY - footerSize * footerLines.length * 1.35 - 18)}" y2="${Math.round(footerY - footerSize * footerLines.length * 1.35 - 18)}" stroke="${accent}" stroke-width="3"/><text text-anchor="${spec.textAlign === "center" ? "middle" : "start"}" fill="${secondary}" font-family="${fontFamily}" font-size="${footerSize}" font-weight="650">${tspans(footerLines, spec.textAlign === "center" ? width / 2 : margin, footerY - footerSize * (footerLines.length - 1) * 1.25, footerSize * 1.25)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${panels}${kicker}${headline}${subtitle}${footer}</svg>`;
}

export async function renderCreativeImage(spec: CreativeSpec, sourceBytes: Uint8Array): Promise<RenderedCreativeImage> {
  if (sourceBytes.byteLength < 1 || sourceBytes.byteLength > 64 * 1024 * 1024) throw new CreativeRenderFailure("source_size_invalid", "The source image must be between 1 byte and 64 MB.", "sourceMediaId");
  const { width, height } = creativeDimensions[spec.format];
  let normalized: Buffer;
  let sourceWidth: number;
  let sourceHeight: number;
  try {
    const result = await sharp(sourceBytes, { limitInputPixels: 100_000_000, failOn: "error" }).rotate().toBuffer({ resolveWithObject: true });
    normalized = result.data; sourceWidth = result.info.width; sourceHeight = result.info.height;
  } catch { throw new CreativeRenderFailure("source_image_invalid", "The selected source image could not be decoded safely.", "sourceMediaId") }
  const scale = Math.max(width / sourceWidth, height / sourceHeight) * spec.zoom;
  const cropWidth = Math.max(1, Math.min(sourceWidth, Math.round(width / scale)));
  const cropHeight = Math.max(1, Math.min(sourceHeight, Math.round(height / scale)));
  const left = Math.max(0, Math.min(sourceWidth - cropWidth, Math.round((sourceWidth - cropWidth) * spec.focalPoint.x / 100)));
  const top = Math.max(0, Math.min(sourceHeight - cropHeight, Math.round((sourceHeight - cropHeight) * spec.focalPoint.y / 100)));
  const background = await sharp(normalized, { limitInputPixels: 100_000_000 }).extract({ left, top, width: cropWidth, height: cropHeight }).resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  const overlay = Buffer.from(textLayer(spec, width, height), "utf8");
  let bytes: Buffer;
  try {
    const composed = sharp(background).composite([{ input: overlay, top: 0, left: 0 }]);
    bytes = spec.format === "story"
      ? await composed.jpeg({ quality: 95, chromaSubsampling: "4:4:4", optimiseCoding: true }).toBuffer()
      : await composed.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  }
  catch { throw new CreativeRenderFailure("text_render_failed", "The text layers could not be rendered with the bundled fonts.", "headline") }
  return {
    bytes,
    width,
    height,
    contentType: spec.format === "story" ? "image/jpeg" : "image/png",
    extension: spec.format === "story" ? "jpg" : "png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rendererVersion: CREATIVE_RENDERER_VERSION,
    templateVersion: CREATIVE_TEMPLATE_VERSION,
    fontVersion: CREATIVE_FONT_VERSION,
  };
}

export async function boundedObjectBytes(body: unknown, maximum = 64 * 1024 * 1024): Promise<Buffer> {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (body.byteLength > maximum) throw new CreativeRenderFailure("source_size_invalid", "The source image exceeds the safe byte limit.", "sourceMediaId");
    return Buffer.from(body);
  }
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) throw new CreativeRenderFailure("source_unavailable", "The source image bytes are unavailable.", "sourceMediaId");
  const chunks: Buffer[] = []; let total = 0;
  for await (const value of body as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(value); total += chunk.byteLength;
    if (total > maximum) throw new CreativeRenderFailure("source_size_invalid", "The source image exceeds the safe byte limit.", "sourceMediaId");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
