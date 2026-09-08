import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { BoardsController } from "./boards.controller.js";
import { BoardsService } from "./boards.service.js";

@Module({ imports: [InfrastructureModule], controllers: [BoardsController], providers: [BoardsService], exports: [BoardsService] })
export class BoardsModule {}
