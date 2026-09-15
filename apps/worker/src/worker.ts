import { monitorResearchActor, selectBrandSourcing } from "./local-codex-sourcing.js";
import { researchContext } from "./research-context.js";
import "dotenv/config";
import { createHash } from "node:crypto";
import { HermesBoardPlugin, HermesSourcingProvider, LumaMumbaiSourcingProvider, MockSourcingProvider, type SourcingProvider } from "@originpost/agents";
import {
  createMediaDeliveryToken,
  createSafeConnectorRegistry,
  decodeCredentialEncryptionKey,
  FacebookPageOfficialConnector,
  InstagramOfficialConnector,
  MetaPagePrivateConversationConnector,
  openEncryptedCredential,
  parseMetaPrivateMessagingGrant,
  parseProviderLookupKeyring,
  ProviderAnalyticsError,
  YouTubeOfficialConnector,
  type ConnectorMedia,
  type PublishRequest,
  type PublishResult,
  type AnalyticsRequest,
} from "@originpost/connectors";
import { createContentRepository } from "@originpost/db";
import { TelegramBotClient } from "@originpost/telegram";
import {
  completeAutomaticPublication,
  completeResearch,
  createNotification,
  createMonitorSuggestion,
  failResearch,
  finishPublishAttempt,
  markResearchRunning,
  markTargetStatus,
  sourceFingerprint,
  rankSourceSignals,
  sourceIntelligenceResearchContext,
  startPublishAttempt,
  type Actor,
  type ContentItem,
  type ContentItemRepository,
  type MonitorRun,
  type PlatformDraft,
  type PublishTarget,
  type ProviderPublishOperation,
  type PostAnalyticsSnapshot,
  type AuditEvent,
  collaboratorInviteProof,
  type CurrentCollaboratorStatusSnapshot,
  type InstagramPublishSettings,
  type CredentialRefreshPlatform,
  type ProviderGrantProvider,
} from "@originpost/domain";
import { decideInstagramCollaboratorPoll } from "./instagram-collaborator-poll-state.js";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import { hasCompletePublishProof, officialPublishNextStep } from "./provider-publish-state.js";
import { facebookIntentMarker, facebookPublishNextStep } from "./facebook-publish-state.js";
import { groupMonitorSuggestions } from "./monitor-suggestion-groups.js";
import { openProviderSessionUri, sealProviderSessionUri } from "./provider-operation-secret.js";
import { publishJobId } from "./outbox-job.js";
import { beginInstagramProviderOperation, instagramProviderClaimRetry, ProviderExecutionClaimLostError, saveClaimedProviderOperation } from "./instagram-provider-execution.js";
import {
  advanceYouTubeProcessingPoll,
  proofDisclosureForTarget,
  YOUTUBE_PROCESSING_POLL_INTERVAL_MS,
  YOUTUBE_PROCESSING_TIMEOUT_MS,
  youtubePrivacyMatches,
  youtubePublishNextStep,
} from "./youtube-publish-state.js";
import { startEngagementWorkers } from "./engagement-worker.js";
import { startFirstCommentWorkers } from "./first-comment-worker.js";
import { startPrivateConversationWorkers } from "./private-conversation-worker.js";
import { createEvergreenRuntime } from "./evergreen-worker.js";
import { processRemoteCorrectionJob, type RemoteCorrectionJob } from "./remote-correction-worker.js";
import { processBoardPluginDeactivate, processBoardPluginDecision, processBoardPluginReconcile, type BoardPluginDeactivateJob, type BoardPluginDecisionJob, type BoardPluginReconcileJob } from "./board-plugin-worker.js";
import { processBoardTaskExecution, type BoardTaskExecutionJob } from "./board-task-execution-worker.js";
import { CredentialRefreshError, processCredentialRefreshJob } from "./credential-refresh-worker.js";
import { processProviderDataDeletion } from "./provider-data-deletion-worker.js";
import { processProviderGrantValidation, type ProviderGrantValidationJob } from "./provider-grant-validation-worker.js";
import { configuredWebsiteProvider } from "./website-sourcing.js";
import { selectMonitorSourcingProvider } from "./monitor-sourcing.js";

interface PublishJob { workspaceId: string; contentItemId: string; targetId: string }
interface ResearchJob { workspaceId: string; contentItemId: string; researchRunId: string }
interface MonitorJob { workspaceId: string; monitorId: string; trigger?: "scheduled" | "manual"; requestedBy?: string }
interface AnalyticsJob { workspaceId: string; contentItemId: string; proofId: string }
type InstagramCredentialPayload = { provider: "instagram"; externalAccountId: string; accessToken: string; connectionMode?:"facebook_login"|"instagram_login"; accountType?:"BUSINESS"|"MEDIA_CREATOR"; scope?:string; grantedScopes?:string[]; pageId?:string; pageTasks?:string[]; issuedAt?:string; expiresAt?:string; privateMessagingGrant?:unknown };
type FacebookCredentialPayload = { provider: "facebook"; externalAccountId: string; accessToken: string; scope?:string; issuedAt?:string; pageTasks?:string[]; privateMessagingGrant?:unknown };
type YouTubeCredentialPayload = { provider: "youtube"; externalAccountId: string; accessToken: string; refreshToken: string; expiresAt?: string; scope?:string };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redisConnection(urlValue: string) {
  const url = new URL(urlValue);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
    ...(url.username ? { username: url.username } : {}),
  };
}

async function saveResult(
  repository: ContentItemRepository,
  result: { item: ContentItem; event: Parameters<ContentItemRepository["commit"]>[1] },
) {
  await repository.commit(result.item, result.event);
}

function createSourcingProvider(): SourcingProvider {
  if ((process.env.AGENT_MODE ?? "mock") !== "hermes") return new MockSourcingProvider();
  if (!process.env.HERMES_API_URL || !process.env.HERMES_API_KEY) {
    throw new Error("HERMES_API_URL and HERMES_API_KEY are required when AGENT_MODE=hermes.");
  }
  return new HermesSourcingProvider({
    baseUrl: process.env.HERMES_API_URL,
    apiKey: process.env.HERMES_API_KEY,
    model: process.env.HERMES_MODEL ?? "hermes-agent",
  });
}

const instagramConnectorMode = process.env.INSTAGRAM_CONNECTOR_MODE ?? process.env.CONNECTOR_MODE ?? "mock";
const facebookConnectorMode = process.env.FACEBOOK_CONNECTOR_MODE ?? "mock";
const facebookAnalyticsConnectorMode = process.env.FACEBOOK_ANALYTICS_CONNECTOR_MODE ?? "disabled";
const youtubeConnectorMode = process.env.YOUTUBE_CONNECTOR_MODE ?? "mock";
const privateMessageConnectorMode = process.env.PRIVATE_MESSAGE_CONNECTOR_MODE ?? "disabled";
const providerGrantValidationProviders: ProviderGrantProvider[] = [
  ...(instagramConnectorMode === "official" || facebookConnectorMode === "official" || privateMessageConnectorMode === "official" ? ["meta" as const] : []),
  ...(youtubeConnectorMode === "official" ? ["google" as const] : []),
];
const livePublishingAllowed = process.env.ALLOW_LIVE_PUBLISH === "true";
const mediaMalwareScanMode = process.env.MEDIA_MALWARE_SCAN_MODE ?? "disabled";
for (const [name, mode] of [["INSTAGRAM_CONNECTOR_MODE", instagramConnectorMode], ["FACEBOOK_CONNECTOR_MODE", facebookConnectorMode], ["YOUTUBE_CONNECTOR_MODE", youtubeConnectorMode]]) {
  if (mode !== "mock" && mode !== "official") throw new Error(`${name} must be mock or official.`);
}
if (!["disabled", "mock", "official"].includes(privateMessageConnectorMode)) throw new Error("PRIVATE_MESSAGE_CONNECTOR_MODE must be disabled, mock, or official.");
if (!["disabled", "clamav"].includes(mediaMalwareScanMode)) throw new Error("MEDIA_MALWARE_SCAN_MODE must be disabled or clamav.");
if (livePublishingAllowed && mediaMalwareScanMode !== "clamav") throw new Error("Live publishing requires MEDIA_MALWARE_SCAN_MODE=clamav so every uploaded file is scanned before use.");
if (privateMessageConnectorMode === "mock" && process.env.NODE_ENV === "production") throw new Error("PRIVATE_MESSAGE_CONNECTOR_MODE=mock is forbidden in production.");
if (privateMessageConnectorMode === "official" && process.env.AUTH_MODE !== "sessions") throw new Error("Official private messaging requires AUTH_MODE=sessions.");
if (privateMessageConnectorMode === "official" && (!process.env.META_GRAPH_API_VERSION || !process.env.META_APP_ID || !process.env.META_APP_SECRET)) throw new Error("Official private messaging requires META_GRAPH_API_VERSION, META_APP_ID, and META_APP_SECRET.");
if (privateMessageConnectorMode === "official" && !process.env.META_WEBHOOK_VERIFY_TOKEN) throw new Error("Official private messaging requires META_WEBHOOK_VERIFY_TOKEN for both linked Instagram and Facebook Page webhooks.");
if (privateMessageConnectorMode === "official" && (!process.env.PRIVATE_MESSAGE_ENCRYPTION_KEY || !process.env.PRIVATE_MESSAGE_HASH_KEY)) throw new Error("Official private messaging requires PRIVATE_MESSAGE_ENCRYPTION_KEY and PRIVATE_MESSAGE_HASH_KEY.");
if (privateMessageConnectorMode === "official" && !/^[a-f0-9]{64}$/.test(process.env.META_PRIVATE_MESSAGING_APP_REVIEW_SHA256 ?? "")) throw new Error("Official private messaging requires META_PRIVATE_MESSAGING_APP_REVIEW_SHA256 as a lowercase SHA-256 evidence reference.");
const anyOfficialConnector = instagramConnectorMode === "official" || facebookConnectorMode === "official" || youtubeConnectorMode === "official";
if (!anyOfficialConnector && livePublishingAllowed) throw new Error("ALLOW_LIVE_PUBLISH cannot be true while every connector is in mock mode.");
if (anyOfficialConnector && !livePublishingAllowed) throw new Error("Official publishing requires ALLOW_LIVE_PUBLISH=true.");
if (anyOfficialConnector && process.env.AUTH_MODE !== "sessions") throw new Error("Official publishing requires AUTH_MODE=sessions so the management API is not owner-open.");
if (instagramConnectorMode === "official" && !process.env.META_GRAPH_API_VERSION) throw new Error("Official Instagram publishing requires META_GRAPH_API_VERSION.");
if (facebookConnectorMode === "official" && (!process.env.META_GRAPH_API_VERSION || !process.env.META_APP_SECRET)) throw new Error("Official Facebook Page publishing requires META_GRAPH_API_VERSION and META_APP_SECRET.");
if (!["disabled", "official"].includes(facebookAnalyticsConnectorMode)) throw new Error("FACEBOOK_ANALYTICS_CONNECTOR_MODE must be disabled or official.");
const facebookAnalyticsProbeApiVersion = process.env.FACEBOOK_ANALYTICS_CONTRACT_PROBE_API_VERSION?.trim();
const facebookAnalyticsProbeVerifiedAt = process.env.FACEBOOK_ANALYTICS_CONTRACT_PROBE_VERIFIED_AT?.trim();
const facebookAnalyticsProbeExpiresAt = process.env.FACEBOOK_ANALYTICS_CONTRACT_PROBE_EXPIRES_AT?.trim();
const facebookAnalyticsAppReviewSha256 = process.env.FACEBOOK_ANALYTICS_APP_REVIEW_SHA256?.trim();
const facebookAnalyticsProbeResultSha256 = process.env.FACEBOOK_ANALYTICS_CONTRACT_PROBE_RESULT_SHA256?.trim();
if (facebookAnalyticsConnectorMode === "official") {
  if (facebookConnectorMode !== "official" || !process.env.META_APP_ID || !/^[a-f0-9]{64}$/u.test(facebookAnalyticsAppReviewSha256 ?? "")) throw new Error("Official Facebook analytics requires official Facebook mode, META_APP_ID, and an App Review evidence digest.");
  if (!/^[a-f0-9]{64}$/u.test(facebookAnalyticsProbeResultSha256 ?? "")) throw new Error("Official Facebook analytics requires a lowercase watched probe-result digest.");
  if (!facebookAnalyticsProbeApiVersion || !facebookAnalyticsProbeVerifiedAt || !facebookAnalyticsProbeExpiresAt || facebookAnalyticsProbeApiVersion !== process.env.META_GRAPH_API_VERSION) throw new Error("Facebook analytics requires a complete contract probe for the exact META_GRAPH_API_VERSION.");
  const verifiedAt = Date.parse(facebookAnalyticsProbeVerifiedAt); const expiresAt = Date.parse(facebookAnalyticsProbeExpiresAt); const now = Date.now();
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || verifiedAt > now || expiresAt <= now || expiresAt - verifiedAt > 30 * 24 * 60 * 60_000) throw new Error("Facebook analytics contract probe must be current and expire within 30 days.");
}
const facebookReplyProbeApiVersion = process.env.FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_API_VERSION?.trim();
const facebookReplyProbeVerifiedAt = process.env.FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT?.trim();
const facebookDeleteProbeApiVersion=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_API_VERSION?.trim();
const facebookDeleteProbeVerifiedAt=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_VERIFIED_AT?.trim();
const facebookDeleteProbeExpiresAt=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXPIRES_AT?.trim();
const facebookDeleteProbeAccountId=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_ID?.trim();
const facebookDeleteProbeExternalPageId=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXTERNAL_PAGE_ID?.trim();
const facebookDeleteProbeCredentialVersion=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_CREDENTIAL_VERSION?.trim();
const facebookDeleteProbeAccountVersion=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_VERSION?.trim();
const facebookDeleteProbePageTasksSha256=process.env.FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_PAGE_TASKS_SHA256?.trim();
const facebookCommentReconcileMaxPages = Number(process.env.FACEBOOK_COMMENT_RECONCILE_MAX_PAGES ?? "10");
if (Boolean(facebookReplyProbeApiVersion) !== Boolean(facebookReplyProbeVerifiedAt)) throw new Error("Facebook comment reply contract probe version and verification time must be configured together.");
if (facebookReplyProbeApiVersion && facebookReplyProbeApiVersion !== process.env.META_GRAPH_API_VERSION) throw new Error("The Facebook comment reply contract probe must match META_GRAPH_API_VERSION exactly.");
if (facebookReplyProbeVerifiedAt && !Number.isFinite(Date.parse(facebookReplyProbeVerifiedAt))) throw new Error("FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT must be an ISO date-time.");
if ([facebookDeleteProbeApiVersion,facebookDeleteProbeVerifiedAt,facebookDeleteProbeExpiresAt,facebookDeleteProbeAccountId,facebookDeleteProbeExternalPageId,facebookDeleteProbeCredentialVersion,facebookDeleteProbeAccountVersion,facebookDeleteProbePageTasksSha256].some(Boolean) && ![facebookDeleteProbeApiVersion,facebookDeleteProbeVerifiedAt,facebookDeleteProbeExpiresAt,facebookDeleteProbeAccountId,facebookDeleteProbeExternalPageId,facebookDeleteProbeCredentialVersion,facebookDeleteProbeAccountVersion,facebookDeleteProbePageTasksSha256,process.env.META_APP_ID].every(Boolean)) throw new Error("Facebook Page delete probe requires version, verified/expires timestamps, local account ID, external Page ID, credential/account versions, Page tasks hash, and META_APP_ID together.");
if(facebookDeleteProbeApiVersion&&facebookDeleteProbeApiVersion!==process.env.META_GRAPH_API_VERSION)throw new Error("Facebook Page delete probe must match META_GRAPH_API_VERSION exactly.");
if(facebookDeleteProbePageTasksSha256&&!/^[a-f0-9]{64}$/.test(facebookDeleteProbePageTasksSha256))throw new Error("FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_PAGE_TASKS_SHA256 must be lowercase SHA-256.");
if (!Number.isInteger(facebookCommentReconcileMaxPages) || facebookCommentReconcileMaxPages < 1 || facebookCommentReconcileMaxPages > 25) throw new Error("FACEBOOK_COMMENT_RECONCILE_MAX_PAGES must be an integer from 1 to 25.");
if (youtubeConnectorMode === "official" && (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)) throw new Error("Official YouTube publishing requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
if (youtubeConnectorMode === "official" && process.env.YOUTUBE_API_COMPLIANCE_AUDITED !== "true" && process.env.YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING === "true") throw new Error("Non-private YouTube publishing requires YOUTUBE_API_COMPLIANCE_AUDITED=true.");
if (anyOfficialConnector && (!process.env.API_PUBLIC_URL || new URL(process.env.API_PUBLIC_URL).protocol !== "https:")) throw new Error("Official publishing requires a public HTTPS API_PUBLIC_URL.");
if (anyOfficialConnector && (!process.env.MEDIA_DELIVERY_SECRET || process.env.MEDIA_DELIVERY_SECRET.length < 32)) throw new Error("Official publishing requires a MEDIA_DELIVERY_SECRET of at least 32 characters.");
const credentialEncryptionKey = decodeCredentialEncryptionKey(process.env.CREDENTIAL_ENCRYPTION_KEY);
if (anyOfficialConnector && !credentialEncryptionKey) throw new Error("Official publishing requires a valid 32-byte CREDENTIAL_ENCRYPTION_KEY.");
if (privateMessageConnectorMode === "official" && !credentialEncryptionKey) throw new Error("Official private messaging requires a valid 32-byte CREDENTIAL_ENCRYPTION_KEY.");
const providerGrantValidationKeyring = providerGrantValidationProviders.length
  ? parseProviderLookupKeyring(process.env.PROVIDER_LOOKUP_HMAC_KEYS ?? "", process.env.PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION ?? "")
  : null;
if (privateMessageConnectorMode === "official" && (!process.env.API_PUBLIC_URL || new URL(process.env.API_PUBLIC_URL).protocol !== "https:")) throw new Error("Official private messaging requires a public HTTPS API_PUBLIC_URL.");
const hermesBoardPluginEnabled = process.env.HERMES_BOARD_PLUGIN_ENABLED === "true";
if (hermesBoardPluginEnabled) {
  if (process.env.AUTH_MODE !== "sessions") throw new Error("The Hermes Boards plugin requires AUTH_MODE=sessions.");
  if (!process.env.REDIS_URL) throw new Error("The Hermes Boards plugin requires REDIS_URL.");
  if ((process.env.HERMES_BOARD_SECRET ?? "").length < 32) throw new Error("HERMES_BOARD_SECRET must contain at least 32 characters.");
  if ((process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? "").length < 32 || !process.env.HERMES_DASHBOARD_URL || !process.env.HERMES_API_URL) throw new Error("The Hermes Boards plugin requires dashboard/API URLs and a dashboard session token.");
  if ((process.env.HERMES_BOARD_SUPPORTED_VERSION ?? "0.21.2") !== "0.21.2") throw new Error("This OriginPost worker supports Hermes 0.21.2 only.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u.test(process.env.HERMES_BOARD_PRIMARY_PROVIDER ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(process.env.HERMES_BOARD_PRIMARY_MODEL ?? "")) throw new Error("The Hermes Boards plugin requires an explicit primary provider and model.");
  if (process.env.HERMES_BOARD_PRIMARY_PROVIDER !== "openai-codex") throw new Error("The Hermes Boards plugin requires HERMES_BOARD_PRIMARY_PROVIDER=openai-codex.");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required by the worker.");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const { repository, authRepository, agentRuntimeRepository, analyticsRepository, engagementRepository, firstCommentRepository, evergreenRepository, agentBoardRepository, agentBoardTaskRepository, organizationRepository, privateConversationRepository, connectedAccountRepository, providerLifecycleRepository, oauthRepository, mediaRepository, monitorRepository, sourceSignalRepository, notificationRepository, outboxRepository, providerPublishOperationRepository, remoteCorrectionRepository, instagramCollaboratorRepository } = await createContentRepository({
  databaseUrl,
  allowMemoryFallback: false,
  ...(process.env.PRIVATE_MESSAGE_ENCRYPTION_KEY ? { privateMessageEncryptionKey: process.env.PRIVATE_MESSAGE_ENCRYPTION_KEY } : {}),
  ...(process.env.PRIVATE_MESSAGE_HASH_KEY ? { privateMessageHashKey: process.env.PRIVATE_MESSAGE_HASH_KEY } : {}),
});
const boardRuntime = hermesBoardPluginEnabled ? new HermesBoardPlugin({
  dashboardBaseUrl: process.env.HERMES_DASHBOARD_URL!,
  dashboardSessionToken: process.env.HERMES_DASHBOARD_SESSION_TOKEN!,
  executionBaseUrl: process.env.HERMES_API_URL!,
  approvedSkills: (process.env.HERMES_BOARD_APPROVED_SKILLS ?? "").split(",").map((value)=>value.trim()).filter(Boolean),
  primaryProvider: process.env.HERMES_BOARD_PRIMARY_PROVIDER!,
  primaryModel: process.env.HERMES_BOARD_PRIMARY_MODEL!,
  supportedVersion: process.env.HERMES_BOARD_SUPPORTED_VERSION ?? "0.21.2",
  allowPrivateEndpoints: process.env.HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS === "true",
}) : null;
const connectors = createSafeConnectorRegistry({ privateConversationMode: privateMessageConnectorMode, nodeEnv: process.env.NODE_ENV ?? "development" });
if (privateMessageConnectorMode === "official") {
  const environment = (process.env.NODE_ENV ?? "development") as "production" | "development" | "test";
  const privatePayload = async (workspaceId: string, accountId: string) => {
    const account = await connectedAccountRepository.get(workspaceId, accountId);
    const id = account?.credentialRef?.startsWith("secret:") ? account.credentialRef.slice(7) : undefined;
    if (!account || !id || !credentialEncryptionKey) throw new Error("The Meta private-message account must be reconnected.");
    const record = await oauthRepository.getCredential(workspaceId, id);
    if (!record) throw new Error("The Meta private-message credential is unavailable.");
    let value: Record<string, unknown>;
    try { value = JSON.parse(openEncryptedCredential(record, credentialEncryptionKey)) as Record<string, unknown>; }
    catch { throw new Error("The Meta private-message credential is invalid. Reconnect the account."); }
    return { account, value };
  };
  connectors.registerPrivateConversations(new MetaPagePrivateConversationConnector({
    connectionMode: "facebook_page_messenger", apiVersion: process.env.META_GRAPH_API_VERSION!, appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET!, environment,
    resolveCredential: async (request) => {
      const { account, value } = await privatePayload(request.workspaceId, request.accountId);
      const scopes = typeof value.scope === "string" ? value.scope.split(/[\s,]+/u).filter(Boolean) : [];
      const pageTasks = Array.isArray(value.pageTasks) && value.pageTasks.every((task) => typeof task === "string") ? value.pageTasks as string[] : [];
      const grant = parseMetaPrivateMessagingGrant(value.privateMessagingGrant);
      if (account.platform !== "facebook" || account.status !== "healthy" || value.provider !== "facebook" || value.externalAccountId !== account.externalAccountId || typeof value.accessToken !== "string" || typeof value.issuedAt !== "string" || !account.capabilities.includes("private_message_read") || !account.capabilities.includes("private_message_send")) throw new Error("The Facebook Page messaging credential is unavailable or requires re-consent.");
      return { externalBusinessAccountId: account.externalAccountId, endpointPageId: account.externalAccountId, accessToken: value.accessToken, scopes, pageTasks, credentialVersion: value.issuedAt, accountVersion: account.updatedAt, ...(grant ? { messagingGrant: grant } : {}) };
    },
  }));
  connectors.registerPrivateConversations(new MetaPagePrivateConversationConnector({
    connectionMode: "instagram_linked_page", apiVersion: process.env.META_GRAPH_API_VERSION!, appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET!, environment,
    resolveCredential: async (request) => {
      const { account, value } = await privatePayload(request.workspaceId, request.accountId);
      const scopes = Array.isArray(value.grantedScopes) && value.grantedScopes.every((scope) => typeof scope === "string") ? value.grantedScopes as string[] : typeof value.scope === "string" ? value.scope.split(/[\s,]+/u).filter(Boolean) : [];
      const pageTasks = Array.isArray(value.pageTasks) && value.pageTasks.every((task) => typeof task === "string") ? value.pageTasks as string[] : [];
      const grant = parseMetaPrivateMessagingGrant(value.privateMessagingGrant);
      if (account.platform !== "instagram" || account.status !== "healthy" || value.provider !== "instagram" || value.connectionMode !== "facebook_login" || value.externalAccountId !== account.externalAccountId || typeof value.pageId !== "string" || typeof value.accessToken !== "string" || typeof value.issuedAt !== "string" || !account.capabilities.includes("private_message_read") || !account.capabilities.includes("private_message_send")) throw new Error("The linked Instagram messaging credential is unavailable or requires re-consent.");
      return { externalBusinessAccountId: account.externalAccountId, endpointPageId: value.pageId, accessToken: value.accessToken, scopes, pageTasks, credentialVersion: value.issuedAt, accountVersion: account.updatedAt, ...(grant ? { messagingGrant: grant } : {}) };
    },
  }));
}
if (instagramConnectorMode === "official") {
  connectors.register(new InstagramOfficialConnector({
    apiVersion: process.env.META_GRAPH_API_VERSION!,
    resolveCredential: async (request) => {
      const account = await connectedAccountRepository.get(request.workspaceId, request.accountId);
      if (!account || account.platform !== "instagram") throw new Error("The Instagram publishing account is unavailable.");
      const credentialId = account.credentialRef?.startsWith("secret:") ? account.credentialRef.slice(7) : undefined;
      if (!credentialId) throw new Error("The Instagram publishing account must be reconnected.");
      const record = await oauthRepository.getCredential(account.workspaceId, credentialId);
      if (!record || !credentialEncryptionKey) throw new Error("The Instagram publishing credential is unavailable.");
      let payload: Partial<InstagramCredentialPayload>;
      try { payload = JSON.parse(openEncryptedCredential(record, credentialEncryptionKey)) as Partial<InstagramCredentialPayload>; }
      catch { throw new Error("The Instagram publishing credential is invalid. Reconnect the account."); }
      if (payload.provider !== "instagram" || !payload.accessToken || payload.externalAccountId !== account.externalAccountId) throw new Error("The Instagram publishing credential does not match the connected account.");
      if (account.status !== "healthy") throw new Error("Instagram access needs attention before publishing.");
      if (account.expiresAt && (Date.parse(account.expiresAt) <= Date.now() + 60_000 || payload.expiresAt !== account.expiresAt)) throw new Error("Instagram access renewal is pending. Reconnect the account if it does not recover.");
      return { externalAccountId: account.externalAccountId, accessToken: payload.accessToken,...(payload.connectionMode?{connectionMode:payload.connectionMode}:{}),...(payload.accountType?{accountType:payload.accountType}:{}),...(payload.scope?{scope:payload.scope}:{}) };
    },
  }));
}
if (facebookConnectorMode === "official") {
  connectors.register(new FacebookPageOfficialConnector({
    apiVersion: process.env.META_GRAPH_API_VERSION!,
    appSecret: process.env.META_APP_SECRET!,
    ...(process.env.META_APP_ID?{appId:process.env.META_APP_ID}:{}),
    environment:(process.env.NODE_ENV??"development") as "production"|"development"|"test",
    maxCommentPages: facebookCommentReconcileMaxPages,
    ...(facebookAnalyticsConnectorMode === "official" ? { analyticsContractProbe: { apiVersion: facebookAnalyticsProbeApiVersion!, appId: process.env.META_APP_ID!, appReviewSha256: facebookAnalyticsAppReviewSha256!, resultSha256: facebookAnalyticsProbeResultSha256!, verifiedAt: facebookAnalyticsProbeVerifiedAt!, expiresAt: facebookAnalyticsProbeExpiresAt! } } : {}),
    ...(facebookReplyProbeApiVersion && facebookReplyProbeVerifiedAt
      ? { commentReplyContractProbe: { apiVersion: facebookReplyProbeApiVersion, verifiedAt: facebookReplyProbeVerifiedAt } }
      : {}),
    ...(facebookDeleteProbeApiVersion&&facebookDeleteProbeVerifiedAt&&facebookDeleteProbeExpiresAt&&facebookDeleteProbeAccountId&&facebookDeleteProbeExternalPageId&&facebookDeleteProbeCredentialVersion&&facebookDeleteProbeAccountVersion&&facebookDeleteProbePageTasksSha256&&process.env.META_APP_ID?{pageDeleteContractProbe:{apiVersion:facebookDeleteProbeApiVersion,verifiedAt:facebookDeleteProbeVerifiedAt,expiresAt:facebookDeleteProbeExpiresAt,environment:(process.env.NODE_ENV??"development") as "production"|"development"|"test",appId:process.env.META_APP_ID,accountId:facebookDeleteProbeAccountId,externalPageId:facebookDeleteProbeExternalPageId,credentialVersion:facebookDeleteProbeCredentialVersion,accountVersion:facebookDeleteProbeAccountVersion,pageTasksSha256:facebookDeleteProbePageTasksSha256,task:"page_post_delete" as const}}:{}),
    resolveCredential: async (request) => {
      const account = await connectedAccountRepository.get(request.workspaceId, request.accountId);
      if (!account || account.platform !== "facebook") throw new Error("The Facebook Page publishing account is unavailable.");
      const credentialId = account.credentialRef?.startsWith("secret:") ? account.credentialRef.slice(7) : undefined;
      if (!credentialId) throw new Error("The Facebook Page publishing account must be reconnected.");
      const record = await oauthRepository.getCredential(account.workspaceId, credentialId);
      if (!record || !credentialEncryptionKey) throw new Error("The Facebook Page publishing credential is unavailable.");
      let payload: Partial<FacebookCredentialPayload>;
      try { payload = JSON.parse(openEncryptedCredential(record, credentialEncryptionKey)) as Partial<FacebookCredentialPayload>; }
      catch { throw new Error("The Facebook Page publishing credential is invalid. Reconnect the Page."); }
      if (payload.provider !== "facebook" || !payload.accessToken || payload.externalAccountId !== account.externalAccountId) throw new Error("The Facebook Page publishing credential does not match the connected Page.");
      if (account.status !== "healthy") throw new Error("Facebook Page access needs attention before publishing.");
      return { externalAccountId: account.externalAccountId, accessToken: payload.accessToken,...(payload.scope?{scope:payload.scope}:{}),...(payload.issuedAt?{credentialVersion:payload.issuedAt}:{}),...(Array.isArray(payload.pageTasks)?{pageTasks:payload.pageTasks}:{}),accountVersion:account.updatedAt };
    },
  }));
}
if (youtubeConnectorMode === "official") {
  connectors.register(new YouTubeOfficialConnector({
    resolveCredential: async (request) => {
      const account = await connectedAccountRepository.get(request.workspaceId, request.accountId);
      if (!account || account.platform !== "youtube") throw new Error("The YouTube publishing account is unavailable.");
      const credentialId = account.credentialRef?.startsWith("secret:") ? account.credentialRef.slice(7) : undefined;
      if (!credentialId) throw new Error("The YouTube publishing account must be reconnected.");
      const record = await oauthRepository.getCredential(account.workspaceId, credentialId);
      if (!record || !credentialEncryptionKey) throw new Error("The YouTube publishing credential is unavailable.");
      let payload: Partial<YouTubeCredentialPayload>;
      try { payload = JSON.parse(openEncryptedCredential(record, credentialEncryptionKey)) as Partial<YouTubeCredentialPayload>; }
      catch { throw new Error("The YouTube publishing credential is invalid. Reconnect the account."); }
      if (payload.provider !== "youtube" || !payload.accessToken || !payload.refreshToken || payload.externalAccountId !== account.externalAccountId) throw new Error("The YouTube publishing credential does not match the connected account.");
      if (account.status !== "healthy" || !account.expiresAt || payload.expiresAt !== account.expiresAt || Date.parse(account.expiresAt) <= Date.now() + 60_000) throw new Error("YouTube access renewal is pending. Reconnect the account if it does not recover.");
      return { externalAccountId: account.externalAccountId, accessToken: payload.accessToken,...(payload.scope?{scope:payload.scope}:{}) };
    },
  }));
}
const sourcing = createSourcingProvider();
const brandSourcing = (workspaceId:string, brandId:string, actorId:string) => selectBrandSourcing({workspaceId,brandId,actorId,authRepository,ownerWorkspaceId:process.env.LOCAL_CODEX_OWNER_WORKSPACE_ID,ownerUserId:process.env.LOCAL_CODEX_OWNER_USER_ID,repository:agentRuntimeRepository,fallback:sourcing,enabled:process.env.LOCAL_CODEX_RESEARCH_ENABLED==="true",authMode:process.env.AUTH_MODE??"single-user",baseUrl:process.env.LOCAL_CODEX_BASE_URL,encryptionKey:process.env.CREDENTIAL_ENCRYPTION_KEY});
const lumaMumbaiSourcing = new LumaMumbaiSourcingProvider();
const telegram = process.env.TELEGRAM_BOT_TOKEN ? new TelegramBotClient(process.env.TELEGRAM_BOT_TOKEN) : null;
const allowedTelegramChats = new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const systemActor: Actor = { id: "originpost-worker", name: "OriginPost Worker", role: "owner" };

async function notify(input: Parameters<typeof createNotification>[0]): Promise<void> {
  await notificationRepository.create(createNotification(input)).catch((error) => {
    console.error("Workspace notification failed:", error instanceof Error ? error.message : "Unknown notification error");
  });
}

function platformName(platform: PublishTarget["platform"]): string {
  if (platform === "youtube") return "YouTube";
  if (platform === "facebook") return "Facebook Page";
  return "Instagram";
}

async function notifyActionRequired(item: ContentItem, target: PublishTarget, reason: string): Promise<void> {
  await notify({
    workspaceId: item.workspaceId,
    kind: "action_required",
    severity: "warning",
    title: `${platformName(target.platform)} post needs a check`,
    body: `OriginPost paused “${item.title}” because the provider result could not be confirmed safely. Open the item and check the live account before continuing.`,
    dedupeKey: `publish:${target.id}:action-required:${reason}`,
    contentItemId: item.id,
    targetId: target.id,
    actionUrl: `/?module=Content&item=${encodeURIComponent(item.id)}`,
  });
}
const publishQueue = new Queue<PublishJob>("originpost-publish", { connection: redisConnection(redisUrl) });
const monitorQueue = new Queue<MonitorJob>("originpost-monitor", { connection: redisConnection(redisUrl) });
const analyticsQueue = new Queue<AnalyticsJob>("originpost-analytics", { connection: redisConnection(redisUrl) });
const remoteCorrectionQueue = new Queue<RemoteCorrectionJob>("originpost-remote-correction", { connection: redisConnection(redisUrl) });
const boardPluginQueue = boardRuntime ? new Queue<BoardPluginReconcileJob | BoardPluginDeactivateJob | BoardPluginDecisionJob | BoardTaskExecutionJob>("originpost-board-plugins", { connection: redisConnection(redisUrl) }) : null;
// Reconcile/deactivate both update Hermes' shared default-profile allowlist.
// BullMQ's global limit serializes that read-modify-write across worker replicas.
if (boardPluginQueue) await boardPluginQueue.setGlobalConcurrency(1);
const providerGrantValidationQueue = providerGrantValidationProviders.length ? new Queue<ProviderGrantValidationJob>("originpost-provider-grant-validation", { connection: redisConnection(redisUrl) }) : null;
const engagementRuntime = await startEngagementWorkers({ connection: redisConnection(redisUrl), repository, engagementRepository, connectedAccountRepository, notificationRepository, connectors });
const firstCommentRuntime = await startFirstCommentWorkers({ connection: redisConnection(redisUrl), repository, firstComments: firstCommentRepository, notifications: notificationRepository, connectors });
const privateConversationRuntime = privateConversationRepository
  ? await startPrivateConversationWorkers({ connection: redisConnection(redisUrl), privateConversationRepository, notificationRepository, connectors })
  : null;
const evergreenRuntime = createEvergreenRuntime({ repository, evergreenRepository, notificationRepository });
const dispatcherOwner = `worker-${crypto.randomUUID()}`;
let dispatcherRunning = false;

async function connectorMediaForDraft(workspaceId: string, draft: PlatformDraft): Promise<ConnectorMedia[]> {
  const result: ConnectorMedia[] = [];
  for (const mediaId of draft.mediaIds) {
    const asset = await mediaRepository.get(workspaceId, mediaId);
    if (!asset || asset.status !== "ready") throw new Error("Every attached media file must be ready before publishing.");
    if (asset.malwareScanStatus !== undefined && asset.malwareScanStatus !== "clean" && asset.malwareScanStatus !== "disabled") throw new Error("Every attached media file must pass malware scanning before publishing.");
    if (asset.rights !== "owned" && asset.rights !== "cleared") throw new Error("Publishing media must be owned or cleared for reuse.");
    if (asset.kind !== "image" && asset.kind !== "video") throw new Error("Only image and video files can be sent to a social connector.");
    let url: string;
    const official = draft.platform === "instagram"
      ? instagramConnectorMode === "official"
      : draft.platform === "facebook"
        ? facebookConnectorMode === "official"
        : draft.platform === "youtube"
          ? youtubeConnectorMode === "official"
          : false;
    if (!official) {
      url = `https://media.invalid/${encodeURIComponent(asset.id)}`;
    } else {
      const apiPublicUrl = process.env.API_PUBLIC_URL;
      const deliverySecret = process.env.MEDIA_DELIVERY_SECRET;
      if (!apiPublicUrl || new URL(apiPublicUrl).protocol !== "https:") throw new Error("Official publishing requires a public HTTPS API_PUBLIC_URL.");
      if (!deliverySecret) throw new Error("Official publishing requires MEDIA_DELIVERY_SECRET.");
      const token = createMediaDeliveryToken({ workspaceId, mediaId: asset.id, sha256: asset.sha256, expiresAt: Date.now() + 7_200_000 }, deliverySecret);
      url = `${apiPublicUrl.replace(/\/$/, "")}/v1/media-assets/delivery/${encodeURIComponent(token)}`;
    }
    result.push({
      id: asset.id, type: asset.kind, url, mimeType: asset.contentType, sha256: asset.sha256, sizeBytes: asset.sizeBytes,
      inspectionStatus: asset.inspectionStatus,
      malwareScanStatus: asset.malwareScanStatus,
      ...(asset.widthPixels !== undefined ? { widthPixels: asset.widthPixels } : {}),
      ...(asset.heightPixels !== undefined ? { heightPixels: asset.heightPixels } : {}),
      ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
      rights: asset.rights,
      ...(asset.altText ? { altText: asset.altText } : {}),
    });
  }
  return result;
}

async function connectorCoverForTarget(workspaceId:string,brandId:string,platform:"instagram",settings:InstagramPublishSettings|undefined):Promise<ConnectorMedia|undefined>{
  const cover=settings?.reelCover;
  if(cover?.mode!=="custom_image")return undefined;
  const asset=await mediaRepository.get(workspaceId,cover.mediaId);
  if(!asset||asset.brandId!==brandId||asset.status!=="ready"||asset.kind!=="image"||asset.inspectionStatus!=="ready"||(asset.malwareScanStatus!==undefined&&asset.malwareScanStatus!=="clean"&&asset.malwareScanStatus!=="disabled")||(asset.rights!=="owned"&&asset.rights!=="cleared")||asset.sha256!==cover.mediaSha256)throw new Error("The approved Instagram Reel cover is unavailable or changed.");
  let url=`https://media.invalid/${encodeURIComponent(asset.id)}`;
  if(instagramConnectorMode==="official"){
    const apiPublicUrl=process.env.API_PUBLIC_URL;const deliverySecret=process.env.MEDIA_DELIVERY_SECRET;
    if(!apiPublicUrl||new URL(apiPublicUrl).protocol!=="https:")throw new Error("Official publishing requires a public HTTPS API_PUBLIC_URL.");
    if(!deliverySecret)throw new Error("Official publishing requires MEDIA_DELIVERY_SECRET.");
    const token=createMediaDeliveryToken({workspaceId,mediaId:asset.id,sha256:asset.sha256,expiresAt:Date.now()+7_200_000},deliverySecret);
    url=`${apiPublicUrl.replace(/\/$/,"")}/v1/media-assets/delivery/${encodeURIComponent(token)}`;
  }
  return{id:asset.id,type:"image",url,mimeType:asset.contentType,sha256:asset.sha256,sizeBytes:asset.sizeBytes,inspectionStatus:asset.inspectionStatus,malwareScanStatus:asset.malwareScanStatus,...(asset.widthPixels!==undefined?{widthPixels:asset.widthPixels}:{}),...(asset.heightPixels!==undefined?{heightPixels:asset.heightPixels}:{}),...(asset.altText?{altText:asset.altText}:{})};
}

async function dispatchOutbox(): Promise<void> {
  if (dispatcherRunning) return;
  dispatcherRunning = true;
  try {
    const messages = await outboxRepository.claimAvailable(dispatcherOwner, 25, 60);
    for (const message of messages) {
      try {
        if (message.topic === "remote-correction.requested") {
          const { workspaceId, contentItemId, operationId, mode } = message.payload;
          if (typeof workspaceId !== "string" || typeof contentItemId !== "string" || typeof operationId !== "string" || (mode !== undefined && mode !== "execute" && mode !== "reconcile")) throw new Error("Remote correction outbox payload is invalid.");
          await remoteCorrectionQueue.add("remote-correction", { workspaceId, contentItemId, operationId, ...(mode ? { mode } : {}) }, { jobId:`remote-correction-${operationId}-${mode ?? "execute"}`,attempts:1,removeOnComplete:500,removeOnFail:1000 });
          await outboxRepository.complete(message.workspaceId,message.id);
          continue;
        }
        if (message.topic === "board.plugin.reconcile") {
          if (!boardPluginQueue) throw new Error("The Hermes Boards worker is disabled.");
          const { workspaceId, brandId, boardId, configurationEpoch } = message.payload;
          if (typeof workspaceId !== "string" || typeof brandId !== "string" || typeof boardId !== "string" || typeof configurationEpoch !== "number" || !Number.isInteger(configurationEpoch) || configurationEpoch < 1) throw new Error("Board plugin outbox payload is invalid.");
          await boardPluginQueue.add("reconcile-board-plugin", { workspaceId, brandId, boardId, configurationEpoch }, { jobId:`board-plugin-${boardId}-epoch-${configurationEpoch}`,attempts:6,backoff:{type:"exponential",delay:30_000},removeOnComplete:500,removeOnFail:1000 });
          await outboxRepository.complete(message.workspaceId,message.id);
          continue;
        }
        if (message.topic === "board.plugin.deactivate") {
          if (!boardPluginQueue) throw new Error("The Hermes Boards worker is disabled.");
          const { workspaceId, brandId, boardId, configurationEpoch, capabilityEpoch } = message.payload;
          if (typeof workspaceId !== "string" || typeof brandId !== "string" || typeof boardId !== "string" || typeof configurationEpoch !== "number" || !Number.isInteger(configurationEpoch) || configurationEpoch < 1 || typeof capabilityEpoch !== "number" || !Number.isInteger(capabilityEpoch) || capabilityEpoch < 1) throw new Error("Board plugin deactivation outbox payload is invalid.");
          await boardPluginQueue.add("deactivate-board-plugin", { workspaceId, brandId, boardId, configurationEpoch, capabilityEpoch }, { jobId:`board-plugin-${boardId}-deactivate-epoch-${configurationEpoch}`,attempts:6,backoff:{type:"exponential",delay:30_000},removeOnComplete:500,removeOnFail:1000 });
          await outboxRepository.complete(message.workspaceId,message.id);
          continue;
        }
        if (message.topic === "board.plugin.decision") {
          if (!boardPluginQueue) throw new Error("The Hermes Boards worker is disabled.");
          const { workspaceId, brandId, boardId, subsystem, pendingId, decision, expectedSha256, idempotencyKey, decisionKey, idempotencyScopeKey, requestedConfigurationEpoch, requestedCapabilityEpoch, requestedBy, requestedAt } = message.payload;
          if (typeof workspaceId !== "string" || typeof brandId !== "string" || typeof boardId !== "string" || (subsystem !== "memory" && subsystem !== "skills") || typeof pendingId !== "string" || !/^[a-f0-9]{8}$/u.test(pendingId) || (decision !== "approve" && decision !== "reject") || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256) || typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,100}$/u.test(idempotencyKey) || typeof decisionKey !== "string" || !/^[a-f0-9]{64}$/u.test(decisionKey) || typeof idempotencyScopeKey !== "string" || !/^[a-f0-9]{64}$/u.test(idempotencyScopeKey) || typeof requestedConfigurationEpoch !== "number" || !Number.isInteger(requestedConfigurationEpoch) || requestedConfigurationEpoch < 1 || typeof requestedCapabilityEpoch !== "number" || !Number.isInteger(requestedCapabilityEpoch) || requestedCapabilityEpoch < 1 || typeof requestedBy !== "string" || requestedBy.length < 1 || requestedBy.length > 200 || typeof requestedAt !== "string" || !Number.isFinite(Date.parse(requestedAt))) throw new Error("Board plugin decision outbox payload is invalid.");
          await boardPluginQueue.add("decide-board-plugin-write", { workspaceId, brandId, boardId, subsystem, pendingId, decision, expectedSha256, idempotencyKey, decisionKey, idempotencyScopeKey, requestedConfigurationEpoch, requestedCapabilityEpoch, requestedBy, requestedAt }, { attempts:10,backoff:{type:"exponential",delay:30_000},removeOnComplete:500,removeOnFail:1000 });
          await outboxRepository.complete(message.workspaceId,message.id);
          continue;
        }
        if (message.topic === "board.task.execute") {
          if (!boardPluginQueue) throw new Error("The Hermes Boards worker is disabled.");
          const { workspaceId, brandId, boardId, taskId, executionId, taskVersion, configurationEpoch, capabilityEpoch } = message.payload;
          if (typeof workspaceId !== "string" || workspaceId !== message.workspaceId || typeof brandId !== "string" || typeof boardId !== "string" || typeof taskId !== "string" || typeof executionId !== "string" || typeof taskVersion !== "number" || !Number.isInteger(taskVersion) || taskVersion < 1 || typeof configurationEpoch !== "number" || !Number.isInteger(configurationEpoch) || configurationEpoch < 1 || typeof capabilityEpoch !== "number" || !Number.isInteger(capabilityEpoch) || capabilityEpoch < 1) throw new Error("Board task execution outbox payload is invalid.");
          await boardPluginQueue.add("execute-board-task", { workspaceId, brandId, boardId, taskId, executionId, taskVersion, configurationEpoch, capabilityEpoch }, { jobId: `board-task-execution-${executionId}`, attempts: 1, removeOnComplete: 500, removeOnFail: 1000 });
          await outboxRepository.complete(message.workspaceId, message.id);
          continue;
        }
        if (message.topic === "channel.credential-refresh") {
          const { workspaceId, accountId, platform, expectedExpiresAt, expectedCredentialRef } = message.payload;
          if (typeof workspaceId !== "string" || typeof accountId !== "string" || (platform !== "instagram" && platform !== "youtube") || typeof expectedExpiresAt !== "string" || !Number.isFinite(Date.parse(expectedExpiresAt)) || typeof expectedCredentialRef !== "string" || !expectedCredentialRef.startsWith("secret:")) throw new Error("Credential refresh outbox payload is invalid.");
          if (!credentialEncryptionKey) throw new Error("Credential encryption is unavailable.");
          await processCredentialRefreshJob(
            { workspaceId, accountId, platform, expectedExpiresAt, expectedCredentialRef },
            {
              accounts: connectedAccountRepository,
              oauth: oauthRepository,
              notifications: notificationRepository,
              credentialEncryptionKey,
              ...(process.env.GOOGLE_CLIENT_ID ? { googleClientId: process.env.GOOGLE_CLIENT_ID } : {}),
              ...(process.env.GOOGLE_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_CLIENT_SECRET } : {}),
            },
            message.attempts,
            5,
          );
          await outboxRepository.complete(message.workspaceId, message.id);
          continue;
        }
        if (message.topic === "provider.grant-validation") {
          const { workspaceId, grantId, expectedVersion } = message.payload;
          if (typeof workspaceId !== "string" || workspaceId !== message.workspaceId || typeof grantId !== "string" || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error("Provider grant-validation outbox payload is invalid.");
          if (!providerGrantValidationQueue) throw new Error("Provider grant validation is disabled.");
          await providerGrantValidationQueue.add("validate-provider-grant", { workspaceId, grantId, expectedVersion }, { jobId: `provider-grant-validation-${grantId}-v${expectedVersion}`, attempts: 5, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 500, removeOnFail: 1000 });
          await outboxRepository.complete(message.workspaceId, message.id);
          continue;
        }
        if (message.topic === "provider.data-deletion") {
          const { workspaceId, deletionRequestId } = message.payload;
          if (typeof workspaceId !== "string" || typeof deletionRequestId !== "string") throw new Error("Provider data-deletion outbox payload is invalid.");
          await processProviderDataDeletion(
            { workspaceId, deletionRequestId },
            { lifecycle: providerLifecycleRepository, privateConversations: privateConversationRepository },
          );
          await outboxRepository.complete(message.workspaceId, message.id);
          continue;
        }
        if (message.topic !== "publish.target.requested") throw new Error(`Unsupported outbox topic: ${message.topic}`);
        const { workspaceId, contentItemId, targetId } = message.payload;
        if (typeof workspaceId !== "string" || typeof contentItemId !== "string" || typeof targetId !== "string") throw new Error("Publish outbox payload is invalid.");
        await publishQueue.add("publish-target", { workspaceId, contentItemId, targetId }, {
          jobId: publishJobId(targetId, message.payload.recoveryKey),
          attempts: 6,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: 500,
          removeOnFail: 1000,
        });
        await outboxRepository.complete(message.workspaceId, message.id);
      } catch (error) {
        const delaySeconds = Math.min(900, 2 ** Math.min(message.attempts, 9));
        const maxAttempts = message.topic === "channel.credential-refresh"
          ? error instanceof CredentialRefreshError && !error.retryable ? message.attempts : 5
          : 10;
        if (message.topic === "provider.data-deletion" && message.attempts >= maxAttempts) {
          const { workspaceId, deletionRequestId } = message.payload;
          if (typeof workspaceId === "string" && typeof deletionRequestId === "string") {
            await providerLifecycleRepository.failDataDeletionScope(deletionRequestId, workspaceId, "provider_data_deletion_failed", new Date().toISOString());
          }
        }
        await outboxRepository.fail(message.workspaceId, message.id, error instanceof Error ? error.message : "Unknown outbox dispatch error", new Date(Date.now() + delaySeconds * 1000).toISOString(), maxAttempts);
      }
    }
  } finally {
    dispatcherRunning = false;
  }
}

const recoveredTargets = await outboxRepository.recoverPublishTargets();
if (recoveredTargets) console.log(`Recovered ${recoveredTargets} publish target(s) into the durable outbox.`);
const recoveredCorrections = await outboxRepository.recoverRemoteCorrections();
if (recoveredCorrections) console.log(`Recovered ${recoveredCorrections} remote correction(s) into the durable outbox.`);
const recoveredBoardPlugins = boardRuntime ? await outboxRepository.recoverAgentBoardPlugins() : 0;
if (recoveredBoardPlugins) console.log(`Recovered ${recoveredBoardPlugins} Board plugin reconciliation(s) into the durable outbox.`);
const recoveredBoardTaskExecutions = await agentBoardTaskRepository.recoverExpiredExecutions();
if (recoveredBoardTaskExecutions) console.log(`Fenced ${recoveredBoardTaskExecutions} expired Board task execution(s) as uncertain.`);
const credentialRefreshPlatforms: CredentialRefreshPlatform[] = [
  ...(instagramConnectorMode === "official" ? ["instagram" as const] : []),
  ...(youtubeConnectorMode === "official" ? ["youtube" as const] : []),
];
const recoveredCredentialRefreshes = await outboxRepository.recoverCredentialRefreshes(credentialRefreshPlatforms);
if (recoveredCredentialRefreshes) console.log(`Recovered ${recoveredCredentialRefreshes} provider credential refresh(es) into the durable outbox.`);
const recoveredProviderGrantValidations = await outboxRepository.recoverProviderGrantValidations(providerGrantValidationProviders);
if (recoveredProviderGrantValidations) console.log(`Recovered ${recoveredProviderGrantValidations} provider grant validation(s) into the durable outbox.`);
const recoveredProviderDataDeletions = await outboxRepository.recoverProviderDataDeletions();
if (recoveredProviderDataDeletions) console.log(`Recovered ${recoveredProviderDataDeletions} provider data deletion(s) into the durable outbox.`);
const enabledMonitors = await monitorRepository.listEnabled();
for (const monitor of enabledMonitors) {
  await monitorQueue.upsertJobScheduler(monitor.id, { every: monitor.intervalMinutes * 60_000 }, { name: "run-monitor", data: { workspaceId: monitor.workspaceId, monitorId: monitor.id, trigger: "scheduled" } });
}
if (enabledMonitors.length) console.log(`Recovered ${enabledMonitors.length} monitor scheduler(s) from PostgreSQL.`);
await dispatchOutbox();
const dispatcherTimer = setInterval(() => { void dispatchOutbox().catch((error) => console.error("Outbox dispatcher error:", error instanceof Error ? error.message : "Unknown error")); }, 1000);
const correctionRecoveryTimer = setInterval(() => { void outboxRepository.recoverRemoteCorrections().then(()=>dispatchOutbox()).catch((error)=>console.error("Remote correction recovery error:",error instanceof Error?error.message:"Unknown error")); }, 60_000);
const boardPluginRecoveryTimer = boardRuntime ? setInterval(() => { void outboxRepository.recoverAgentBoardPlugins().then(()=>dispatchOutbox()).catch((error)=>console.error("Board plugin recovery error:",error instanceof Error?error.message:"Unknown error")); }, 60_000) : null;
const boardTaskExecutionRecoveryTimer = setInterval(() => { void agentBoardTaskRepository.recoverExpiredExecutions().catch((error)=>console.error("Board task execution recovery error:",error instanceof Error?error.message:"Unknown error")); }, 60_000);
const credentialRefreshRecoveryTimer = credentialRefreshPlatforms.length ? setInterval(() => { void outboxRepository.recoverCredentialRefreshes(credentialRefreshPlatforms).then(()=>dispatchOutbox()).catch((error)=>console.error("Credential refresh recovery error:",error instanceof Error?error.message:"Unknown error")); }, 60_000) : null;
const providerGrantValidationRecoveryTimer = providerGrantValidationProviders.length ? setInterval(() => { void outboxRepository.recoverProviderGrantValidations(providerGrantValidationProviders).then(()=>dispatchOutbox()).catch((error)=>console.error("Provider grant validation recovery error:",error instanceof Error?error.message:"Unknown error")); }, 60_000) : null;
const providerDataDeletionRecoveryTimer = setInterval(() => { void outboxRepository.recoverProviderDataDeletions().then(()=>dispatchOutbox()).catch((error)=>console.error("Provider data deletion recovery error:",error instanceof Error?error.message:"Unknown error")); }, 60_000);

let collaboratorPollRunning=false;
async function pollInstagramCollaborators():Promise<void>{
  if(collaboratorPollRunning)return;collaboratorPollRunning=true;
  try{
    const now=new Date().toISOString();await instagramCollaboratorRepository.recoverMissingPolls({nextAttemptAt:new Date(Date.now()+60_000).toISOString(),expiresAt:new Date(Date.now()+7*24*60*60_000).toISOString(),maxAttempts:20,limit:100});const owner=`instagram-collab-${process.pid}`;const polls=await instagramCollaboratorRepository.claimDuePolls(owner,now,10,120);
    for(const poll of polls){
      try{
        const connector=connectors.get("instagram") as ReturnType<typeof connectors.get>&Partial<Pick<InstagramOfficialConnector,"readCollaboratorStatuses">>;
        let result:Awaited<ReturnType<InstagramOfficialConnector["readCollaboratorStatuses"]>>;
        if(typeof connector.readCollaboratorStatuses==="function")result=await connector.readCollaboratorStatuses({workspaceId:poll.workspaceId,brandId:poll.brandId,contentItemId:poll.contentItemId,accountId:poll.accountId,proofId:poll.proofId,externalMediaId:poll.externalMediaId,requestedUsernames:poll.inviteProof.requestedUsernames,requestedUsernamesSha256:poll.inviteProof.requestedUsernamesSha256});
        else {const capturedAt=new Date().toISOString();const providerResponseSha256=sha256(JSON.stringify({mock:true,proofId:poll.proofId,usernames:poll.inviteProof.requestedUsernames}));const snapshots:CurrentCollaboratorStatusSnapshot[]=poll.inviteProof.requestedUsernames.map((username)=>({workspaceId:poll.workspaceId,brandId:poll.brandId,contentItemId:poll.contentItemId,proofId:poll.proofId,accountId:poll.accountId,externalMediaId:poll.externalMediaId,requestedUsernamesSha256:poll.inviteProof.requestedUsernamesSha256,username,status:"pending",capturedAt,providerResponseSha256}));result={complete:true,availability:"available",capturedAt,rawResponseSha256:providerResponseSha256,snapshots};}
        const decision=decideInstagramCollaboratorPoll(result,poll.attemptCount);
        await instagramCollaboratorRepository.recordPollResult(poll,{snapshots:result.snapshots,providerReadComplete:result.complete,trackingComplete:decision.trackingComplete,availability:result.availability,capturedAt:result.capturedAt,...(result.complete?{rawResponseSha256:result.rawResponseSha256}:{}),...(decision.retryAt?{retryAt:decision.retryAt}:{}),...(!result.complete?{errorSummary:result.error.message}:{})});
      }catch(error){const retryAt=new Date(Date.now()+Math.min(3600,60*2**Math.min(poll.attemptCount,6))*1000).toISOString();await instagramCollaboratorRepository.recordPollResult(poll,{snapshots:[],providerReadComplete:false,trackingComplete:false,availability:"transport_failed",capturedAt:new Date().toISOString(),retryAt,errorSummary:error instanceof Error?error.message:"Collaborator status is temporarily unavailable."});}
    }
  }finally{collaboratorPollRunning=false;}
}
await pollInstagramCollaborators();
const collaboratorPollTimer=setInterval(()=>{void pollInstagramCollaborators().catch((error)=>console.error("Instagram collaborator polling error:",error instanceof Error?error.message:"Unknown error"));},30_000);

const remoteCorrectionWorker = new Worker<RemoteCorrectionJob>("originpost-remote-correction",async(job)=>processRemoteCorrectionJob(job.data,{repository,corrections:remoteCorrectionRepository,connectors,notifications:notificationRepository}),{connection:redisConnection(redisUrl),concurrency:2,lockDuration:300_000});
const boardPluginWorker = boardRuntime ? new Worker<BoardPluginReconcileJob | BoardPluginDeactivateJob | BoardPluginDecisionJob | BoardTaskExecutionJob>("originpost-board-plugins", async(job)=>job.name === "deactivate-board-plugin"
  ? processBoardPluginDeactivate(job.data as BoardPluginDeactivateJob,{boards:agentBoardRepository,runtime:boardRuntime,secret:process.env.HERMES_BOARD_SECRET!})
  : job.name === "decide-board-plugin-write"
    ? processBoardPluginDecision(job.data as BoardPluginDecisionJob,{boards:agentBoardRepository,runtime:boardRuntime,secret:process.env.HERMES_BOARD_SECRET!,organizations:organizationRepository})
    : job.name === "execute-board-task"
      ? processBoardTaskExecution(job.data as BoardTaskExecutionJob,{boards:agentBoardRepository,tasks:agentBoardTaskRepository,runtime:boardRuntime,secret:process.env.HERMES_BOARD_SECRET!,organizations:organizationRepository})
      : processBoardPluginReconcile(job.data as BoardPluginReconcileJob,{boards:agentBoardRepository,runtime:boardRuntime,secret:process.env.HERMES_BOARD_SECRET!,organizations:organizationRepository}),{connection:redisConnection(redisUrl),concurrency:1,lockDuration:300_000}) : null;
const providerGrantValidationWorker = providerGrantValidationQueue ? new Worker<ProviderGrantValidationJob>("originpost-provider-grant-validation", async(job) => {
  if (!credentialEncryptionKey || !providerGrantValidationKeyring) throw new Error("Provider grant validation credentials are unavailable.");
  return processProviderGrantValidation(job.data, {
    lifecycle: providerLifecycleRepository,
    accounts: connectedAccountRepository,
    oauth: oauthRepository,
    credentialEncryptionKey,
    providerLookupKeyring: providerGrantValidationKeyring,
    ...(process.env.META_APP_ID ? { metaAppId: process.env.META_APP_ID } : {}),
    ...(process.env.META_APP_SECRET ? { metaAppSecret: process.env.META_APP_SECRET } : {}),
    ...(process.env.META_GRAPH_API_VERSION ? { metaApiVersion: process.env.META_GRAPH_API_VERSION } : {}),
    ...(process.env.GOOGLE_CLIENT_ID ? { googleClientId: process.env.GOOGLE_CLIENT_ID } : {}),
    ...(process.env.GOOGLE_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_CLIENT_SECRET } : {}),
  }, job.attemptsMade + 1, job.opts.attempts ?? 5);
},{connection:redisConnection(redisUrl),concurrency:2,lockDuration:300_000}) : null;

const publishWorker = new Worker<PublishJob>(
  "originpost-publish",
  async (job) => {
    let item = await repository.get(job.data.workspaceId, job.data.contentItemId);
    if (!item) throw new Error("Content item not found.");
    const target = item.targets.find((entry) => entry.id === job.data.targetId);
    if (!target) throw new Error("Publish target not found.");
    if (target.status === "cancelled" || target.status === "published") return { skipped: true, reason: `target-${target.status}` };
    const draft = item.drafts.find((entry) => entry.id === target.draftId);
    if (!draft) throw new Error("Platform draft not found.");

    if (target.deliveryMode === "manual_handoff") {
      if (target.status === "action_required" || target.status === "acknowledged") return { skipped: true, reason: "handoff-already-delivered" };
      const ready = markTargetStatus(item, target.id, "action_required", systemActor, { deliveryMode: target.deliveryMode });
      await saveResult(repository, ready);
      if (telegram && target.notifyDestinationId && allowedTelegramChats.has(target.notifyDestinationId)) {
        const mediaLine = draft.mediaIds.length ? `\nMedia: ${draft.mediaIds.join(", ")}` : "";
        await telegram.sendMessage(target.notifyDestinationId, `Manual ${target.platform} post is ready\n\n${item.title}\n\n${draft.caption}${mediaLine}\n\nTarget: ${target.id}\nOpen OriginPost, acknowledge the handoff, publish in the native app, then paste the live post link to save proof.`).catch((notificationError) => {
          console.error("Manual handoff notification failed:", notificationError instanceof Error ? notificationError.message : "Unknown error");
        });
      }
      await notify({
        workspaceId: item.workspaceId,
        kind: "action_required",
        severity: "warning",
        title: `Manual ${platformName(target.platform)} post is ready`,
        body: `“${item.title}” is due now. Publish it in the native app, then return to save the live link and proof.`,
        dedupeKey: `publish:${target.id}:manual-handoff-ready`,
        contentItemId: item.id,
        targetId: target.id,
        actionUrl: `/?module=Content&item=${encodeURIComponent(item.id)}`,
      });
      return { targetId: target.id, status: "action_required", notified: Boolean(telegram && target.notifyDestinationId && allowedTelegramChats.has(target.notifyDestinationId)) };
    }

    const idempotencyKey = `publish:${target.id}:v1`;
    const alreadyPublished = hasCompletePublishProof(item, target, draft);
    if (alreadyPublished) return { skipped: true, reason: "already-published" };
    let attemptId = item.publishAttempts.findLast((entry) => entry.idempotencyKey === idempotencyKey && (entry.status === "started" || entry.status === "published"))?.id;
    if (!attemptId) {
      const attemptStarted = startPublishAttempt(item, target.id, idempotencyKey, systemActor, String(job.id ?? ""));
      await saveResult(repository, attemptStarted);
      item = attemptStarted.item;
      attemptId = attemptStarted.attempt.id;
    }

    const publishing = markTargetStatus(item, target.id, "publishing", systemActor, { jobId: job.id });
    await saveResult(repository, publishing);
    item = publishing.item;

    try {
      const account = await connectedAccountRepository.get(item.workspaceId, target.accountId);
      if (!account) throw new Error("The publishing account is no longer connected.");
      if (account.platform !== target.platform) throw new Error("The connected account belongs to another platform.");
      if (account.status !== "healthy" && account.status !== "expiring") throw new Error("The publishing account needs attention. Run Connection Doctor before retrying.");
      const connector = connectors.get(target.platform);
      const connectorIsOfficial = connector.manifest.apiMode === "official";
      if (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now() && !(target.platform === "youtube" && connectorIsOfficial)) throw new Error("Provider access expired before publishing. Reconnect the account before retrying.");
      const media = await connectorMediaForDraft(item.workspaceId, draft);
      const instagramSettings = target.platform === "instagram" && target.settings && "approvedSettingsSha256" in target.settings
        ? target.settings as InstagramPublishSettings
        : undefined;
      const coverMedia=target.platform==="instagram"?await connectorCoverForTarget(item.workspaceId,item.brandId,"instagram",instagramSettings):undefined;
      const publishRequest: PublishRequest = {
        workspaceId: item.workspaceId,
        contentItemId: item.id,
        targetId: target.id,
        accountId: target.accountId,
        draftSha256: draft.contentSha256,
        platform: target.platform,
        format: draft.format,
        caption: draft.caption,
        media,
        ...(coverMedia?{coverMedia}:{}),
        idempotencyKey,
        settings: target.settings ?? {},
      };
      if (target.platform === "youtube" && connectorIsOfficial && publishRequest.settings.privacyStatus !== "private" && (process.env.YOUTUBE_API_COMPLIANCE_AUDITED !== "true" || process.env.YOUTUBE_ALLOW_NON_PRIVATE_PUBLISHING !== "true")) {
        throw new Error("YouTube public or unlisted publishing is locked until the API compliance audit is recorded.");
      }
      const validationErrors = (await connector.validate(publishRequest)).filter((issue) => issue.severity === "error");
      if (validationErrors.length) throw new Error(validationErrors.map((issue) => issue.message).join(" "));
      let publishResult: Extract<PublishResult, { status: "published" }>;
      let providerPublishedAt: string | undefined;
      let instagramInviteProof = target.platform === "instagram" && !connectorIsOfficial
        ? collaboratorInviteProof(instagramSettings, "facebook_login")
        : undefined;
      if (connectorIsOfficial && target.platform === "instagram" && connector instanceof InstagramOfficialConnector) {
        const now = new Date().toISOString();
        const claimOwner = `instagram-publish:${process.pid}:${String(job.id ?? "job")}:${crypto.randomUUID()}`;
        const operationSeed = {
          id: `provider_operation_${sha256(`${item.workspaceId}:${target.id}`).slice(0, 32)}`,
          workspaceId: item.workspaceId,
          contentItemId: item.id,
          targetId: target.id,
          attemptId,
          platform: "instagram",
          accountId: target.accountId,
          draftSha256: draft.contentSha256,
          ...(instagramSettings ? { approvedSettingsSha256: instagramSettings.approvedSettingsSha256 } : {}),
          ...(instagramSettings?.isAiGenerated === true ? { instagramAiDisclosureRequested: true } : {}),
          status: "creating",
          containerId: "",
          childContainerIds: [],
          createdAt: now,
          updatedAt: now,
        } satisfies ProviderPublishOperation;
        const beginning = await beginInstagramProviderOperation({
          repository: providerPublishOperationRepository,
          seed: operationSeed,
          owner: claimOwner,
          createOperation: () => connector.createOperation(publishRequest),
        });
        if (beginning.kind === "busy") {
          const retry = instagramProviderClaimRetry(beginning.operation);
          await publishQueue.add("retry-provider-claim", job.data, {
            jobId: retry.jobId,
            delay: retry.delayMs,
            attempts: 5,
            backoff: { type: "exponential", delay: 30_000 },
            removeOnComplete: 100,
            removeOnFail: 200,
          });
          return { targetId: target.id, status: "waiting", reason: "provider-operation-busy", retryAt: retry.retryAt };
        }
        let operation = beginning.operation;
        if (beginning.kind === "manual-reconcile") {
          const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "instagram_create_result_uncertain", providerOperationId: operation.id });
          await saveResult(repository, needsReview);
          await notifyActionRequired(item, target, "instagram-create-uncertain");
          return { targetId: target.id, status: "action_required", reason: "instagram-create-result-uncertain" };
        }
        if(operation?.collaboratorInviteProof)instagramInviteProof=operation.collaboratorInviteProof;
        const aiDisclosureIntentValid = instagramSettings?.isAiGenerated !== true || operation.instagramAiDisclosureRequested === true;
        const collaboratorBinding=instagramSettings?.approvalBinding;
        const collaboratorOperationValid=!instagramSettings?.collaborators.length||(Boolean(collaboratorBinding)&&operation?.accountId===target.accountId&&operation.draftSha256===draft.contentSha256&&operation.approvedSettingsSha256===instagramSettings.approvedSettingsSha256&&operation.collaboratorInviteProof?.requestState==="requested_unverified"&&operation.collaboratorInviteProof.requestedUsernamesSha256===collaboratorInviteProof(instagramSettings,"facebook_login").requestedUsernamesSha256);
        if(!beginning.created&&((instagramSettings?.collaborators.length&&!collaboratorOperationValid)||!aiDisclosureIntentValid)){operation={...operation,status:"uncertain",lastError:"The recovered Instagram operation does not match the exact approved draft, account, settings, and AI disclosure intent. Reconcile it manually.",updatedAt:new Date().toISOString()};await saveClaimedProviderOperation(providerPublishOperationRepository,operation,claimOwner);const needsReview=markTargetStatus(item,target.id,"action_required",systemActor,{reason:"instagram_publish_settings_lineage_mismatch",providerOperationId:operation.id});await saveResult(repository,needsReview);await notifyActionRequired(item,target,"instagram-publish-settings-lineage-mismatch");return{targetId:target.id,status:"action_required",reason:"instagram-publish-settings-lineage-mismatch"};}
        if (operation.attemptId !== attemptId) {
          operation = { ...operation, attemptId, updatedAt: new Date().toISOString() };
          await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
        }
        const nextStep = officialPublishNextStep(operation);

        if (nextStep === "manual-reconcile" && operation) {
          const now = new Date().toISOString();
          if (operation.status === "finalizing") {
            operation = { ...operation, status: "uncertain", lastError: "The worker restarted after final publishing began. Verify the Instagram account before recording the result.", updatedAt: now };
            await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
          }
          const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id });
          await saveResult(repository, needsReview);
          await notifyActionRequired(item, target, "instagram-result-uncertain");
          return { targetId: target.id, status: "action_required", reason: "provider-result-uncertain" };
        }

        if (nextStep === "complete" && operation) {
          if (!operation.externalPostId || !operation.liveUrl) throw new Error("The saved Instagram result is incomplete and needs manual review.");
          if (instagramSettings?.isAiGenerated === true && operation.instagramAiDisclosureVerified !== true) {
            const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "instagram_ai_disclosure_unverified", providerOperationId: operation.id });
            await saveResult(repository, needsReview);
            await notifyActionRequired(item, target, "instagram-ai-disclosure-unverified");
            return { targetId: target.id, status: "action_required", reason: "instagram-ai-disclosure-unverified" };
          }
          publishResult = { status: "published", externalPostId: operation.externalPostId, liveUrl: operation.liveUrl, rawResponse: { recovered: true, providerOperationId: operation.id, containerId: operation.containerId, isAiGenerated: operation.instagramAiDisclosureVerified === true } };
        } else {
          if (nextStep === "failed" && operation) throw new Error(operation.lastError ?? "The Instagram publishing operation failed.");
          if (operation.status === "processing") {
            try {
              await connector.waitUntilOperationReady(publishRequest, operation.containerId);
              operation = { ...operation, status: "ready", lastError: undefined, updatedAt: new Date().toISOString() };
              await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
            } catch (processingError) {
              const message = processingError instanceof Error ? processingError.message : "Instagram media processing failed.";
              const terminal = message.includes("processing error") || message.includes("processing expired");
              operation = { ...operation, ...(terminal ? { status: "failed" as const } : {}), lastError: message, updatedAt: new Date().toISOString() };
              await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
              throw processingError;
            }
          }

          if (operation.status !== "ready") throw new Error("The Instagram publishing operation is not ready.");
          operation = { ...operation, status: "finalizing", updatedAt: new Date().toISOString() };
          await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
          try {
            publishResult = await connector.finalizeOperation(publishRequest, operation.containerId);
          } catch (finalizeError) {
            const message = finalizeError instanceof Error ? finalizeError.message : "Instagram did not confirm the final publish result.";
            operation = { ...operation, status: "uncertain", lastError: message, updatedAt: new Date().toISOString() };
            await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
            const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id });
            await saveResult(repository, needsReview);
            await notifyActionRequired(item, target, "instagram-recovery-uncertain");
            return { targetId: target.id, status: "action_required", reason: "provider-result-uncertain" };
          }
          const rawPublishResponse = publishResult.rawResponse && typeof publishResult.rawResponse === "object" ? publishResult.rawResponse as Record<string, unknown> : {};
          operation = { ...operation, status: "published", externalPostId: publishResult.externalPostId, liveUrl: publishResult.liveUrl, instagramAiDisclosureVerified: rawPublishResponse.isAiGenerated === true, lastError: undefined, updatedAt: new Date().toISOString() };
          await saveClaimedProviderOperation(providerPublishOperationRepository, operation, claimOwner);
        }
      } else if (connectorIsOfficial && target.platform === "facebook" && connector instanceof FacebookPageOfficialConnector) {
        let operation = await providerPublishOperationRepository.get(item.workspaceId, target.id);
        if (operation?.platform !== "facebook") operation = null;
        let nextStep = facebookPublishNextStep(operation);

        if (nextStep === "create-intent") {
          const now = new Date().toISOString();
          operation = {
            id: `provider_operation_${crypto.randomUUID()}`,
            workspaceId: item.workspaceId,
            contentItemId: item.id,
            targetId: target.id,
            attemptId,
            platform: "facebook",
            status: "ready",
            containerId: facebookIntentMarker(target.id),
            childContainerIds: [],
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderPublishOperation;
          await providerPublishOperationRepository.save(operation);
          nextStep = "create-post";
        } else if (operation && operation.attemptId !== attemptId) {
          operation = { ...operation, attemptId, updatedAt: new Date().toISOString() };
          await providerPublishOperationRepository.save(operation);
        }

        if (!operation) throw new Error("The Facebook Page publish intent could not be saved.");
        if (nextStep === "action-required") {
          if (operation.status !== "uncertain") {
            operation = { ...operation, status: "uncertain", lastError: "A Facebook publish began without a complete verified result. Check the Page before recording proof.", updatedAt: new Date().toISOString() };
            await providerPublishOperationRepository.save(operation);
          }
          const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id, externalPostId: operation.externalPostId });
          await saveResult(repository, needsReview);
          await notifyActionRequired(item, target, "facebook-result-uncertain");
          return { targetId: target.id, status: "action_required", reason: "facebook-result-uncertain" };
        }
        if (nextStep === "failed") throw new Error(operation.lastError ?? "The Facebook Page publish failed.");

        if (nextStep === "finish-proof") {
          if (!operation.externalPostId || !operation.liveUrl) throw new Error("The saved Facebook Page result is incomplete and needs a check.");
          publishResult = { status: "published", externalPostId: operation.externalPostId, liveUrl: operation.liveUrl, rawResponse: { recovered: true, providerOperationId: operation.id } };
        } else {
          let createRawResponse: unknown = { recovered: true, providerOperationId: operation.id };
          if (nextStep === "create-post") {
            operation = { ...operation, status: "finalizing", lastError: undefined, updatedAt: new Date().toISOString() };
            await providerPublishOperationRepository.save(operation);
            try {
              const created = await connector.createPost(publishRequest);
              createRawResponse = created.rawResponse;
              operation = { ...operation, externalPostId: created.externalPostId, updatedAt: new Date().toISOString() };
              await providerPublishOperationRepository.save(operation);
            } catch (createError) {
              const message = createError instanceof Error ? createError.message : "Facebook did not confirm the publish request.";
              operation = { ...operation, status: "uncertain", lastError: message, updatedAt: new Date().toISOString() };
              await providerPublishOperationRepository.save(operation);
              const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id });
              await saveResult(repository, needsReview);
              await notifyActionRequired(item, target, "facebook-create-uncertain");
              return { targetId: target.id, status: "action_required", reason: "facebook-result-uncertain" };
            }
          }

          if (!operation.externalPostId) throw new Error("Facebook did not return a post ID. Check the Page before retrying.");
          let verified: Awaited<ReturnType<FacebookPageOfficialConnector["readPublishedPost"]>>;
          try {
            verified = await connector.readPublishedPost(publishRequest, operation.externalPostId);
          } catch (verifyError) {
            const message = verifyError instanceof Error ? verifyError.message : "Facebook did not return a verified post permalink.";
            operation = { ...operation, status: "uncertain", lastError: message, updatedAt: new Date().toISOString() };
            await providerPublishOperationRepository.save(operation);
            const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id, externalPostId: operation.externalPostId });
            await saveResult(repository, needsReview);
            await notifyActionRequired(item, target, "facebook-verification-uncertain");
            return { targetId: target.id, status: "action_required", reason: "facebook-verification-uncertain" };
          }
          providerPublishedAt = verified.createdAt;
          operation = { ...operation, status: "published", externalPostId: verified.externalPostId, liveUrl: verified.liveUrl, lastError: undefined, updatedAt: new Date().toISOString() };
          await providerPublishOperationRepository.save(operation);
          publishResult = { status: "published", externalPostId: verified.externalPostId, liveUrl: verified.liveUrl, rawResponse: { create: createRawResponse, verify: verified.rawResponse, providerOperationId: operation.id } };
        }
      } else if (connectorIsOfficial && target.platform === "youtube" && connector instanceof YouTubeOfficialConnector) {
        let operation = await providerPublishOperationRepository.get(item.workspaceId, target.id);
        if (operation?.platform !== "youtube") operation = null;
        const nextStep = youtubePublishNextStep(operation);
        if (nextStep === "action-required" && operation) {
          const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id });
          await saveResult(repository, needsReview);
          await notifyActionRequired(item, target, "youtube-result-uncertain");
          return { targetId: target.id, status: "action_required", reason: "youtube-result-uncertain" };
        }
        if (nextStep === "failed" && operation) throw new Error(operation.lastError ?? "The YouTube upload failed.");
        if (!operation) {
          const session = await connector.createUploadSession(publishRequest);
          const now = new Date().toISOString();
          const protectedSessionUri = sealProviderSessionUri(session.sessionUri, credentialEncryptionKey!, item.workspaceId, target.id);
          operation = {
            id: `provider_operation_${crypto.randomUUID()}`,
            workspaceId: item.workspaceId,
            contentItemId: item.id,
            targetId: target.id,
            attemptId,
            platform: "youtube",
            status: "ready",
            containerId: protectedSessionUri,
            childContainerIds: [],
            sessionUri: protectedSessionUri,
            uploadedBytes: 0,
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderPublishOperation;
          await providerPublishOperationRepository.save(operation);
        } else if (operation.attemptId !== attemptId) {
          operation = { ...operation, attemptId, updatedAt: new Date().toISOString() };
          await providerPublishOperationRepository.save(operation);
        }

        let videoId = operation.externalPostId;
        let uploadRawResponse: unknown = { recovered: true, providerOperationId: operation.id };

        if (!videoId) {
          const sessionUri = openProviderSessionUri(operation.sessionUri ?? operation.containerId, credentialEncryptionKey!, item.workspaceId, target.id);
          let startByte = operation.uploadedBytes ?? 0;
          if (operation.status === "finalizing") {
            try {
              const checked = await connector.queryUploadSession(publishRequest, sessionUri);
              if (checked.status === "published") {
                videoId = checked.videoId;
                uploadRawResponse = checked.rawResponse;
              } else {
                startByte = checked.uploadedBytes;
                operation = { ...operation, status: "ready", uploadedBytes: startByte, lastError: undefined, updatedAt: new Date().toISOString() };
                await providerPublishOperationRepository.save(operation);
              }
            } catch (queryError) {
              const message = queryError instanceof Error ? queryError.message : "YouTube could not confirm the resumable upload.";
              operation = { ...operation, status: "uncertain", lastError: message, updatedAt: new Date().toISOString() };
              await providerPublishOperationRepository.save(operation);
              const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id });
              await saveResult(repository, needsReview);
              await notifyActionRequired(item, target, "youtube-session-uncertain");
              return { targetId: target.id, status: "action_required", reason: "youtube-session-uncertain" };
            }
          }
          if (!videoId) {
            operation = { ...operation, status: "finalizing", uploadedBytes: startByte, updatedAt: new Date().toISOString() };
            await providerPublishOperationRepository.save(operation);
            try {
              const uploaded = await connector.uploadFromSession(publishRequest, sessionUri, startByte);
              if (uploaded.status === "incomplete") {
                operation = { ...operation, status: "ready", uploadedBytes: uploaded.uploadedBytes, updatedAt: new Date().toISOString() };
                await providerPublishOperationRepository.save(operation);
                throw new Error("YouTube accepted only part of the video. Resume the same upload session.");
              }
              videoId = uploaded.videoId;
              uploadRawResponse = uploaded.rawResponse;
            } catch (uploadError) {
              if (operation.status !== "ready") {
                try {
                  const checked = await connector.queryUploadSession(publishRequest, sessionUri);
                  if (checked.status === "published") {
                    videoId = checked.videoId;
                    uploadRawResponse = checked.rawResponse;
                  } else {
                    operation = { ...operation, status: "ready", uploadedBytes: checked.uploadedBytes, lastError: uploadError instanceof Error ? uploadError.message : "YouTube upload interrupted.", updatedAt: new Date().toISOString() };
                    await providerPublishOperationRepository.save(operation);
                    throw uploadError;
                  }
                } catch (queryError) {
                  if (queryError === uploadError) throw uploadError;
                  const message = queryError instanceof Error ? queryError.message : "YouTube could not confirm whether the video was uploaded.";
                  operation = { ...operation, status: "uncertain", lastError: message, updatedAt: new Date().toISOString() };
                  await providerPublishOperationRepository.save(operation);
                  const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "provider_result_uncertain", providerOperationId: operation.id });
                  await saveResult(repository, needsReview);
                  await notifyActionRequired(item, target, "youtube-upload-uncertain");
                  return { targetId: target.id, status: "action_required", reason: "youtube-upload-uncertain" };
                }
              } else throw uploadError;
            }
          }
          if (!videoId) throw new Error("YouTube did not return a video ID.");
          const processingStartedAt = Date.now();
          operation = {
            ...operation,
            status: "processing",
            externalPostId: videoId,
            liveUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
            uploadedBytes: media[0]?.sizeBytes,
            processingChecks: 0,
            processingDeadlineAt: new Date(processingStartedAt + YOUTUBE_PROCESSING_TIMEOUT_MS).toISOString(),
            lastError: undefined,
            updatedAt: new Date(processingStartedAt).toISOString(),
          };
          await providerPublishOperationRepository.save(operation);
        }

        if (operation.status !== "published") {
          const processing = await connector.checkProcessing(publishRequest, videoId);
          if (processing.status === "failed") {
            operation = { ...operation, status: "failed", lastError: processing.reason, updatedAt: new Date().toISOString() };
            await providerPublishOperationRepository.save(operation);
            throw new Error(processing.reason);
          }
          if (processing.status === "processing") {
            const advanced = advanceYouTubeProcessingPoll(operation);
            operation = advanced.operation;
            await providerPublishOperationRepository.save(operation);
            if (advanced.action === "action-required") {
              const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "youtube_processing_timeout", providerOperationId: operation.id, processingChecks: operation.processingChecks, processingDeadlineAt: operation.processingDeadlineAt });
              await saveResult(repository, needsReview);
              await notifyActionRequired(item, target, "youtube-processing-timeout");
              return { targetId: target.id, status: "action_required", reason: "youtube-processing-timeout" };
            }
            await publishQueue.add("check-youtube-processing", job.data, { jobId: `${target.id}-processing-${operation.processingChecks}`, delay: YOUTUBE_PROCESSING_POLL_INTERVAL_MS, attempts: 20, backoff: { type: "exponential", delay: YOUTUBE_PROCESSING_POLL_INTERVAL_MS }, removeOnComplete: 100, removeOnFail: 200 });
            return { targetId: target.id, status: "processing", videoId };
          }
          if (!youtubePrivacyMatches(target, processing.privacyStatus)) {
            const expectedPrivacyStatus = target.settings?.privacyStatus ?? "private";
            const actualPrivacyStatus = processing.privacyStatus ?? "unknown";
            operation = { ...operation, status: "uncertain", lastError: `YouTube returned privacy ${actualPrivacyStatus}; expected ${expectedPrivacyStatus}. Check YouTube Studio before recording proof.`, updatedAt: new Date().toISOString() };
            await providerPublishOperationRepository.save(operation);
            const needsReview = markTargetStatus(item, target.id, "action_required", systemActor, { reason: "youtube_privacy_mismatch", providerOperationId: operation.id, expectedPrivacyStatus, actualPrivacyStatus });
            await saveResult(repository, needsReview);
            await notifyActionRequired(item, target, "youtube-privacy-mismatch");
            return { targetId: target.id, status: "action_required", reason: "youtube-privacy-mismatch" };
          }
          operation = { ...operation, status: "published", liveUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, lastError: undefined, updatedAt: new Date().toISOString() };
          await providerPublishOperationRepository.save(operation);
        }
        publishResult = { status: "published", externalPostId: videoId, liveUrl: operation.liveUrl ?? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, rawResponse: { ...((uploadRawResponse && typeof uploadRawResponse === "object") ? uploadRawResponse : {}), providerOperationId: operation.id, processing: "succeeded" } };
      } else {
        const result = await connector.publish(publishRequest);
        if (result.status !== "published") throw new Error("Pending publishing is not enabled in the worker.");
        publishResult = result;
      }

      const approvedBy = item.approvals.findLast((approval) => approval.decision === "approved" && approval.draftId === draft.id)?.actorId ?? systemActor.id;
      const sanitizedPublishResponse = publishResult.rawResponse && typeof publishResult.rawResponse === "object" ? publishResult.rawResponse as Record<string, unknown> : {};
      const instagramAiObserved = target.platform === "instagram" && sanitizedPublishResponse.isAiGenerated === true;
      const completed = completeAutomaticPublication(item, attemptId, target.id, {
        draftId: draft.id,
        draftSha256: draft.contentSha256,
        platform: target.platform,
        accountId: target.accountId,
        externalPostId: publishResult.externalPostId,
        liveUrl: publishResult.liveUrl,
        publishedAt: providerPublishedAt ?? new Date().toISOString(),
        captionSha256: sha256(draft.caption),
        mediaSha256: media.map((entry) => entry.sha256),
        connectorResponseSha256: sha256(JSON.stringify(publishResult.rawResponse)),
        approvedBy,
        sourceIds: item.sources.map((source) => source.id),
        evidenceMode: connectorIsOfficial ? "official" : "simulation",
        disclosure: target.platform === "instagram" ? instagramAiObserved ? "ai-assisted" : "none" : proofDisclosureForTarget(target, draft.containsSyntheticMedia === true),
        ...(target.platform === "instagram" && (instagramSettings?.isAiGenerated === true || instagramAiObserved) ? { instagramAiDisclosure: { requested: instagramSettings?.isAiGenerated === true, observed: instagramAiObserved, label: "ai_info" as const } } : {}),
        ...(instagramSettings ? { approvedSettingsSha256: instagramSettings.approvedSettingsSha256 } : {}),
        ...(target.platform === "instagram" && instagramInviteProof ? { collaboratorInviteProof: instagramInviteProof } : {}),
        ...(target.platform === "instagram" && instagramSettings?.reelCover ? { instagramReelCoverProof: instagramSettings.reelCover } : {}),
      }, systemActor);
      await saveResult(repository, completed);
      const savedProof = completed.item.proofs.at(-1);
      if(savedProof?.platform==="instagram"&&savedProof.collaboratorInviteProof?.requestState==="requested_unverified"){
        if(!savedProof.approvedSettingsSha256||instagramSettings?.approvalBinding?.approvedSettingsSha256!==savedProof.approvedSettingsSha256)throw new Error("Instagram collaborator proof is missing its exact approved settings binding.");
        await instagramCollaboratorRepository.createPollFromStoredProof(completed.item.workspaceId,completed.item.id,savedProof.id,{nextAttemptAt:new Date(Date.now()+60_000).toISOString(),expiresAt:new Date(Date.now()+7*24*60*60_000).toISOString(),maxAttempts:20});
      }
      if (savedProof) {
        await analyticsQueue.add("capture-proof", { workspaceId: completed.item.workspaceId, contentItemId: completed.item.id, proofId: savedProof.id }, {
          jobId: `analytics-${savedProof.id}-initial`, delay: savedProof.platform === "facebook" ? 24 * 60 * 60_000 : 30_000, attempts: 3,
          backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000,
        });
      }
      return { proofId: savedProof?.id, liveUrl: publishResult.liveUrl };
    } catch (error) {
      if (error instanceof ProviderExecutionClaimLostError) {
        const current = await repository.get(job.data.workspaceId, job.data.contentItemId);
        const currentTarget = current?.targets.find((entry) => entry.id === target.id);
        if (current && currentTarget && currentTarget.status !== "published" && currentTarget.status !== "action_required") {
          const needsReview = markTargetStatus(current, target.id, "action_required", systemActor, { reason: "provider_execution_claim_lost", providerOperationId: error.providerOperationId });
          await saveResult(repository, needsReview);
        }
        await notifyActionRequired(current ?? item, currentTarget ?? target, "provider-execution-claim-lost");
        return { targetId: target.id, status: "action_required", reason: "provider-execution-claim-lost" };
      }
      if (item.publishAttempts.find((entry) => entry.id === attemptId)?.status === "started") {
        const attemptFailed = finishPublishAttempt(item, attemptId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown publishing error",
        }, systemActor);
        await saveResult(repository, attemptFailed);
        item = attemptFailed.item;
      }
      const failed = markTargetStatus(item, target.id, "failed", systemActor, {
        error: error instanceof Error ? error.message : "Unknown publishing error",
      });
      await saveResult(repository, failed);
      await notify({
        workspaceId: item.workspaceId,
        kind: "publish_failed",
        severity: "error",
        title: `${platformName(target.platform)} publish failed`,
        body: `“${item.title}” was not confirmed as published. Open the item for the exact error, then retry only after checking the connected account.`,
        dedupeKey: `publish:${target.id}:attempt:${attemptId}:failed`,
        contentItemId: item.id,
        targetId: target.id,
        accountId: target.accountId,
        actionUrl: `/?module=Content&item=${encodeURIComponent(item.id)}`,
      });
      throw error;
    }
  },
  { connection: redisConnection(redisUrl), concurrency: 5, lockDuration: 120_000 },
);

const analyticsWorker = new Worker<AnalyticsJob>(
  "originpost-analytics",
  async (job) => {
    const item = await repository.get(job.data.workspaceId, job.data.contentItemId);
    if (!item) throw new Error("Analytics content item not found.");
    const proof = item.proofs.find((entry) => entry.id === job.data.proofId);
    if (!proof || (proof.platform !== "instagram" && proof.platform !== "facebook" && proof.platform !== "youtube")) throw new Error("Analytics proof not found.");
    const capturedAt = new Date().toISOString();
    const base = {
      id: `analytics_${crypto.randomUUID()}`,
      workspaceId: item.workspaceId,
      brandId: item.brandId,
      contentItemId: item.id,
      proofId: proof.id,
      platform: proof.platform,
      accountId: proof.accountId,
      externalPostId: proof.externalPostId,
      period: "lifetime" as const,
      capturedAt,
      createdAt: capturedAt,
    };
    const saveSnapshot = async (snapshot: PostAnalyticsSnapshot) => {
      const event: AuditEvent = {
        id: `audit_${crypto.randomUUID()}`,
        workspaceId: item.workspaceId,
        contentItemId: item.id,
        actorId: systemActor.id,
        actorType: "system",
        action: "analytics.snapshot-captured",
        detail: { proofId: proof.id, analyticsSnapshotId: snapshot.id, platform: proof.platform, status: snapshot.status, metricKeys: snapshot.metrics.map((metric) => metric.key), rawPayloadSha256: snapshot.rawPayloadSha256 ?? null },
        createdAt: capturedAt,
      };
      await analyticsRepository.save(snapshot, event);
    };

    const connector = connectors.get(proof.platform);
    if (!connector.manifest.capabilities.analytics || !connector.readPostAnalytics) {
      const snapshot: PostAnalyticsSnapshot = { ...base, status: "unsupported", metrics: [], provider: connector.manifest.id, errorCode: "unsupported", errorSummary: `${connector.manifest.name} does not expose post analytics.`, };
      await saveSnapshot(snapshot);
      return { proofId: proof.id, status: snapshot.status };
    }
    const account = await connectedAccountRepository.get(item.workspaceId, proof.accountId);
    if (!account || account.brandId !== item.brandId || account.platform !== proof.platform) {
      const snapshot: PostAnalyticsSnapshot = { ...base, status: "permission_missing", metrics: [], provider: connector.manifest.id, errorCode: "account_unavailable", errorSummary: "The publishing account is unavailable for this brand. Reconnect it before refreshing analytics." };
      await saveSnapshot(snapshot);
      return { proofId: proof.id, status: snapshot.status };
    }

    try {
      const request: AnalyticsRequest = { workspaceId: item.workspaceId, contentItemId: item.id, proofId: proof.id, accountId: proof.accountId, platform: proof.platform, externalPostId: proof.externalPostId, publishedAt: proof.publishedAt };
      const result = await connector.readPostAnalytics(request);
      if (result.metrics.some((metric) => !Number.isFinite(metric.value) || metric.value < 0)) throw new ProviderAnalyticsError("The provider returned invalid analytics values.", "provider_failed");
      const uniqueKeys = new Set(result.metrics.map((metric) => metric.key));
      if (uniqueKeys.size !== result.metrics.length) throw new ProviderAnalyticsError("The provider returned duplicate analytics metrics.", "provider_failed");
      const status = result.status ?? (result.metrics.length ? "ready" : "unavailable");
      if (status === "ready" && !result.metrics.length) throw new ProviderAnalyticsError("The provider marked an empty analytics result as ready.", "provider_failed");
      const snapshot: PostAnalyticsSnapshot = { ...base, capturedAt: result.capturedAt, status, metrics: result.metrics, rawPayloadSha256: sha256(JSON.stringify(result.rawResponse)), provider: connector.manifest.id, ...(result.completeThrough ? { completeThrough: result.completeThrough } : {}), ...(result.caveats?.length ? { caveats: result.caveats } : {}) };
      await saveSnapshot(snapshot);
      return { proofId: proof.id, status: snapshot.status, metrics: snapshot.metrics.length };
    } catch (error) {
      const code = error instanceof ProviderAnalyticsError ? error.code : "provider_failed";
      const retryable = code === "rate_limited" || code === "transient";
      const willRetry = retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
      const status: PostAnalyticsSnapshot["status"] = code === "permission_missing" ? "permission_missing" : code === "unsupported" ? "unsupported" : willRetry ? "pending" : "failed";
      const snapshot: PostAnalyticsSnapshot = { ...base, status, metrics: [], provider: connector.manifest.id, errorCode: code, errorSummary: (error instanceof Error ? error.message : "The provider analytics request failed.").slice(0, 500) };
      await saveSnapshot(snapshot);
      if (willRetry) throw error;
      return { proofId: proof.id, status };
    }
  },
  { connection: redisConnection(redisUrl), concurrency: 3, lockDuration: 120_000 },
);

const researchWorker = new Worker<ResearchJob>(
  "originpost-research",
  async (job) => {
    let item = await repository.get(job.data.workspaceId, job.data.contentItemId);
    if (!item) throw new Error("Content item not found.");
    const run = item.researchRuns.find((entry) => entry.id === job.data.researchRunId);
    if (!run) throw new Error("Research run not found.");
    if (run.status === "completed") return { skipped: true, reason: "already-completed" };
    if (run.status === "running") {
      await saveResult(repository, failResearch(item, run.id, "The previous research attempt was interrupted. Review its outcome before starting a new run.", systemActor));
      throw new UnrecoverableError("Research outcome is uncertain; automatic replay is disabled.");
    }

    const running = markResearchRunning(item, run.id, systemActor);
    await saveResult(repository, running);
    item = running.item;

    let localResearchAttempted = false;
    try {
      const provider = await brandSourcing(item.workspaceId,item.brandId,run.createdBy);
      localResearchAttempted = provider.id === "codex-local";
      const result = await provider.research({
        sessionKey: `originpost-research:${item.workspaceId}:${item.id}`,
        query: run.query,
        context: researchContext(item),
        depth: run.depth,
        languages: run.languages,
        ...(run.region ? { region: run.region } : {}),
        sourceLimit: run.sourceLimit,
        ...(run.freshnessHours ? { freshnessHours: run.freshnessHours } : {}),
      });
      const completed = completeResearch(item, run.id, {
        summary: result.summary,
        sources: result.sources.map((source) => ({
          kind: "url" as const,
          title: source.title,
          url: source.url,
          ...(source.publisher ? { publisher: source.publisher } : {}),
          ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
          ...(source.excerpt ? { excerpt: source.excerpt } : {}),
          ...(source.retrieval ? {retrieval: source.retrieval} : {}),
          retrievedAt: new Date().toISOString(),
          rights: "reference-only",
          confidence: source.confidence,
        })),
        claims: result.claims,
        provider: result.provider,
        model: result.model,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        toolsUsed: result.toolsUsed,
      }, systemActor);
      await saveResult(repository, completed);
      return {
        sourceCount: completed.item.sources.length - item.sources.length,
        claimCount: completed.item.claims.length - item.claims.length,
      };
    } catch (error) {
      const latest = await repository.get(job.data.workspaceId, job.data.contentItemId);
      if (latest) {
        const failed = failResearch(latest, run.id, error instanceof Error ? error.message : "Unknown sourcing error", systemActor);
        await saveResult(repository, failed);
      }
      if (localResearchAttempted) throw new UnrecoverableError("Local Codex research did not finish safely. Review the failed run before starting another request.");
      throw error;
    }
  },
  { connection: redisConnection(redisUrl), concurrency: 2, lockDuration: 300_000 },
);

const monitorWorker = new Worker<MonitorJob>(
  "originpost-monitor",
  async (job) => {
    const monitor = await monitorRepository.get(job.data.workspaceId, job.data.monitorId);
    if (!monitor || !monitor.enabled) return { skipped: true };
    const startedAt = new Date().toISOString();
    const run: MonitorRun = {
      id: `monitor_run_${crypto.randomUUID()}`,
      workspaceId: monitor.workspaceId,
      monitorId: monitor.id,
      status: "running",
      trigger: job.data.trigger ?? "scheduled",
      ...(job.id ? { jobId: String(job.id) } : {}),
      discoveredCount: 0,
      newCount: 0,
      startedAt,
    };
    const acquired = await monitorRepository.startRun(run);
    if (!acquired) {
      await monitorRepository.recordSkipped({ ...run, status: "skipped", reason: "monitor_already_running", completedAt: new Date().toISOString() });
      return { skipped: true, reason: "monitor-already-running" };
    }

    let localResearchAttempted = false;
    try {
      const monitorSourcing = selectMonitorSourcingProvider(monitor, {id:"brand-runtime",health:async()=>true,research:async request=>{const provider=await brandSourcing(monitor.workspaceId,monitor.brandId,monitorResearchActor(process.env.AUTH_MODE??"single-user",monitor,job.data));localResearchAttempted=provider.id==="codex-local";return provider.research(request);}}, lumaMumbaiSourcing, configuredWebsiteProvider(monitor.sourceIntelligence?.sources.filter(s => s.enabled && s.kind === "publisher_site") ?? [], monitor.workspaceId, monitor.brandId));
      const result = await monitorSourcing.research({
        sessionKey: `originpost-monitor:${monitor.workspaceId}:${monitor.id}`,
        query: monitor.query,
        context: monitor.sourceIntelligence ? `Scheduled monitor: ${monitor.name}\n${sourceIntelligenceResearchContext(monitor.sourceIntelligence)}` : `Scheduled monitor: ${monitor.name}`,
        depth: monitor.depth,
        languages: monitor.languages,
        ...(monitor.region ? { region: monitor.region } : {}),
        sourceLimit: monitor.sourceLimit,
        freshnessHours: monitor.freshnessHours,
      });
      if (monitor.sourceIntelligence?.mode === "tracked_sources") {
        const completedAt = new Date().toISOString();
        const ranked = rankSourceSignals(monitor, { monitorRunId: run.id, provider: result.provider, model: result.model, ...(result.responseId ? { responseId: result.responseId } : {}), toolsUsed: result.toolsUsed, suggestions: result.suggestions, sources: result.sources, claims: result.claims }, completedAt);
        const ingested = await sourceSignalRepository.ingest(ranked);
        const sourceFailures = result.toolsUsed.filter(tool => tool.startsWith("feed_failed:") || tool.startsWith("collector_failed:"));
        const completed: MonitorRun = { ...run, status: "completed", provider: result.provider, ...(result.responseId ? { responseId: result.responseId } : {}), ...(sourceFailures.length ? { reason: `Partial source failure: ${sourceFailures.map(value => value.split(":").slice(1).join(":")).join(", ").slice(0, 600)}` } : {}), discoveredCount: result.sources.length, newCount: ingested.newCount, completedAt };
        await monitorRepository.finishRun(completed, []);
        if (ingested.newCount > 0) {
          await notify({ workspaceId: monitor.workspaceId, kind: "monitor_new_findings", severity: ingested.signals.some((signal) => signal.urgency === "high" && signal.state === "new") ? "warning" : "info", title: `${ingested.newCount} new source ${ingested.newCount === 1 ? "signal" : "signals"}`, body: `${monitor.name} found ranked public-source updates. Review them in Signals before anything enters the Content Inbox.`, dedupeKey: `monitor:${monitor.id}:run:${run.id}:signals`, monitorId: monitor.id, actionUrl: "/?module=signals" });
          if (telegram && monitor.notifyDestinationId && allowedTelegramChats.has(monitor.notifyDestinationId)) await telegram.sendMessage(monitor.notifyDestinationId, `${ingested.newCount} new OriginPost source ${ingested.newCount === 1 ? "signal" : "signals"}\n\n${ingested.signals.slice(0, 5).map((signal) => `• ${signal.title} · ${signal.score}/100`).join("\n")}\n\nOpen Signals to save or dismiss each item.`).catch((notificationError) => console.error("Telegram signal notification failed:", notificationError instanceof Error ? notificationError.message : "Unknown error"));
        }
        return { signalIds: ingested.signals.map((signal) => signal.id), newCount: ingested.newCount, updatedCount: ingested.updatedCount };
      }
      const candidates: Array<{ source: (typeof result.sources)[number]; fingerprint: string }> = [];
      for (const source of result.sources) {
        const fingerprint = sourceFingerprint(source.url);
        if (!await monitorRepository.hasFingerprint(monitor.workspaceId, monitor.id, fingerprint)) candidates.push({ source, fingerprint });
      }
      if (candidates.length === 0) {
        const completed: MonitorRun = { ...run, status: "completed", provider: result.provider, ...(result.responseId ? { responseId: result.responseId } : {}), discoveredCount: result.sources.length, completedAt: new Date().toISOString() };
        await monitorRepository.finishRun(completed, []);
        return { newCount: 0 };
      }

      const completedAt = new Date().toISOString();
      const grouped = groupMonitorSuggestions(result, candidates);
      const contentItemIds: string[] = [];
      for (const group of grouped) {
        const groupUrls = new Set(group.candidates.map((candidate) => candidate.source.url));
        const created = createMonitorSuggestion({
          workspaceId: monitor.workspaceId, brandId: monitor.brandId, monitorId: monitor.id, monitorRunId: run.id, title: group.suggestion.title, summary: group.suggestion.summary,
          query: monitor.query, depth: monitor.depth, languages: monitor.languages, ...(monitor.region ? { region: monitor.region } : {}), freshnessHours: monitor.freshnessHours, sourceLimit: monitor.sourceLimit,
          sources: group.candidates.map(({ source }) => ({ kind: "url" as const, title: source.title, url: source.url, ...(source.publisher ? { publisher: source.publisher } : {}), ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}), ...(source.excerpt ? { excerpt: source.excerpt } : {}), ...(source.retrieval ? { retrieval: source.retrieval } : {}), retrievedAt: completedAt, rights: "reference-only" as const, confidence: source.confidence })),
          claims: result.claims.filter((claim) => claim.sourceUrls.some((url) => groupUrls.has(url))), provider: result.provider, model: result.model, ...(result.responseId ? { responseId: result.responseId } : {}), toolsUsed: result.toolsUsed,
        }, systemActor, completedAt);
        const fingerprints = group.candidates.map(({ source, fingerprint }) => ({ workspaceId: monitor.workspaceId, monitorId: monitor.id, fingerprint, sourceUrl: source.url, contentItemId: created.item.id, firstSeenAt: completedAt }));
        await repository.commit(created.item, created.event, [], [], fingerprints);
        contentItemIds.push(created.item.id);
      }
      const completed: MonitorRun = {
        ...run,
        status: "completed",
        provider: result.provider,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        contentItemId: contentItemIds[0],
        contentItemIds,
        discoveredCount: result.sources.length,
        newCount: candidates.length,
        completedAt,
      };
      await monitorRepository.finishRun(completed, []);
      await notify({
        workspaceId: monitor.workspaceId,
        kind: "monitor_new_findings",
        severity: "info",
        title: `${contentItemIds.length} new monitor ${contentItemIds.length === 1 ? "story" : "stories"}`,
        body: `${monitor.name} found ${candidates.length} new source ${candidates.length === 1 ? "result" : "results"}. Review the grouped stories before creating a post.`,
        dedupeKey: `monitor:${monitor.id}:run:${run.id}:findings`,
        monitorId: monitor.id,
        contentItemId: contentItemIds[0],
        actionUrl: "/?module=Inbox",
      });
      if (telegram && monitor.notifyDestinationId && allowedTelegramChats.has(monitor.notifyDestinationId)) {
        await telegram.sendMessage(monitor.notifyDestinationId, `${contentItemIds.length} new OriginPost monitor ${contentItemIds.length === 1 ? "finding" : "findings"}\n\n${grouped.slice(0, 5).map((entry) => `• ${entry.suggestion.title}`).join("\n")}\n\nOpen the inbox to check sources and decide what to do.`).catch((notificationError) => {
          console.error("Telegram monitor notification failed:", notificationError instanceof Error ? notificationError.message : "Unknown error");
        });
      }
      return { contentItemIds, newCount: candidates.length };
    } catch (error) {
      const failed: MonitorRun = { ...run, status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Unknown monitor error", completedAt: new Date().toISOString() };
      await monitorRepository.finishRun(failed, []);
      await notify({
        workspaceId: monitor.workspaceId,
        kind: "monitor_failed",
        severity: "error",
        title: `Monitor failed: ${monitor.name}`,
        body: `${failed.error ?? "The monitor could not complete."} Open Automations to check its run history and configuration.`,
        dedupeKey: `monitor:${monitor.id}:run:${run.id}:failed`,
        monitorId: monitor.id,
        actionUrl: "/?module=Automations",
      });
      if (localResearchAttempted) throw new UnrecoverableError("Local Codex monitoring did not finish safely. Review this run before retrying.");
      throw error;
    }
  },
  { connection: redisConnection(redisUrl), concurrency: 2, lockDuration: 300_000 },
);

publishWorker.on("completed", (job) => console.log(`Publish job ${job.id} completed.`));
publishWorker.on("failed", (job, error) => console.error(`Publish job ${job?.id} failed:`, error.message));
publishWorker.on("error", (error) => console.error("Publish worker error:", error.message));
researchWorker.on("completed", (job) => console.log(`Research job ${job.id} completed.`));
researchWorker.on("failed", (job, error) => console.error(`Research job ${job?.id} failed:`, error.message));
researchWorker.on("error", (error) => console.error("Research worker error:", error.message));
monitorWorker.on("completed", (job) => console.log(`Monitor job ${job.id} completed.`));
monitorWorker.on("failed", (job, error) => console.error(`Monitor job ${job?.id} failed:`, error.message));
monitorWorker.on("error", (error) => console.error("Monitor worker error:", error.message));
analyticsWorker.on("completed", (job) => console.log(`Analytics job ${job.id} completed.`));
analyticsWorker.on("failed", (job, error) => console.error(`Analytics job ${job?.id} failed:`, error.message));
analyticsWorker.on("error", (error) => console.error("Analytics worker error:", error.message));
remoteCorrectionWorker.on("failed",(job,error)=>console.error(`Remote correction job ${job?.id} failed:`,error.message));
  remoteCorrectionWorker.on("error",(error)=>console.error("Remote correction worker error:",error.message));
boardPluginWorker?.on("failed",(job,error)=>console.error(`Board plugin job ${job?.id} failed:`,error.message));
boardPluginWorker?.on("error",(error)=>console.error("Board plugin worker error:",error.message));
providerGrantValidationWorker?.on("failed",(job,error)=>console.error(`Provider grant validation job ${job?.id} failed:`,error.message));
providerGrantValidationWorker?.on("error",(error)=>console.error("Provider grant validation worker error:",error.message));

async function shutdown() {
  clearInterval(dispatcherTimer);
  clearInterval(correctionRecoveryTimer);
  if(boardPluginRecoveryTimer)clearInterval(boardPluginRecoveryTimer);
  clearInterval(boardTaskExecutionRecoveryTimer);
  if(credentialRefreshRecoveryTimer)clearInterval(credentialRefreshRecoveryTimer);
  if(providerGrantValidationRecoveryTimer)clearInterval(providerGrantValidationRecoveryTimer);
  clearInterval(providerDataDeletionRecoveryTimer);
  clearInterval(collaboratorPollTimer);
  evergreenRuntime.close();
  await Promise.all([publishWorker.close(), researchWorker.close(), monitorWorker.close(), analyticsWorker.close(), remoteCorrectionWorker.close(), publishQueue.close(), monitorQueue.close(), analyticsQueue.close(), remoteCorrectionQueue.close(), engagementRuntime.close(), firstCommentRuntime.close(), ...(boardPluginWorker ? [boardPluginWorker.close()] : []), ...(boardPluginQueue ? [boardPluginQueue.close()] : []), ...(providerGrantValidationWorker ? [providerGrantValidationWorker.close()] : []), ...(providerGrantValidationQueue ? [providerGrantValidationQueue.close()] : []), ...(privateConversationRuntime ? [privateConversationRuntime.close()] : [])]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
