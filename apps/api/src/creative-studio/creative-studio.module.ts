import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { MediaModule } from "../media/media.module.js";
import { CreativeRenderCoordinator } from "./creative-render.coordinator.js";
import { CreativeStudioController } from "./creative-studio.controller.js";
import { CreativeStudioService } from "./creative-studio.service.js";

@Module({ imports: [InfrastructureModule, MediaModule], controllers: [CreativeStudioController], providers: [CreativeStudioService, CreativeRenderCoordinator], exports: [CreativeStudioService] })
export class CreativeStudioModule {}
