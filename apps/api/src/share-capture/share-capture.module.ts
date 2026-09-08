import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { MediaModule } from "../media/media.module.js";
import { ShareCaptureController } from "./share-capture.controller.js";
import { ShareCaptureService } from "./share-capture.service.js";

@Module({ imports: [InfrastructureModule, MediaModule], controllers: [ShareCaptureController], providers: [ShareCaptureService] })
export class ShareCaptureModule {}
