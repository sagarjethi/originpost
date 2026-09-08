import { Controller, Get, Headers, HttpCode, HttpStatus, Post, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { Public } from "../common/public.decorator.js";
import { InstagramWebhookQueryDto } from "./dto/engagement.dto.js";
import { InstagramWebhookService } from "./instagram-webhook.service.js";

type RawFastifyRequest = FastifyRequest & { rawBody?: Buffer };

@Public()
@Controller({ path: "channels/webhooks/instagram", version: "1" })
export class InstagramWebhookController {
  constructor(private readonly webhooks: InstagramWebhookService) {}

  @Get()
  verify(@Query() query: InstagramWebhookQueryDto) {
    return this.webhooks.verify(query["hub.mode"], query["hub.challenge"], query["hub.verify_token"]);
  }

  @Post() @HttpCode(HttpStatus.OK)
  receive(@Req() request: RawFastifyRequest, @Headers("x-hub-signature-256") signature?: string) {
    return this.webhooks.receive(request.rawBody, signature);
  }
}
