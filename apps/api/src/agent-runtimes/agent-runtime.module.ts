import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { AgentRuntimeController } from "./agent-runtime.controller.js";
import { AgentRuntimeService } from "./agent-runtime.service.js";
@Module({imports:[InfrastructureModule],controllers:[AgentRuntimeController],providers:[AgentRuntimeService],exports:[AgentRuntimeService]})
export class AgentRuntimeModule{}
