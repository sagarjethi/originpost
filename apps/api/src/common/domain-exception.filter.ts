import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import { DomainError } from "@originpost/domain";
import type { FastifyReply } from "fastify";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof DomainError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    const status = typeof error === "object" && error && "getStatus" in error
      ? (error as { getStatus(): number }).getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = typeof error === "object" && error && "getResponse" in error
      ? (error as { getResponse(): unknown }).getResponse()
      : { error: "internal_error", message: "Something went wrong." };
    void reply.status(status).send(response);
  }
}
