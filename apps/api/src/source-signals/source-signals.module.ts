import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { SourceSignalsController } from "./source-signals.controller.js";
import { SourceSignalsService } from "./source-signals.service.js";

@Module({ imports: [InfrastructureModule], controllers: [SourceSignalsController], providers: [SourceSignalsService] })
export class SourceSignalsModule {}
