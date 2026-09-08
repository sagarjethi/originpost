import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { AnalyticsReportController, PublicAnalyticsReportController } from "./analytics-report.controller.js";
import { AnalyticsReportService } from "./analytics-report.service.js";

@Module({ imports: [InfrastructureModule], controllers: [AnalyticsController, AnalyticsReportController, PublicAnalyticsReportController], providers: [AnalyticsService, AnalyticsReportService] })
export class AnalyticsModule {}
