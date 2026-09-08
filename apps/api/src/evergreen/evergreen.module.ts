import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { EvergreenController } from "./evergreen.controller.js";
import { EvergreenService } from "./evergreen.service.js";
@Module({imports:[InfrastructureModule],controllers:[EvergreenController],providers:[EvergreenService]})
export class EvergreenModule{}
