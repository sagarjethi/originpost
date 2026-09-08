import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OperationsHealthService } from "./operations-health.service.js";

@Injectable()
export class OperationsHealthCoordinator implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OperationsHealthCoordinator.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly health: OperationsHealthService, private readonly config: ConfigService) {}

  onApplicationBootstrap(): void {
    if (this.config.get<boolean>("OPERATIONS_HEALTH_ENABLED") === false) return;
    const minutes = Number(this.config.get<number>("OPERATIONS_HEALTH_INTERVAL_MINUTES") ?? 5);
    this.timer = setInterval(() => void this.run(), minutes * 60_000);
    this.timer.unref();
    void this.run();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.health.evaluateFleetAndAlert();
    } catch (error) {
      this.logger.error("Operational health evaluation failed.", error instanceof Error ? error.stack : undefined);
    } finally {
      this.running = false;
    }
  }
}
