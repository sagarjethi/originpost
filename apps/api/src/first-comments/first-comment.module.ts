import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { FirstCommentController } from "./first-comment.controller.js";
import { FirstCommentService } from "./first-comment.service.js";
@Module({imports:[InfrastructureModule],controllers:[FirstCommentController],providers:[FirstCommentService]})
export class FirstCommentModule{}
