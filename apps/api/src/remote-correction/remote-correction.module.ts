import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { RemoteCorrectionController } from "./remote-correction.controller.js";
import { RemoteCorrectionService } from "./remote-correction.service.js";
@Module({imports:[InfrastructureModule],controllers:[RemoteCorrectionController],providers:[RemoteCorrectionService]})
export class RemoteCorrectionModule {}
