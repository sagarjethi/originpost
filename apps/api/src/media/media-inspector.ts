import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { MediaAsset } from "@originpost/domain";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;

export type MediaInspectionResult =
  | { status: "ready"; detectedContentType: string; widthPixels: number; heightPixels: number; durationMs?: number | undefined; inspectedAt: string; inspector: string }
  | { status: "not_applicable"; inspectedAt: string; inspector: string }
  | { status: "unavailable" | "failed"; inspectedAt: string; inspector: string; errorCode: string; errorSummary: string };

export interface MediaInspector {
  inspect(asset: Pick<MediaAsset, "kind" | "contentType" | "sizeBytes">, body: unknown): Promise<MediaInspectionResult>;
}

export const MEDIA_INSPECTOR = Symbol("MEDIA_INSPECTOR");

class InspectionFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly unavailable = false) {
    super(message);
    this.name = "InspectionFailure";
  }
}

function readableFrom(body: unknown): Readable {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Readable.from([body]);
  if (body && typeof body === "object" && Symbol.asyncIterator in body) return Readable.from(body as AsyncIterable<Uint8Array>);
  throw new InspectionFailure("media_body_unavailable", "Stored media bytes could not be read.");
}

async function boundedBuffer(body: unknown, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const readable = readableFrom(body);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      readable.destroy();
      reject(new InspectionFailure("inspection_timeout", "Media inspection exceeded its time limit."));
    }, timeoutMs);
  });
  const consume = (async () => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of readable) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        readable.destroy();
        throw new InspectionFailure("inspection_input_too_large", "This file is too large for safe metadata inspection.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  })();
  try { return await Promise.race([consume, timeout]) }
  finally { if (timer) clearTimeout(timer) }
}

const imageMimeByType: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

type FfprobeBody = {
  streams?: Array<{ width?: unknown; height?: unknown; duration?: unknown }>;
  format?: { duration?: unknown; format_name?: unknown };
};

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function videoContentType(formatName: unknown): string | null {
  if (typeof formatName !== "string") return null;
  const names = new Set(formatName.toLowerCase().split(","));
  if (names.has("webm")) return "video/webm";
  if (names.has("mov") && !names.has("mp4")) return "video/quicktime";
  if (names.has("mp4") || names.has("mov")) return "video/mp4";
  return null;
}

export class BoundedMediaInspector implements MediaInspector {
  constructor(private readonly options: {
    ffprobePath?: string;
    timeoutMs?: number;
    maxImageBytes?: number;
    maxVideoBytes?: number;
  } = {}) {}

  async inspect(asset: Pick<MediaAsset, "kind" | "contentType" | "sizeBytes">, body: unknown): Promise<MediaInspectionResult> {
    const inspectedAt = new Date().toISOString();
    if (asset.kind !== "image" && asset.kind !== "video") return { status: "not_applicable", inspectedAt, inspector: "originpost/not-applicable-v1" };
    try {
      return asset.kind === "image"
        ? { ...await this.inspectImage(asset, body), inspectedAt }
        : { ...await this.inspectVideo(asset, body), inspectedAt };
    } catch (error) {
      const failure = error instanceof InspectionFailure
        ? error
        : new InspectionFailure("inspection_failed", "The stored file could not be inspected safely.");
      return {
        status: failure.unavailable ? "unavailable" : "failed",
        inspectedAt,
        inspector: asset.kind === "image" ? "sharp/v1" : "ffprobe/v1",
        errorCode: failure.code,
        errorSummary: failure.message.slice(0, 240),
      };
    }
  }

  private async inspectImage(asset: Pick<MediaAsset, "contentType" | "sizeBytes">, body: unknown) {
    const maxBytes = this.options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    if (asset.sizeBytes > maxBytes) throw new InspectionFailure("inspection_input_too_large", "This image is too large for safe metadata inspection.");
    const bytes = await boundedBuffer(body, maxBytes, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let dimensions;
    try {
      dimensions = await sharp(bytes, {
        failOn: "warning",
        limitInputPixels: MAX_IMAGE_PIXELS,
        limitInputChannels: 5,
        unlimited: false,
      }).timeout({ seconds: Math.max(1, Math.ceil((this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)) }).metadata();
    }
    catch { throw new InspectionFailure("invalid_image", "The stored file is not a supported, readable image.") }
    const widthPixels = dimensions.width;
    const heightPixels = dimensions.height;
    const detectedContentType = dimensions.format ? imageMimeByType[dimensions.format] : undefined;
    if (!widthPixels || !heightPixels || !detectedContentType) throw new InspectionFailure("invalid_image_metadata", "The image dimensions or format could not be measured.");
    if (widthPixels * heightPixels > MAX_IMAGE_PIXELS) throw new InspectionFailure("image_pixel_limit", "The image exceeds the safe 100-megapixel inspection limit.");
    if (detectedContentType !== asset.contentType.toLowerCase()) throw new InspectionFailure("content_type_mismatch", "The image bytes do not match the declared content type.");
    return { status: "ready" as const, detectedContentType, widthPixels, heightPixels, inspector: "sharp/v1" };
  }

  private async inspectVideo(asset: Pick<MediaAsset, "contentType" | "sizeBytes">, body: unknown) {
    const maxBytes = this.options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES;
    if (asset.sizeBytes > maxBytes) throw new InspectionFailure("inspection_input_too_large", "This video is too large for safe metadata inspection.");
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const executable = this.options.ffprobePath ?? "ffprobe";
    const source = readableFrom(body);
    const child = spawn(executable, [
      "-v", "error", "-threads", "1", "-probesize", "10000000", "-analyzeduration", "10000000",
      "-select_streams", "v:0", "-show_entries", "stream=width,height,duration:format=duration,format_name", "-of", "json", "-i", "pipe:0",
    ], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let output = Buffer.alloc(0);
    let stderrBytes = 0;
    let inputBytes = 0;
    let unavailable = false;
    let overflow = false;
    let timedOut = false;
    child.on("error", (error: NodeJS.ErrnoException) => { unavailable = error.code === "ENOENT" });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.byteLength + chunk.byteLength > MAX_TOOL_OUTPUT_BYTES) { overflow = true; source.destroy(); child.kill("SIGKILL"); return }
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_TOOL_OUTPUT_BYTES) { overflow = true; source.destroy(); child.kill("SIGKILL") }
    });
    source.on("data", (chunk: Buffer | Uint8Array) => {
      inputBytes += chunk.byteLength;
      if (inputBytes > maxBytes) { overflow = true; source.destroy(); child.kill("SIGKILL") }
    });
    source.on("error", () => child.stdin.destroy());
    child.stdin.on("error", () => undefined);
    source.pipe(child.stdin);
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { timedOut = true; source.destroy(); child.kill("SIGKILL") }, timeoutMs);
      child.once("close", (code) => { clearTimeout(timer); source.destroy(); resolve(code) });
      child.once("error", () => { clearTimeout(timer); source.destroy(); resolve(null) });
    });
    if (unavailable) throw new InspectionFailure("inspector_unavailable", "Video inspection is unavailable because ffprobe is not installed.", true);
    if (timedOut) throw new InspectionFailure("inspection_timeout", "Video inspection exceeded its time limit.");
    if (overflow) throw new InspectionFailure("inspection_resource_limit", "Video inspection exceeded a safe resource limit.");
    if (exitCode !== 0) throw new InspectionFailure("invalid_video", "The stored file is not a supported, readable video.");
    let value: FfprobeBody;
    try { value = JSON.parse(output.toString("utf8")) as FfprobeBody }
    catch { throw new InspectionFailure("invalid_inspector_output", "Video inspection returned an invalid result.") }
    const stream = value.streams?.[0];
    const width = positiveNumber(stream?.width);
    const height = positiveNumber(stream?.height);
    const durationSeconds = positiveNumber(stream?.duration) ?? positiveNumber(value.format?.duration);
    const detectedContentType = videoContentType(value.format?.format_name);
    if (!width || !height || !durationSeconds || !detectedContentType) throw new InspectionFailure("invalid_video_metadata", "The video dimensions, duration, or format could not be measured.");
    const declared = asset.contentType.toLowerCase();
    const compatible = declared === detectedContentType
      || declared === "video/quicktime" && detectedContentType === "video/mp4"
      || declared === "video/mp4" && detectedContentType === "video/quicktime";
    if (!compatible) throw new InspectionFailure("content_type_mismatch", "The video bytes do not match the declared content type.");
    return {
      status: "ready" as const,
      detectedContentType,
      widthPixels: Math.round(width),
      heightPixels: Math.round(height),
      durationMs: Math.max(1, Math.round(durationSeconds * 1000)),
      inspector: "ffprobe/v1",
    };
  }
}
