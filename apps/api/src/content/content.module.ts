import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { ContentController } from "./content.controller.js";
import { ContentService } from "./content.service.js";
import { ReviewController } from "./review.controller.js";
import { ReviewTokenService } from "./review-token.service.js";
import { InstagramCollaboratorController } from "./instagram-collaborator.controller.js";
import { InstagramCollaboratorService } from "./instagram-collaborator.service.js";
import { AgentRuntimeModule } from "../agent-runtimes/agent-runtime.module.js";
import { InstagramGridController } from "./instagram-grid.controller.js";
import { InstagramGridService } from "./instagram-grid.service.js";

@Module({ imports: [InfrastructureModule, AgentRuntimeModule], controllers: [ContentController, ReviewController, InstagramCollaboratorController, InstagramGridController], providers: [ContentService, ReviewTokenService, InstagramCollaboratorService, InstagramGridService], exports: [ContentService] })
export class ContentModule {}
