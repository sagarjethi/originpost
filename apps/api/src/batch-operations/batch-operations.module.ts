import { Module } from "@nestjs/common";
import { ContentModule } from "../content/content.module.js";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { BatchOperationsController } from "./batch-operations.controller.js";
import { BatchOperationsService } from "./batch-operations.service.js";
@Module({ imports: [InfrastructureModule, ContentModule], controllers: [BatchOperationsController], providers: [BatchOperationsService] })
export class BatchOperationsModule {}
