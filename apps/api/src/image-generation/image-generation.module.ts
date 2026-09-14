import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { MediaModule } from "../media/media.module.js";
import { ImageGenerationController } from "./image-generation.controller.js";
import { ImageGenerationCoordinator } from "./image-generation.coordinator.js";
import { DisabledImageGenerationProvider, IMAGE_GENERATION_PROVIDER, OpenAIImageGenerationProvider } from "./image-generation.provider.js";
import { ImageGenerationService } from "./image-generation.service.js";

@Module({
  imports: [InfrastructureModule, MediaModule],
  controllers: [ImageGenerationController],
  exports: [ImageGenerationService],
  providers: [
    ImageGenerationService,
    ImageGenerationCoordinator,
    {
      provide: IMAGE_GENERATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const model = config.get<string>("OPENAI_IMAGE_MODEL")?.trim() || "gpt-image-2.5-sunburst";
        const mode = config.get<string>("IMAGE_GENERATION_MODE") ?? "disabled";
        const apiKey = config.get<string>("OPENAI_IMAGE_API_KEY")?.trim() || config.get<string>("OPENAI_API_KEY")?.trim() || "";
        if (mode !== "openai") return new DisabledImageGenerationProvider(model, "disabled");
        if (!apiKey) return new DisabledImageGenerationProvider(model, "credential_missing");
        const configuredTimeout = Number(config.get<string>("OPENAI_IMAGE_TIMEOUT_MS") ?? 180_000);
        return new OpenAIImageGenerationProvider({ apiKey, model, timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(10_000, Math.min(300_000, configuredTimeout)) : 180_000 });
      },
    },
  ],
})
export class ImageGenerationModule {}
