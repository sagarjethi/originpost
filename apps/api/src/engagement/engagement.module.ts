import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { EngagementController } from "./engagement.controller.js";
import { EngagementService } from "./engagement.service.js";
import { FacebookWebhookController } from "./facebook-webhook.controller.js";
import { FacebookWebhookService } from "./facebook-webhook.service.js";
import { InstagramWebhookController } from "./instagram-webhook.controller.js";
import { InstagramWebhookService } from "./instagram-webhook.service.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [EngagementController, InstagramWebhookController, FacebookWebhookController],
  providers: [EngagementService, InstagramWebhookService, FacebookWebhookService],
})
export class EngagementModule {}
