import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { MonitoringController } from "./monitoring.controller.js";
import { MonitoringService } from "./monitoring.service.js";

@Module({ imports: [InfrastructureModule], controllers: [MonitoringController], providers: [MonitoringService] })
export class MonitoringModule {}
