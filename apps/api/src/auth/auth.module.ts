import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module.js";
import { AuthController, AuthenticatedWorkspaceInvitationController, MembershipController, PublicWorkspaceInvitationController, WorkspaceInvitationController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { PasswordService } from "./password.service.js";
import { ConfigService } from "@nestjs/config";
import { OidcAuthService } from "./oidc-auth.service.js";
import { DisabledOidcProvider, DiscoveryOidcProvider, OIDC_PROVIDER } from "./oidc-provider.js";

@Module({
  imports: [InfrastructureModule],
  controllers: [AuthController, MembershipController, WorkspaceInvitationController, AuthenticatedWorkspaceInvitationController, PublicWorkspaceInvitationController],
  providers: [
    AuthService,
    PasswordService,
    OidcAuthService,
    {
      provide: OIDC_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const clientSecret = config.get<string>("OIDC_CLIENT_SECRET")?.trim();
        return config.get<boolean>("OIDC_ENABLED") === true
          ? new DiscoveryOidcProvider({
            issuer: config.get<string>("OIDC_ISSUER_URL")!,
            clientId: config.get<string>("OIDC_CLIENT_ID")!,
            ...(clientSecret ? { clientSecret } : {}),
            groupsClaim: config.get<string>("OIDC_GROUPS_CLAIM") ?? "groups",
            allowInsecureLoopback: config.get<string>("NODE_ENV") !== "production",
          })
          : new DisabledOidcProvider();
      },
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
