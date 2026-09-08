import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MediaService } from "./media.service.js";

@Injectable()
export class MediaLifecycleCoordinator implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MediaLifecycleCoordinator.name);
  private timer?: NodeJS.Timeout;
  constructor(private readonly media: MediaService, private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (this.config.get<boolean>("MEDIA_CLEANUP_ENABLED") === false) return;
    const intervalMinutes = Number(this.config.get<string>("MEDIA_CLEANUP_INTERVAL_MINUTES") ?? 15);
    this.timer = setInterval(() => { void this.run() }, intervalMinutes * 60_000);
    this.timer.unref();
    setTimeout(() => { void this.run() }, 250).unref();
  }

  private async run() {
    try {
      const result = await this.media.cleanupDue();
      if (result.checked > 0) this.logger.log(`Media cleanup checked=${result.checked} deleted=${result.deleted} expired=${result.expired} failed=${result.failed} skipped=${result.skipped}`);
    } catch (error) {
      this.logger.warn(`Media cleanup pass failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
