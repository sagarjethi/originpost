import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { MediaRangeNotSatisfiableException } from "./media-range.js";

@Catch(MediaRangeNotSatisfiableException)
export class MediaRangeNotSatisfiableFilter implements ExceptionFilter<MediaRangeNotSatisfiableException> {
  catch(exception: MediaRangeNotSatisfiableException, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply
      .status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
      .header("accept-ranges", "bytes")
      .header("content-range", `bytes */${exception.totalLength}`)
      .header("cache-control", "private, no-store")
      .send({
        statusCode: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        message: exception.message,
      });
  }
}
