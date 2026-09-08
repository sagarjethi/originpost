import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { OrganizationsController } from "./organizations.controller.js";
import { OrganizationsService } from "./organizations.service.js";

@Module({ imports: [InfrastructureModule], controllers: [OrganizationsController], providers: [OrganizationsService] })
export class OrganizationsModule {}
