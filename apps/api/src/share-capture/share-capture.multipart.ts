import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CapturedMultipartFile } from "./share-capture.service.js";
import type { ShareTargetInputDto } from "./share-capture.dto.js";

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_FIELD_BYTES = 16 * 1024;

const mimeContract = new Map<string, { kind: "image" | "video"; extensions: ReadonlySet<string>; maxBytes: number }>([
  ["image/jpeg", { kind: "image", extensions: new Set([".jpg", ".jpeg"]), maxBytes: MAX_IMAGE_BYTES }],
  ["image/png", { kind: "image", extensions: new Set([".png"]), maxBytes: MAX_IMAGE_BYTES }],
  ["image/webp", { kind: "image", extensions: new Set([".webp"]), maxBytes: MAX_IMAGE_BYTES }],
  ["image/gif", { kind: "image", extensions: new Set([".gif"]), maxBytes: MAX_IMAGE_BYTES }],
  ["video/mp4", { kind: "video", extensions: new Set([".mp4"]), maxBytes: MAX_VIDEO_BYTES }],
  ["video/quicktime", { kind: "video", extensions: new Set([".mov"]), maxBytes: MAX_VIDEO_BYTES }],
  ["video/webm", { kind: "video", extensions: new Set([".webm"]), maxBytes: MAX_VIDEO_BYTES }],
]);

function extension(fileName: string): string {
  const leaf = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const index = leaf.lastIndexOf(".");
  return index >= 0 ? leaf.slice(index).toLowerCase() : "";
}

export interface ParsedShareTargetMultipart {
  dto: ShareTargetInputDto;
  file?: CapturedMultipartFile;
  cleanup(): Promise<void>;
}

export async function parseShareTargetMultipart(request: FastifyRequest): Promise<ParsedShareTargetMultipart> {
  if (!request.isMultipart()) throw new BadRequestException("Use a valid multipart/form-data request with a boundary.");
  const fields: Record<string, string> = {};
  let captured: Omit<CapturedMultipartFile, "body"> & { path: string } | undefined;
  let directory: string | undefined;
  try {
    const parts = request.parts({ limits: { files: 2, fields: 8, parts: 12, fileSize: MAX_VIDEO_BYTES, fieldSize: MAX_FIELD_BYTES } });
    for await (const part of parts) {
      if (part.type === "field") {
        if (!["title", "text", "url"].includes(part.fieldname) || Object.hasOwn(fields, part.fieldname)) throw new BadRequestException("The mobile share contains an unsupported or repeated field.");
        if (typeof part.value !== "string") throw new BadRequestException("The mobile share text fields are invalid.");
        fields[part.fieldname] = part.value;
        continue;
      }
      if (part.fieldname !== "media" || captured) {
        part.file.resume();
        throw new BadRequestException("Share exactly one photo or video in the media field.");
      }
      const contract = mimeContract.get(part.mimetype.toLowerCase());
      if (!contract || !contract.extensions.has(extension(part.filename))) {
        part.file.resume();
        throw new BadRequestException("The shared file name and declared media type are not supported.");
      }
      directory = await mkdtemp(join(tmpdir(), "originpost-share-"));
      const path = join(directory, randomUUID());
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const bounded = new Transform({
        transform(chunk: Buffer | Uint8Array, _encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          sizeBytes += bytes.byteLength;
          if (sizeBytes > contract.maxBytes) { callback(new Error("shared_file_too_large")); return }
          hash.update(bytes);
          callback(null, bytes);
        },
      });
      try { await pipeline(part.file, bounded, createWriteStream(path, { flags: "wx", mode: 0o600 })) }
      catch (error) {
        if (String(error).includes("shared_file_too_large") || part.file.truncated) throw new BadRequestException(`The shared ${contract.kind} exceeds the safe intake limit.`);
        throw new BadRequestException("The shared file upload was interrupted.");
      }
      if (part.file.truncated) throw new BadRequestException(`The shared ${contract.kind} exceeds the safe intake limit.`);
      if (sizeBytes < 1) throw new BadRequestException("The shared file is empty.");
      captured = { kind: contract.kind, fileName: part.filename, contentType: part.mimetype.toLowerCase(), sizeBytes, sha256: hash.digest("hex"), path };
    }
    const dto: ShareTargetInputDto = { ...(fields.title ? { title: fields.title } : {}), ...(fields.text ? { text: fields.text } : {}), ...(fields.url ? { url: fields.url } : {}) };
    return {
      dto,
      ...(captured ? { file: { kind: captured.kind, fileName: captured.fileName, contentType: captured.contentType, sizeBytes: captured.sizeBytes, sha256: captured.sha256, body: createReadStream(captured.path) } } : {}),
      cleanup: async () => { if (directory) await rm(directory, { recursive: true, force: true }) },
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export const shareTargetMediaAccept = [...mimeContract.entries()].flatMap(([mime, value]) => [mime, ...value.extensions]);
