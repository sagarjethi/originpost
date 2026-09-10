import { Inject, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HermesAgentProvider, HermesBoardPlugin } from "@originpost/agents";
import { createSafeConnectorRegistry, decodeCredentialEncryptionKey, FacebookPageOfficialConnector, InstagramOfficialConnector, MetaPagePrivateConversationConnector, openEncryptedCredential, parseMetaPrivateMessagingGrant, YouTubeOfficialConnector } from "@originpost/connectors";
import type { ConnectedAccountRepository, OAuthRepository } from "@originpost/domain";
import { createContentRepository } from "@originpost/db";
import { Queue } from "bullmq";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "./infrastructure.types.js";
import { MemoryMediaObjectStore, S3MediaObjectStore } from "../media/media-object-store.js";
import { instagramCollaboratorProbe, resolveInstagramFacebookPublishingCredential } from "../channels/instagram-facebook-credential.js";

function redisConnection(urlValue: string) {
  const url = new URL(urlValue);
  return { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: url.password } : {}), ...(url.username ? { username: url.username } : {}) };
}

function connectorRegistry(config: ConfigService,accounts:ConnectedAccountRepository,oauth:OAuthRepository) {
  const privateConversationMode = config.get<string>("PRIVATE_MESSAGE_CONNECTOR_MODE") ?? "disabled";
  const registry = createSafeConnectorRegistry({
    privateConversationMode,
    nodeEnv: config.get<string>("NODE_ENV") ?? "development",
  });
  const key=decodeCredentialEncryptionKey(config.get<string>("CREDENTIAL_ENCRYPTION_KEY"));
  const payload=async(workspaceId:string,accountId:string)=>{const account=await accounts.get(workspaceId,accountId);if(!account||!key)throw new Error("Provider correction credential is unavailable.");const id=account.credentialRef?.startsWith("secret:")?account.credentialRef.slice(7):undefined;if(!id)throw new Error("Reconnect the provider account.");const record=await oauth.getCredential(workspaceId,id);if(!record)throw new Error("Provider correction credential is unavailable.");return{account,value:JSON.parse(openEncryptedCredential(record,key)) as Record<string,unknown>};};
  const instagramMode = config.get<string>("INSTAGRAM_CONNECTOR_MODE") ?? config.get<string>("CONNECTOR_MODE") ?? "mock";
  const facebookMode = config.get<string>("FACEBOOK_CONNECTOR_MODE") ?? "mock";
  const youtubeMode = config.get<string>("YOUTUBE_CONNECTOR_MODE") ?? "mock";
  if (privateConversationMode === "official") {
    const apiVersion = config.get<string>("META_GRAPH_API_VERSION");
    const appId = config.get<string>("META_APP_ID");
    const appSecret = config.get<string>("META_APP_SECRET");
    if (!apiVersion || !appId || !appSecret || !key) throw new Error("Official Meta private messaging requires META_GRAPH_API_VERSION, META_APP_ID, META_APP_SECRET, and CREDENTIAL_ENCRYPTION_KEY.");
    const environment = (config.get<string>("NODE_ENV") ?? "development") as "production" | "development" | "test";
    registry.registerPrivateConversations(new MetaPagePrivateConversationConnector({
      connectionMode: "facebook_page_messenger", apiVersion, appId, appSecret, environment,
      resolveCredential: async (request) => {
        const { account, value } = await payload(request.workspaceId, request.accountId);
        const scopes = typeof value.scope === "string" ? value.scope.split(/[\s,]+/u).filter(Boolean) : [];
        const pageTasks = Array.isArray(value.pageTasks) && value.pageTasks.every((task) => typeof task === "string") ? value.pageTasks as string[] : [];
        if (account.platform !== "facebook" || account.status !== "healthy" || value.provider !== "facebook" || value.externalAccountId !== account.externalAccountId || typeof value.accessToken !== "string" || typeof value.issuedAt !== "string" || !account.capabilities.includes("private_message_read") || !account.capabilities.includes("private_message_send")) throw new Error("The Facebook Page messaging credential is unavailable or requires re-consent.");
        return { externalBusinessAccountId: account.externalAccountId, endpointPageId: account.externalAccountId, accessToken: value.accessToken, scopes, pageTasks, credentialVersion: value.issuedAt, accountVersion: account.updatedAt, ...(parseMetaPrivateMessagingGrant(value.privateMessagingGrant) ? { messagingGrant: parseMetaPrivateMessagingGrant(value.privateMessagingGrant)! } : {}) };
      },
    }));
    registry.registerPrivateConversations(new MetaPagePrivateConversationConnector({
      connectionMode: "instagram_linked_page", apiVersion, appId, appSecret, environment,
      resolveCredential: async (request) => {
        const { account, value } = await payload(request.workspaceId, request.accountId);
        const scopes = Array.isArray(value.grantedScopes) && value.grantedScopes.every((scope) => typeof scope === "string") ? value.grantedScopes as string[] : typeof value.scope === "string" ? value.scope.split(/[\s,]+/u).filter(Boolean) : [];
        const pageTasks = Array.isArray(value.pageTasks) && value.pageTasks.every((task) => typeof task === "string") ? value.pageTasks as string[] : [];
        if (account.platform !== "instagram" || account.status !== "healthy" || value.provider !== "instagram" || value.connectionMode !== "facebook_login" || value.externalAccountId !== account.externalAccountId || typeof value.pageId !== "string" || typeof value.accessToken !== "string" || typeof value.issuedAt !== "string" || !account.capabilities.includes("private_message_read") || !account.capabilities.includes("private_message_send")) throw new Error("The linked Instagram messaging credential is unavailable or requires re-consent.");
        return { externalBusinessAccountId: account.externalAccountId, endpointPageId: value.pageId, accessToken: value.accessToken, scopes, pageTasks, credentialVersion: value.issuedAt, accountVersion: account.updatedAt, ...(parseMetaPrivateMessagingGrant(value.privateMessagingGrant) ? { messagingGrant: parseMetaPrivateMessagingGrant(value.privateMessagingGrant)! } : {}) };
      },
    }));
  }
  if (instagramMode === "official") {
    const apiVersion = config.get<string>("META_GRAPH_API_VERSION");
    const appId = config.get<string>("META_APP_ID");
    if (!apiVersion) throw new Error("Official Instagram mode requires META_GRAPH_API_VERSION.");
    const callbackUrl=`${(config.get<string>("API_PUBLIC_URL")??"http://localhost:4000").replace(/\/$/,"")}/v1/channels/oauth/instagram-facebook/callback`;
    registry.register(new InstagramOfficialConnector({ apiVersion, resolveCredential: async (request) => {const {account,value}=await payload(request.workspaceId,request.accountId);if(account.platform!=="instagram"||account.status!=="healthy")throw new Error("Instagram access needs attention before use.");if(value.connectionMode==="facebook_login"){if(!appId)throw new Error("Instagram Facebook Login credential cannot be used without the bound Meta app.");return resolveInstagramFacebookPublishingCredential(value,account,{appId,providerVersion:apiVersion,callbackUrl,probe:instagramCollaboratorProbe(config,apiVersion)});}if(value.provider!=="instagram"||value.externalAccountId!==account.externalAccountId||typeof value.accessToken!=="string")throw new Error("Instagram credential does not match the account.");if(account.expiresAt&&(typeof value.expiresAt!=="string"||value.expiresAt!==account.expiresAt||Date.parse(account.expiresAt)<=Date.now()+60_000))throw new Error("Instagram access renewal is pending.");const accountType=value.accountType==="BUSINESS"||value.accountType==="MEDIA_CREATOR"?value.accountType:undefined;return{externalAccountId:account.externalAccountId,accessToken:value.accessToken,...(value.connectionMode==="instagram_login"?{connectionMode:value.connectionMode}:{}),...(accountType?{accountType}:{}),...(typeof value.scope==="string"?{scope:value.scope}:{}),...(typeof value.publisherUsername==="string"?{username:value.publisherUsername}:{})};} }));
  }
  if (facebookMode === "official") {
    const apiVersion = config.get<string>("META_GRAPH_API_VERSION");
    const appSecret = config.get<string>("META_APP_SECRET");
    if (!apiVersion || !appSecret) throw new Error("Official Facebook Page mode requires META_GRAPH_API_VERSION and META_APP_SECRET.");
    const probeApiVersion = config.get<string>("FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_API_VERSION");
    const probeVerifiedAt = config.get<string>("FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT");
    const facebookAnalyticsMode = config.get<string>("FACEBOOK_ANALYTICS_CONNECTOR_MODE") ?? "disabled";
    registry.register(new FacebookPageOfficialConnector({
      apiVersion,
      appSecret,
      ...(config.get<string>("META_APP_ID")?{appId:config.get<string>("META_APP_ID")!}:{}),environment:(config.get<string>("NODE_ENV")??"development") as "production"|"development"|"test",
      ...(probeApiVersion && probeVerifiedAt ? { commentReplyContractProbe: { apiVersion: probeApiVersion, verifiedAt: probeVerifiedAt } } : {}),
      ...(facebookAnalyticsMode === "official" ? { analyticsContractProbe: {
        apiVersion: config.get<string>("FACEBOOK_ANALYTICS_CONTRACT_PROBE_API_VERSION")!,
        appId: config.get<string>("META_APP_ID")!,
        appReviewSha256: config.get<string>("FACEBOOK_ANALYTICS_APP_REVIEW_SHA256")!,
        resultSha256: config.get<string>("FACEBOOK_ANALYTICS_CONTRACT_PROBE_RESULT_SHA256")!,
        verifiedAt: config.get<string>("FACEBOOK_ANALYTICS_CONTRACT_PROBE_VERIFIED_AT")!,
        expiresAt: config.get<string>("FACEBOOK_ANALYTICS_CONTRACT_PROBE_EXPIRES_AT")!,
      } } : {}),
      ...(config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_API_VERSION")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_VERIFIED_AT")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXPIRES_AT")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_ID")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXTERNAL_PAGE_ID")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_CREDENTIAL_VERSION")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_VERSION")&&config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_PAGE_TASKS_SHA256")&&config.get<string>("META_APP_ID")?{pageDeleteContractProbe:{apiVersion:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_API_VERSION")!,verifiedAt:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_VERIFIED_AT")!,expiresAt:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXPIRES_AT")!,environment:(config.get<string>("NODE_ENV")??"development") as "production"|"development"|"test",appId:config.get<string>("META_APP_ID")!,accountId:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_ID")!,externalPageId:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXTERNAL_PAGE_ID")!,credentialVersion:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_CREDENTIAL_VERSION")!,accountVersion:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_VERSION")!,pageTasksSha256:config.get<string>("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_PAGE_TASKS_SHA256")!,task:"page_post_delete" as const}}:{}),
      resolveCredential: async (request) => {const {account,value}=await payload(request.workspaceId,request.accountId);if(account.status!=="healthy"||value.provider!=="facebook"||value.externalAccountId!==account.externalAccountId||typeof value.accessToken!=="string")throw new Error("Facebook credential does not match the Page or needs attention.");return{externalAccountId:account.externalAccountId,accessToken:value.accessToken,...(typeof value.scope==="string"?{scope:value.scope}:{}),...(Array.isArray(value.pageTasks)&&value.pageTasks.every((task)=>typeof task==="string")?{pageTasks:value.pageTasks as string[]}:{}),...(typeof value.issuedAt==="string"?{credentialVersion:value.issuedAt}:{}),accountVersion:account.updatedAt};},
    }));
  }
  if (youtubeMode === "official") {
    registry.register(new YouTubeOfficialConnector({ resolveCredential: async (request) => {const {account,value}=await payload(request.workspaceId,request.accountId);if(account.platform!=="youtube"||account.status!=="healthy"||value.provider!=="youtube"||value.externalAccountId!==account.externalAccountId||typeof value.accessToken!=="string"||typeof value.refreshToken!=="string"||typeof value.expiresAt!=="string"||value.expiresAt!==account.expiresAt||Date.parse(value.expiresAt)<=Date.now()+60_000)throw new Error("YouTube access renewal is pending or the channel must be reconnected.");return{externalAccountId:account.externalAccountId,accessToken:value.accessToken,...(typeof value.scope==="string"?{scope:value.scope}:{})};} }));
  }
  return registry;
}

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.infrastructure.researchQueue?.close(),
      this.infrastructure.monitorQueue?.close(),
      this.infrastructure.analyticsQueue?.close(),
      this.infrastructure.engagementQueue?.close(),
      this.infrastructure.firstCommentQueue?.close(),
      this.infrastructure.privateConversationQueue?.close(),
    ]);
  }
}

@Module({
  providers: [
    {
      provide: INFRASTRUCTURE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<OriginPostInfrastructure> => {
        const databaseUrl = config.get<string>("DATABASE_URL");
        const redisUrl = config.get<string>("REDIS_URL");
        const privateMessageEncryptionKey = config.get<string>("PRIVATE_MESSAGE_ENCRYPTION_KEY")?.trim();
        const privateMessageHashKey = config.get<string>("PRIVATE_MESSAGE_HASH_KEY")?.trim();
        const { repository, postingQueueRepository, analyticsRepository, analyticsReportRepository, automationRepository, batchPlanRepository, creativeStudioRepository, shareCaptureRepository, sourceSignalRepository, engagementRepository, firstCommentRepository, evergreenRepository, agentRuntimeRepository, agentBoardRepository, authRepository, organizationRepository, oauthRepository, connectedAccountRepository, providerLifecycleRepository, mediaRepository, mediaOrganizationRepository, monitorRepository, notificationRepository, operationalIncidentRepository, outboxRepository, providerPublishOperationRepository, remoteCorrectionRepository, instagramCollaboratorRepository, privateConversationRepository, mode } = await createContentRepository({
          ...(databaseUrl ? { databaseUrl } : {}),
          ...(privateMessageEncryptionKey ? { privateMessageEncryptionKey } : {}),
          ...(privateMessageHashKey ? { privateMessageHashKey } : {}),
          privateMessageTestMode: config.get<string>("NODE_ENV") === "test",
          allowMemoryFallback: config.get<string>("NODE_ENV") !== "production",
        });
        const hermesUrl = config.get<string>("HERMES_API_URL");
        const hermesKey = config.get<string>("HERMES_API_KEY");
        const hermes = hermesUrl && hermesKey ? new HermesAgentProvider({ baseUrl: hermesUrl, apiKey: hermesKey, model: config.get<string>("HERMES_MODEL") ?? "hermes-agent" }) : null;
        const boardRuntime = config.get<boolean>("HERMES_BOARD_PLUGIN_ENABLED") === true ? new HermesBoardPlugin({
          dashboardBaseUrl: config.get<string>("HERMES_DASHBOARD_URL")!,
          dashboardSessionToken: config.get<string>("HERMES_DASHBOARD_SESSION_TOKEN")!,
          executionBaseUrl: config.get<string>("HERMES_API_URL")!,
          approvedSkills: String(config.get<string>("HERMES_BOARD_APPROVED_SKILLS") ?? "").split(",").map((value)=>value.trim()).filter(Boolean),
          primaryProvider: config.get<string>("HERMES_BOARD_PRIMARY_PROVIDER")!,
          primaryModel: config.get<string>("HERMES_BOARD_PRIMARY_MODEL")!,
          supportedVersion: config.get<string>("HERMES_BOARD_SUPPORTED_VERSION") ?? "0.21.1",
          allowPrivateEndpoints: config.get<boolean>("HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS") === true,
        }) : null;
        const queue = (name: string) => redisUrl ? new Queue(name, { connection: redisConnection(redisUrl) }) : null;
        const s3Endpoint = config.get<string>("S3_ENDPOINT");
        const s3AccessKey = config.get<string>("S3_ACCESS_KEY");
        const s3SecretKey = config.get<string>("S3_SECRET_KEY");
        const mediaObjectStore = s3Endpoint && s3AccessKey && s3SecretKey
          ? new S3MediaObjectStore({ endpoint: s3Endpoint, publicEndpoint: config.get<string>("S3_PUBLIC_ENDPOINT") || s3Endpoint, region: config.get<string>("S3_REGION") ?? "us-east-1", bucket: config.get<string>("S3_BUCKET") ?? "originpost-media", accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey })
          : new MemoryMediaObjectStore();
        const connectors = connectorRegistry(config,connectedAccountRepository,oauthRepository);
        return {
          repository,
          postingQueueRepository,
          analyticsRepository,
          analyticsReportRepository,
          automationRepository,
          batchPlanRepository,
          creativeStudioRepository,
          shareCaptureRepository,
          sourceSignalRepository,
          engagementRepository,
          firstCommentRepository,
          evergreenRepository,
          agentRuntimeRepository,
          agentBoardRepository,
          authRepository,
          organizationRepository,
          oauthRepository,
          connectedAccountRepository,
          providerLifecycleRepository,
          mediaRepository,
          mediaOrganizationRepository,
          mediaObjectStore,
          monitorRepository,
          notificationRepository,
          operationalIncidentRepository,
          outboxRepository,
          providerPublishOperationRepository,
          remoteCorrectionRepository,
          instagramCollaboratorRepository,
          privateConversationRepository,
          connectors,
          hermes,
          boardRuntime,
          researchQueue: queue("originpost-research"),
          monitorQueue: queue("originpost-monitor"),
          analyticsQueue: queue("originpost-analytics"),
          engagementQueue: queue("originpost-engagement"),
          firstCommentQueue: queue("originpost-first-comment"),
          privateConversationQueue: privateConversationRepository ? queue("originpost-private-conversations") : null,
          storageMode: mode,
        };
      },
    },
    InfrastructureLifecycle,
  ],
  exports: [INFRASTRUCTURE],
})
export class InfrastructureModule {}
