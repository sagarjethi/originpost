import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { ProviderLifecycleController } from "./provider-lifecycle.controller.js";
import { ProviderLifecycleService } from "./provider-lifecycle.service.js";

@Module({ imports: [InfrastructureModule], controllers: [ProviderLifecycleController], providers: [ProviderLifecycleService], exports: [ProviderLifecycleService] })
export class ProviderLifecycleModule {}
