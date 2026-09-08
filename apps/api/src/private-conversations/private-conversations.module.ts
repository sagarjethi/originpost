import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { PrivateConversationsController } from "./private-conversations.controller.js";
import { PrivateConversationsService } from "./private-conversations.service.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [PrivateConversationsController],
  providers: [PrivateConversationsService],
})
export class PrivateConversationsModule {}
