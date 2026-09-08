import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import {
  ConnectorRegistry,
  MetaPagePrivateConversationConnector,
  parseMetaPrivateMessagingGrant,
} from "@originpost/connectors";
import { InMemoryConnectedAccountRepository, InMemoryOAuthRepository, InMemoryOrganizationRepository, type AuditEvent, type ConnectedAccount } from "@originpost/domain";
import { InMemoryPrivateConversationRepository } from "@originpost/db";
import { describe, expect, it, vi } from "vitest";
import { ChannelOAuthService } from "../src/channels/channel-oauth.service.js";
import { CredentialVaultService } from "../src/channels/credential-vault.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

describe("Meta private-messaging re-consent", () => {
  it("re-consents an existing Page, binds an expiring grant, subscribes, initializes sync, and queues reconciliation", async () => {
    const oauthRepository = new InMemoryOAuthRepository();
    const connectedAccountRepository = new InMemoryConnectedAccountRepository(oauthRepository);
    const organizationRepository = new InMemoryOrganizationRepository();
    const privateConversationRepository = new InMemoryPrivateConversationRepository({ encryptionKey: Buffer.alloc(32, 0x31), hashKey: Buffer.alloc(32, 0x71) });
    const queueAdd = vi.fn(async () => ({ id: "queued" }));
    const config = new ConfigService({
      NODE_ENV: "test",
      OAUTH_TEST_MODE: "true",
      AUTH_MODE: "single-user",
      PRIVATE_MESSAGE_CONNECTOR_MODE: "official",
      META_APP_ID: "meta-app-123",
      META_APP_SECRET: "meta-app-secret",
      META_GRAPH_API_VERSION: "v26.0",
      META_PRIVATE_MESSAGING_APP_REVIEW_SHA256: "c".repeat(64),
      CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      API_PUBLIC_URL: "http://localhost:4000",
      WEB_PUBLIC_URL: "http://localhost:3000",
    });
    const partialInfrastructure = { oauthRepository, connectedAccountRepository, organizationRepository } as unknown as OriginPostInfrastructure;
    const vault = new CredentialVaultService(config, partialInfrastructure);
    const oldAt = "2026-09-01T10:00:00.000Z";
    const oldSecret = vault.seal("default", "provider-token", JSON.stringify({ accessToken: "old-page-token", tokenType: "bearer", provider: "facebook", externalAccountId: "test-facebook-page-1", scope: "pages_show_list pages_read_engagement pages_manage_posts pages_manage_engagement", issuedAt: oldAt, pageTasks: ["CREATE_CONTENT", "MODERATE"] }), oldAt);
    const account: ConnectedAccount = { id: "account-facebook-1", workspaceId: "default", brandId: "brand_default", platform: "facebook", displayName: "OAuth Test Facebook Page", externalAccountId: "test-facebook-page-1", credentialRef: `secret:${oldSecret.id}`, capabilities: ["page_read", "media_publish"], status: "healthy", createdBy: "owner", createdAt: oldAt, updatedAt: oldAt };
    const seedAudit: AuditEvent = { id: "audit-seed", workspaceId: "default", actorId: "owner", actorType: "human", action: "seed", detail: {}, createdAt: oldAt };
    await connectedAccountRepository.save(account, seedAudit, { save: oldSecret });

    const registry = new ConnectorRegistry();
    const subscriptionTransport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } }));
    registry.registerPrivateConversations(new MetaPagePrivateConversationConnector({
      connectionMode: "facebook_page_messenger",
      apiVersion: "v26.0",
      appId: "meta-app-123",
      appSecret: "meta-app-secret",
      environment: "test",
      baseUrl: "https://graph.facebook.test",
      fetch: subscriptionTransport,
      resolveCredential: async (request) => {
        const current = (await connectedAccountRepository.get(request.workspaceId, request.accountId))!;
        const value = JSON.parse(await vault.open(request.workspaceId, current.credentialRef!.slice(7))) as Record<string, unknown>;
        const grant = parseMetaPrivateMessagingGrant(value.privateMessagingGrant);
        return { externalBusinessAccountId: current.externalAccountId, endpointPageId: current.externalAccountId, accessToken: value.accessToken as string, scopes: String(value.scope).split(" "), pageTasks: value.pageTasks as string[], credentialVersion: value.issuedAt as string, accountVersion: current.updatedAt, ...(grant ? { messagingGrant: grant } : {}) };
      },
    }));
    const infrastructure = { ...partialInfrastructure, privateConversationRepository, privateConversationQueue: { add: queueAdd }, connectors: registry } as unknown as OriginPostInfrastructure;
    const service = new ChannelOAuthService(infrastructure, config, vault);
    const actor = { id: "owner", name: "Owner", role: "owner" as const };

    const started = await service.startMetaMessaging("default", "brand_default", actor);
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("auth_type")).toBe("rerequest");
    expect(authorization.searchParams.get("scope")).toContain("pages_messaging");
    expect(authorization.searchParams.get("scope")).toContain("instagram_manage_messages");
    const state = authorization.searchParams.get("state")!;
    const callback = await service.callbackMetaMessaging({ state, code: "originpost-meta-messaging-oauth-test-code" });
    const selectionId = new URL(callback.redirectUrl).searchParams.get("selectionId")!;
    const selection = await service.getMetaMessagingSelection("default", selectionId, actor);
    expect(selection.candidates).toEqual([expect.objectContaining({ accountId: account.id, connectionMode: "facebook_page_messenger", targetKey: "facebook_page_messenger:test-facebook-page-1" })]);
    expect(JSON.stringify(selection)).not.toContain("token");

    const completed = await service.completeMetaMessagingSelection("default", selectionId, ["facebook_page_messenger:test-facebook-page-1"], actor);
    expect(completed).toMatchObject({ connected: true, accounts: [{ accountId: account.id, connectionMode: "facebook_page_messenger", capabilities: expect.arrayContaining(["private_message_read", "private_message_send"]) }] });
    const current = (await connectedAccountRepository.get("default", account.id))!;
    const stored = JSON.parse(await vault.open("default", current.credentialRef!.slice(7))) as Record<string, unknown>;
    expect(stored.accessToken).toBe("test-meta-messaging-page-token-never-returned");
    expect(parseMetaPrivateMessagingGrant(stored.privateMessagingGrant)).toMatchObject({ accountId: account.id, appId: "meta-app-123", connectionMode: "facebook_page_messenger", appReviewReferenceSha256: "c".repeat(64) });
    await expect(privateConversationRepository.getSyncState({ workspaceId: "default", brandId: "brand_default" }, account.id)).resolves.toMatchObject({ connectionMode: "facebook_page_messenger", accountId: account.id });
    expect(subscriptionTransport).toHaveBeenCalledOnce();
    expect(queueAdd).toHaveBeenCalledWith("sync-account", expect.objectContaining({ accountId: account.id }), expect.objectContaining({ attempts: 3 }));
  });
});
