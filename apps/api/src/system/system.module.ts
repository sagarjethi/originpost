import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { MediaModule } from "../media/media.module.js";
import { OperationsHealthCoordinator } from "./operations-health.coordinator.js";
import { OperationsHealthService } from "./operations-health.service.js";
import { SystemController } from "./system.controller.js";
import { SystemService } from "./system.service.js";
@Module({ imports: [InfrastructureModule, MediaModule], controllers: [SystemController], providers: [SystemService, OperationsHealthService, OperationsHealthCoordinator] })
export class SystemModule {}
