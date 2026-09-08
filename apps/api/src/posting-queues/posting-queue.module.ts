import { Module } from "@nestjs/common";
import { ContentModule } from "../content/content.module.js";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { PostingQueueController, ScheduleNextController } from "./posting-queue.controller.js";
import { PostingQueueService } from "./posting-queue.service.js";

@Module({ imports: [InfrastructureModule, ContentModule], controllers: [PostingQueueController, ScheduleNextController], providers: [PostingQueueService] })
export class PostingQueueModule {}
