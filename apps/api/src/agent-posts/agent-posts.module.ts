import { MediaModule } from "../media/media.module.js";
import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { ContentModule } from "../content/content.module.js";
import { ImageGenerationModule } from "../image-generation/image-generation.module.js";
import { CreativeStudioModule } from "../creative-studio/creative-studio.module.js";
import { AgentRuntimeModule } from "../agent-runtimes/agent-runtime.module.js";
import { AgentPostsService } from "./agent-posts.service.js";
import { AgentPostsController } from "./agent-posts.controller.js";
@Module({
  imports: [
    InfrastructureModule,
    MediaModule,
    ContentModule,
    ImageGenerationModule,
    CreativeStudioModule,
    AgentRuntimeModule,
  ],
  providers: [AgentPostsService],
  controllers: [AgentPostsController],
})
export class AgentPostsModule {}
