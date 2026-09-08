import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { InMemoryConnectedAccountRepository, InMemoryOAuthRepository, InMemoryOrganizationRepository } from "@originpost/domain";
import { describe, expect, it } from "vitest";
import { ChannelOAuthService } from "../src/channels/channel-oauth.service.js";
import { CredentialVaultService } from "../src/channels/credential-vault.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

describe("Facebook Page analytics consent", () => {
  it("requests read_insights and grants analytics only to a Page with ANALYZE", async () => {
    const oauthRepository = new InMemoryOAuthRepository();
    const connectedAccountRepository = new InMemoryConnectedAccountRepository(oauthRepository);
    const organizationRepository = new InMemoryOrganizationRepository();
    const infrastructure = { oauthRepository, connectedAccountRepository, organizationRepository } as unknown as OriginPostInfrastructure;
    const config = new ConfigService({
      NODE_ENV: "test",
      OAUTH_TEST_MODE: "true",
      FACEBOOK_ANALYTICS_CONNECTOR_MODE: "official",
      META_APP_ID: "app-1",
      META_APP_SECRET: "app-secret",
      META_GRAPH_API_VERSION: "v26.0",
      CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      API_PUBLIC_URL: "http://localhost:4000",
      WEB_PUBLIC_URL: "http://localhost:3000",
    });
    const vault = new CredentialVaultService(config, infrastructure);
    const service = new ChannelOAuthService(infrastructure, config, vault);
    const actor = { id: "owner", name: "Owner", role: "owner" as const };

    const started = await service.startFacebook("default", "brand_default", actor);
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("scope")?.split(",")).toContain("read_insights");
    const callback = await service.callbackFacebook({ state: authorization.searchParams.get("state")!, code: "originpost-facebook-oauth-test-code" });
    const selectionId = new URL(callback.redirectUrl).searchParams.get("selectionId")!;
    const completed = await service.completeFacebookSelection("default", selectionId, ["test-facebook-page-1"], actor);
    expect(completed.accounts[0]?.capabilities).toContain("analytics_read");
    const account = (await connectedAccountRepository.list("default", "brand_default")).find((entry) => entry.externalAccountId === "test-facebook-page-1")!;
    const stored = JSON.parse(await vault.open("default", account.credentialRef!.slice(7))) as { scope: string; pageTasks: string[] };
    expect(stored.scope.split(" ")).toContain("read_insights");
    expect(stored.pageTasks).toContain("ANALYZE");
  });
});
