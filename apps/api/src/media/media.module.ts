import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { MediaController } from "./media.controller.js";
import { MediaRangeNotSatisfiableFilter } from "./media-range.filter.js";
import { MediaService } from "./media.service.js";
import { MediaLifecycleCoordinator } from "./media-lifecycle.coordinator.js";
import { BoundedMediaInspector, MEDIA_INSPECTOR } from "./media-inspector.js";
import { ClamAvInstreamScanner, DisabledMediaMalwareScanner, MEDIA_MALWARE_SCANNER } from "./media-malware-scanner.js";
import { MediaOrganizationController } from "./media-organization.controller.js";
import { MediaOrganizationService } from "./media-organization.service.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [MediaController, MediaOrganizationController],
  providers: [
    MediaService,
    MediaOrganizationService,
    MediaLifecycleCoordinator,
    MediaRangeNotSatisfiableFilter,
    {
      provide: MEDIA_INSPECTOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const configuredTimeout = Number(config.get<string>("MEDIA_INSPECTION_TIMEOUT_MS") ?? 15_000);
        return new BoundedMediaInspector({
          ffprobePath: config.get<string>("MEDIA_FFPROBE_PATH") ?? "ffprobe",
          timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(1_000, Math.min(configuredTimeout, 60_000)) : 15_000,
        });
      },
    },
    {
      provide: MEDIA_MALWARE_SCANNER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if ((config.get<string>("MEDIA_MALWARE_SCAN_MODE") ?? "disabled") !== "clamav") return new DisabledMediaMalwareScanner();
        return new ClamAvInstreamScanner({
          host: config.get<string>("MEDIA_CLAMAV_HOST") ?? "clamav",
          port: Number(config.get<string>("MEDIA_CLAMAV_PORT") ?? 3310),
          timeoutMs: Number(config.get<string>("MEDIA_MALWARE_SCAN_TIMEOUT_MS") ?? 120_000),
          maxBytes: Number(config.get<string>("MEDIA_MALWARE_SCAN_MAX_BYTES") ?? 512 * 1024 * 1024),
          signatureMaxAgeHours: Number(config.get<string>("MEDIA_CLAMAV_SIGNATURE_MAX_AGE_HOURS") ?? 48),
        });
      },
    },
  ],
  exports: [MediaService, MEDIA_MALWARE_SCANNER],
})
export class MediaModule {}
