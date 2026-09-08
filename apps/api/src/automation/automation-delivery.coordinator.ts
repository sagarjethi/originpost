import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AutomationService } from "./automation.service.js";

@Injectable()
export class AutomationDeliveryCoordinator implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AutomationDeliveryCoordinator.name); private timer?: NodeJS.Timeout; private running = false;
  constructor(private readonly automation: AutomationService, private readonly config: ConfigService) {}
  onModuleInit() {
    if (this.config.get<boolean>("AUTOMATION_DELIVERY_ENABLED") === false) return;
    const interval = Number(this.config.get<number>("AUTOMATION_DELIVERY_INTERVAL_SECONDS") ?? 5) * 1000;
    this.timer = setInterval(() => { void this.run() }, interval); this.timer.unref(); setTimeout(() => { void this.run() }, 500).unref();
  }
  private async run() { if (this.running) return; this.running = true; try { const result = await this.automation.deliverDue(); if (result.claimed) this.logger.log(`Webhook delivery claimed=${result.claimed}`) } catch (error) { this.logger.warn(`Webhook delivery pass failed: ${error instanceof Error ? error.message : "unknown error"}`) } finally { this.running = false } }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer) }
}
