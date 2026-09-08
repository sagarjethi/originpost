import { Module } from "@nestjs/common";
import { ContentModule } from "../content/content.module.js";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { AutomationController, PublicAutomationController } from "./automation.controller.js";
import { AutomationDeliveryCoordinator } from "./automation-delivery.coordinator.js";
import { AutomationKeyGuard } from "./automation-key.guard.js";
import { AutomationSecretVaultService } from "./automation-secret-vault.service.js";
import { AutomationService } from "./automation.service.js";

@Module({ imports: [InfrastructureModule, ContentModule], controllers: [AutomationController, PublicAutomationController], providers: [AutomationService, AutomationKeyGuard, AutomationSecretVaultService, AutomationDeliveryCoordinator], exports: [AutomationService] })
export class AutomationModule {}
