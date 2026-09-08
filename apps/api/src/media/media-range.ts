import { HttpException, HttpStatus } from "@nestjs/common";
import type { ObjectByteRange } from "./media-object-store.js";

export class MediaRangeNotSatisfiableException extends HttpException {
  constructor(readonly totalLength: number) {
    super("Requested media range is not satisfiable.", HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  }
}

export function parseSingleByteRange(value: string, totalLength: number): ObjectByteRange {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match || totalLength <= 0) throw new MediaRangeNotSatisfiableException(totalLength);

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= totalLength) {
    throw new MediaRangeNotSatisfiableException(totalLength);
  }

  return { start, end: Math.min(requestedEnd, totalLength - 1) };
}
