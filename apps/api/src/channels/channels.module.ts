import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { ChannelsController } from "./channels.controller.js";
import { ChannelsService } from "./channels.service.js";
import { ConnectionDoctorService } from "./connection-doctor.service.js";
import { ChannelOAuthController } from "./channel-oauth.controller.js";
import { ChannelOAuthService } from "./channel-oauth.service.js";
import { CredentialVaultService } from "./credential-vault.service.js";

@Module({ imports: [InfrastructureModule], controllers: [ChannelsController, ChannelOAuthController], providers: [ChannelsService, ConnectionDoctorService, ChannelOAuthService, CredentialVaultService] })
export class ChannelsModule {}
