import { AudioModule } from './audio/audio.module.js';
import { adminNetworkAllowed } from './common/admin-network.js';
import { AgentPostsModule } from "./agent-posts/agent-posts.module.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { AuthContextGuard } from "./common/auth-context.guard.js";
import { ContentModule } from "./content/content.module.js";
import { InfrastructureModule } from "./infrastructure/infrastructure.module.js";
import { MonitoringModule } from "./monitoring/monitoring.module.js";
import { MediaModule } from "./media/media.module.js";
import { SystemModule } from "./system/system.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { EngagementModule } from "./engagement/engagement.module.js";
import { AutomationModule } from "./automation/automation.module.js";
import { RemoteCorrectionModule } from "./remote-correction/remote-correction.module.js";
import { PrivateConversationsModule } from "./private-conversations/private-conversations.module.js";
import { BatchOperationsModule } from "./batch-operations/batch-operations.module.js";
import { ShareCaptureModule } from "./share-capture/share-capture.module.js";
import { SourceSignalsModule } from "./source-signals/source-signals.module.js";
import { EvergreenModule } from "./evergreen/evergreen.module.js";
import { AgentRuntimeModule } from "./agent-runtimes/agent-runtime.module.js";
import { CreativeStudioModule } from "./creative-studio/creative-studio.module.js";
import { ImageGenerationModule } from "./image-generation/image-generation.module.js";
import { FirstCommentModule } from "./first-comments/first-comment.module.js";
import { PostingQueueModule } from "./posting-queues/posting-queue.module.js";
import { BoardsModule } from "./boards/boards.module.js";
import { ProviderLifecycleModule } from "./provider-lifecycle/provider-lifecycle.module.js";
import { parseProviderLookupKeyring } from "./provider-lifecycle/provider-lookup-keyring.js";

function boundedInteger(input: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(input[key] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
  return value;
}

export function validateConfig(input: Record<string, unknown>) {
  const environment = String(input.NODE_ENV ?? "development");
  const authMode = String(input.AUTH_MODE ?? "single-user");
  const oidcEnabled = String(input.OIDC_ENABLED ?? "false") === "true";
  const oidcAutoProvision = String(input.OIDC_AUTO_PROVISION ?? "false") === "true";
  const instagramMode = String(input.INSTAGRAM_CONNECTOR_MODE ?? input.CONNECTOR_MODE ?? "mock");
  const facebookMode = String(input.FACEBOOK_CONNECTOR_MODE ?? "mock");
  const facebookAnalyticsMode = String(input.FACEBOOK_ANALYTICS_CONNECTOR_MODE ?? "disabled");
  const youtubeMode = String(input.YOUTUBE_CONNECTOR_MODE ?? "mock");
  const privateMessageMode = String(input.PRIVATE_MESSAGE_CONNECTOR_MODE ?? "disabled");
  const imageGenerationMode = String(input.IMAGE_GENERATION_MODE ?? "disabled");
  const livePublishing = String(input.ALLOW_LIVE_PUBLISH ?? "false") === "true";
  const mediaMalwareScanMode = String(input.MEDIA_MALWARE_SCAN_MODE ?? "disabled");
  if (!["development", "production", "test"].includes(environment)) throw new Error("NODE_ENV must be development, production, or test.");
  if (!["single-user", "sessions"].includes(authMode)) throw new Error("AUTH_MODE must be single-user or sessions.");
  if (!["true", "false"].includes(String(input.OIDC_ENABLED ?? "false"))) throw new Error("OIDC_ENABLED must be true or false.");
  if (!["true", "false"].includes(String(input.OIDC_AUTO_PROVISION ?? "false"))) throw new Error("OIDC_AUTO_PROVISION must be true or false.");
  if (oidcEnabled && authMode !== "sessions") throw new Error("OIDC single sign-on requires AUTH_MODE=sessions.");
  if (!["mock", "official"].includes(instagramMode) || !["mock", "official"].includes(facebookMode) || !["mock", "official"].includes(youtubeMode)) throw new Error("Connector modes must be mock or official.");
  if (!["disabled", "official"].includes(facebookAnalyticsMode)) throw new Error("FACEBOOK_ANALYTICS_CONNECTOR_MODE must be disabled or official.");
  if (!["disabled", "mock", "official"].includes(privateMessageMode)) throw new Error("PRIVATE_MESSAGE_CONNECTOR_MODE must be disabled, mock, or official.");
  if (!["disabled", "openai"].includes(imageGenerationMode)) throw new Error("IMAGE_GENERATION_MODE must be disabled or openai.");
  const imageModel = String(input.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-sunburst").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(imageModel)) throw new Error("OPENAI_IMAGE_MODEL contains unsupported characters.");
  const imageCredential = String(input.OPENAI_IMAGE_API_KEY ?? input.OPENAI_API_KEY ?? "").trim();
  if (imageGenerationMode === "openai" && !imageCredential) throw new Error("OpenAI image generation requires OPENAI_IMAGE_API_KEY or OPENAI_API_KEY.");
  const imageTimeoutMs = boundedInteger(input, "OPENAI_IMAGE_TIMEOUT_MS", 180_000, 10_000, 300_000);
  if (!["disabled", "clamav"].includes(mediaMalwareScanMode)) throw new Error("MEDIA_MALWARE_SCAN_MODE must be disabled or clamav.");
  if (livePublishing && mediaMalwareScanMode !== "clamav") throw new Error("Live publishing requires MEDIA_MALWARE_SCAN_MODE=clamav so every uploaded file is scanned before use.");
  if (environment === "production" && privateMessageMode === "mock") throw new Error("PRIVATE_MESSAGE_CONNECTOR_MODE=mock is forbidden in production.");
  if (privateMessageMode === "official" && authMode !== "sessions") throw new Error("Official private messaging requires AUTH_MODE=sessions.");
  if ((livePublishing || instagramMode === "official" || facebookMode === "official" || youtubeMode === "official") && authMode !== "sessions") {
    throw new Error("Official or live publishing requires AUTH_MODE=sessions. Single-user mode must stay on a trusted local machine.");
  }
  if (environment === "production" && !input.DATABASE_URL) throw new Error("DATABASE_URL is required in production.");
  if (environment === "production" && String(input.REVIEW_LINK_SECRET ?? "").length < 32) throw new Error("REVIEW_LINK_SECRET must contain at least 32 characters in production.");
  if (environment === "production" && /(replace-with|change-this)/i.test(String(input.REVIEW_LINK_SECRET ?? ""))) throw new Error("Replace the example REVIEW_LINK_SECRET before production startup.");
  const mediaDeliverySecret = String(input.MEDIA_DELIVERY_SECRET ?? "");
  if (mediaDeliverySecret && Buffer.byteLength(mediaDeliverySecret, "utf8") < 32) throw new Error("MEDIA_DELIVERY_SECRET must contain at least 32 bytes.");
  if (environment === "production" && /(replace-with|change-this)/i.test(mediaDeliverySecret)) throw new Error("Replace the example MEDIA_DELIVERY_SECRET before production startup.");
  if (environment === "production" && /(replace-with|change-this)/i.test(String(input.S3_SECRET_KEY ?? ""))) throw new Error("Replace the example S3_SECRET_KEY before production startup.");
  if (authMode === "sessions") {
    if (!String(input.BOOTSTRAP_ADMIN_EMAIL ?? "").includes("@")) throw new Error("BOOTSTRAP_ADMIN_EMAIL is required when AUTH_MODE=sessions.");
    if (String(input.BOOTSTRAP_ADMIN_PASSWORD ?? "").length < 12) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters when AUTH_MODE=sessions.");
  }
  if (oidcEnabled) {
    const issuer = String(input.OIDC_ISSUER_URL ?? "").trim();
    const redirectUri = String(input.OIDC_REDIRECT_URI ?? "").trim();
    const webReturnUrl = String(input.OIDC_WEB_RETURN_URL ?? "").trim();
    const clientId = String(input.OIDC_CLIENT_ID ?? "").trim();
    for (const [key, value] of [["OIDC_ISSUER_URL", issuer], ["OIDC_REDIRECT_URI", redirectUri], ["OIDC_WEB_RETURN_URL", webReturnUrl]] as const) {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error(`${key} must be an absolute URL.`); }
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(environment !== "production" && url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) throw new Error(`${key} must use HTTPS${environment !== "production" ? " or loopback HTTP" : ""}.`);
    }
    if (!clientId) throw new Error("OIDC_CLIENT_ID is required when OIDC is enabled.");
    if (environment === "production" && /(replace-with|change-this)/i.test(String(input.OIDC_CLIENT_SECRET ?? ""))) throw new Error("Replace the example OIDC_CLIENT_SECRET before production startup.");
    if (new URL(issuer).search) throw new Error("OIDC_ISSUER_URL must not contain a query string.");
    if (new URL(redirectUri).pathname !== "/v1/auth/oidc/callback" || new URL(redirectUri).search) throw new Error("OIDC_REDIRECT_URI must use the exact /v1/auth/oidc/callback path without a query string.");
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(input.OIDC_GROUPS_CLAIM ?? "groups"))) throw new Error("OIDC_GROUPS_CLAIM contains unsupported characters.");
    if (!["owner", "manager", "creator", "viewer"].includes(String(input.OIDC_DEFAULT_ROLE ?? "viewer"))) throw new Error("OIDC_DEFAULT_ROLE must be owner, manager, creator, or viewer.");
  }
  const encryptionKey = String(input.CREDENTIAL_ENCRYPTION_KEY ?? "").trim();
  if (encryptionKey) {
    const decoded = /^[a-f0-9]{64}$/i.test(encryptionKey) ? Buffer.from(encryptionKey, "hex") : Buffer.from(encryptionKey, "base64");
    if (decoded.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  const metaId = String(input.META_APP_ID ?? "").trim();
  const metaSecret = String(input.META_APP_SECRET ?? "").trim();
  const providerCallbacksEnabled = String(input.META_PROVIDER_CALLBACKS_ENABLED ?? "false") === "true";
  if (!['true','false'].includes(String(input.META_PROVIDER_CALLBACKS_ENABLED ?? "false"))) throw new Error("META_PROVIDER_CALLBACKS_ENABLED must be true or false.");
  if (Boolean(metaId) !== Boolean(metaSecret)) throw new Error("META_APP_ID and META_APP_SECRET must be configured together.");
  if (metaId && !encryptionKey) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required when Meta OAuth is configured.");
  const googleClientId = String(input.GOOGLE_CLIENT_ID ?? "").trim();
  const providerLookupKeys = String(input.PROVIDER_LOOKUP_HMAC_KEYS ?? "").trim();
  const providerLookupActiveVersion = String(input.PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION ?? "").trim();
  if (providerLookupKeys || providerLookupActiveVersion) parseProviderLookupKeyring(providerLookupKeys, providerLookupActiveVersion);
  if ((metaId || googleClientId) && (!providerLookupKeys || !providerLookupActiveVersion)) throw new Error("Provider OAuth requires PROVIDER_LOOKUP_HMAC_KEYS and PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION.");
  if (providerCallbacksEnabled) {
    if (!metaId || !metaSecret || !input.DATABASE_URL) throw new Error("Meta provider callbacks require Meta app credentials and PostgreSQL.");
    if (!providerLookupKeys || !providerLookupActiveVersion) throw new Error("Meta provider callbacks require a provider lookup HMAC keyring.");
    const statusKeyValue = String(input.PROVIDER_DELETION_STATUS_KEY ?? "").trim();
    const statusKey = /^[a-f0-9]{64,}$/i.test(statusKeyValue) && statusKeyValue.length % 2 === 0 ? Buffer.from(statusKeyValue, "hex") : Buffer.from(statusKeyValue, "base64");
    if (statusKey.length < 32) throw new Error("PROVIDER_DELETION_STATUS_KEY must decode to at least 32 bytes when Meta callbacks are enabled.");
    if (environment === "production" && !/^[a-f0-9]{64}$/.test(String(input.META_DEAUTH_CALLBACK_CONTRACT_PROBE_SHA256 ?? ""))) throw new Error("Production Meta callbacks require META_DEAUTH_CALLBACK_CONTRACT_PROBE_SHA256 from a watched App Dashboard test.");
  }
  const privateMessageEncryptionKey = String(input.PRIVATE_MESSAGE_ENCRYPTION_KEY ?? "").trim();
  const privateMessageHashKey = String(input.PRIVATE_MESSAGE_HASH_KEY ?? "").trim();
  if (Boolean(privateMessageEncryptionKey) !== Boolean(privateMessageHashKey)) throw new Error("PRIVATE_MESSAGE_ENCRYPTION_KEY and PRIVATE_MESSAGE_HASH_KEY must be configured together.");
  if (privateMessageEncryptionKey) {
    const decodedEncryptionKey = /^[a-f0-9]{64}$/i.test(privateMessageEncryptionKey) ? Buffer.from(privateMessageEncryptionKey, "hex") : Buffer.from(privateMessageEncryptionKey, "base64");
    const decodedHashKey = /^[a-f0-9]{64}$/i.test(privateMessageHashKey) ? Buffer.from(privateMessageHashKey, "hex") : Buffer.from(privateMessageHashKey, "base64");
    if (decodedEncryptionKey.length !== 32 || decodedHashKey.length < 32) throw new Error("PRIVATE_MESSAGE_ENCRYPTION_KEY must decode to exactly 32 bytes and PRIVATE_MESSAGE_HASH_KEY to at least 32 bytes.");
  }
  if (privateMessageMode === "official" && (!privateMessageEncryptionKey || !privateMessageHashKey)) throw new Error("Official private messaging requires PRIVATE_MESSAGE_ENCRYPTION_KEY and PRIVATE_MESSAGE_HASH_KEY.");
  if (privateMessageMode === "official" && (!input.DATABASE_URL || !input.REDIS_URL)) throw new Error("Official private messaging requires DATABASE_URL and REDIS_URL for durable intake and processing.");
  if (privateMessageMode === "official" && (!metaId || !metaSecret || !String(input.META_GRAPH_API_VERSION ?? "").trim() || !encryptionKey)) throw new Error("Official private messaging requires META_GRAPH_API_VERSION, META_APP_ID, META_APP_SECRET, and CREDENTIAL_ENCRYPTION_KEY.");
  if (privateMessageMode === "official" && !/^[a-f0-9]{64}$/.test(String(input.META_PRIVATE_MESSAGING_APP_REVIEW_SHA256 ?? ""))) throw new Error("Official private messaging requires META_PRIVATE_MESSAGING_APP_REVIEW_SHA256 as a lowercase SHA-256 evidence reference.");
  if (privateMessageMode === "official") {
    let publicApi: URL;
    try { publicApi = new URL(String(input.API_PUBLIC_URL ?? "")); } catch { throw new Error("Official private messaging requires a public HTTPS API_PUBLIC_URL."); }
    if (publicApi.protocol !== "https:" || publicApi.username || publicApi.password || publicApi.search || publicApi.hash || publicApi.pathname !== "/") throw new Error("Official private messaging requires a public HTTPS API_PUBLIC_URL origin.");
  }
  if (metaId) {
    for (const key of ["API_PUBLIC_URL", "WEB_PUBLIC_URL"] as const) {
      const value=String(input[key]??(key==="API_PUBLIC_URL"?"http://localhost:4000":"http://localhost:3000")).trim();let url:URL;
      try{url=new URL(value);}catch{throw new Error(`${key} must be an absolute URL.`);}
      const loopback=["localhost","127.0.0.1","::1"].includes(url.hostname);
      if((url.protocol!=="https:"&&!(environment!=="production"&&url.protocol==="http:"&&loopback))||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error(`${key} must be an origin-only HTTPS URL${environment!=="production"?" or loopback HTTP":""}.`);
    }
  }
  if (facebookMode === "official") {
    if (!String(input.META_GRAPH_API_VERSION ?? "").trim() || !metaSecret) throw new Error("Official Facebook Page mode requires META_GRAPH_API_VERSION and META_APP_SECRET.");
    if (!encryptionKey) throw new Error("Official Facebook Page mode requires CREDENTIAL_ENCRYPTION_KEY.");
  }
  if (facebookAnalyticsMode === "official") {
    if (facebookMode !== "official") throw new Error("Official Facebook analytics requires FACEBOOK_CONNECTOR_MODE=official.");
    const analyticsReview = String(input.FACEBOOK_ANALYTICS_APP_REVIEW_SHA256 ?? "").trim();
    const analyticsProbeResult = String(input.FACEBOOK_ANALYTICS_CONTRACT_PROBE_RESULT_SHA256 ?? "").trim();
    const analyticsProbe = ["FACEBOOK_ANALYTICS_CONTRACT_PROBE_API_VERSION", "FACEBOOK_ANALYTICS_CONTRACT_PROBE_VERIFIED_AT", "FACEBOOK_ANALYTICS_CONTRACT_PROBE_EXPIRES_AT"].map((key) => String(input[key] ?? "").trim());
    if (!metaId || !/^[a-f0-9]{64}$/u.test(analyticsReview)) throw new Error("Official Facebook analytics requires META_APP_ID and a lowercase FACEBOOK_ANALYTICS_APP_REVIEW_SHA256 evidence digest.");
    if (!/^[a-f0-9]{64}$/u.test(analyticsProbeResult)) throw new Error("Official Facebook analytics requires FACEBOOK_ANALYTICS_CONTRACT_PROBE_RESULT_SHA256 as a lowercase digest of the watched probe result.");
    if (!analyticsProbe.every(Boolean) || analyticsProbe[0] !== String(input.META_GRAPH_API_VERSION ?? "").trim()) throw new Error("Facebook analytics requires a complete contract probe for the exact META_GRAPH_API_VERSION.");
    const verifiedAt = Date.parse(analyticsProbe[1]!); const expiresAt = Date.parse(analyticsProbe[2]!); const now = Date.now();
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || verifiedAt > now || expiresAt <= now || expiresAt - verifiedAt > 30 * 24 * 60 * 60_000) throw new Error("Facebook analytics contract probe must be current and expire within 30 days.");
  }
  const webhookVerifyToken = String(input.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  const facebookWebhookTokenOverride = String(input.META_FACEBOOK_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  const facebookWebhookVerifyToken = facebookWebhookTokenOverride || webhookVerifyToken;
  if (webhookVerifyToken && webhookVerifyToken.length < 24) throw new Error("META_WEBHOOK_VERIFY_TOKEN must contain at least 24 characters.");
  if (facebookWebhookTokenOverride && facebookWebhookTokenOverride.length < 24) throw new Error("META_FACEBOOK_WEBHOOK_VERIFY_TOKEN must contain at least 24 characters.");
  if (instagramMode === "official" && webhookVerifyToken.length < 24) throw new Error("Official Instagram mode requires META_WEBHOOK_VERIFY_TOKEN for signed engagement webhooks.");
  if (facebookMode === "official" && facebookWebhookVerifyToken.length < 24) throw new Error("Official Facebook Page mode requires a webhook verification token.");
  if (privateMessageMode === "official" && webhookVerifyToken.length < 24) throw new Error("Official private messaging requires META_WEBHOOK_VERIFY_TOKEN for both linked Instagram and Facebook Page webhooks.");
  const facebookReplyProbeApiVersion = String(input.FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_API_VERSION ?? "").trim();
  const facebookReplyProbeVerifiedAt = String(input.FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT ?? "").trim();
  if (Boolean(facebookReplyProbeApiVersion) !== Boolean(facebookReplyProbeVerifiedAt)) throw new Error("Facebook comment reply contract probe version and verification time must be configured together.");
  if (facebookReplyProbeApiVersion && facebookReplyProbeApiVersion !== String(input.META_GRAPH_API_VERSION ?? "").trim()) throw new Error("The Facebook comment reply contract probe must match META_GRAPH_API_VERSION exactly.");
  if (facebookReplyProbeVerifiedAt && !Number.isFinite(Date.parse(facebookReplyProbeVerifiedAt))) throw new Error("FACEBOOK_COMMENT_REPLY_CONTRACT_PROBE_VERIFIED_AT must be an ISO date-time.");
  const instagramCollaboratorProbe=["INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION","INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT","INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT"].map((key)=>String(input[key]??"").trim());
  if(instagramCollaboratorProbe.some(Boolean)&&!instagramCollaboratorProbe.every(Boolean))throw new Error("Instagram collaborator contract probe version, verification time, and expiry must be configured together.");
  if(instagramCollaboratorProbe[0]&&instagramCollaboratorProbe[0]!==String(input.META_GRAPH_API_VERSION??"").trim())throw new Error("Instagram collaborator contract probe must match META_GRAPH_API_VERSION exactly.");
  if(instagramCollaboratorProbe[1]&&(!Number.isFinite(Date.parse(instagramCollaboratorProbe[1]))||!Number.isFinite(Date.parse(instagramCollaboratorProbe[2]!))||Date.parse(instagramCollaboratorProbe[2]!)<=Date.parse(instagramCollaboratorProbe[1])||Date.parse(instagramCollaboratorProbe[2]!)-Date.parse(instagramCollaboratorProbe[1])>30*24*60*60*1000))throw new Error("Instagram collaborator contract probe timestamps must be valid and expire within 30 days.");
  const deleteProbe=["FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_API_VERSION","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_VERIFIED_AT","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXPIRES_AT","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_ID","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_EXTERNAL_PAGE_ID","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_CREDENTIAL_VERSION","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_ACCOUNT_VERSION","FACEBOOK_PAGE_DELETE_CONTRACT_PROBE_PAGE_TASKS_SHA256"].map((key)=>String(input[key]??"").trim());
  if(deleteProbe.some(Boolean)&&(!deleteProbe.every(Boolean)||!metaId))throw new Error("Facebook Page delete probe requires version, verified/expires timestamps, local account ID, external Page ID, credential/account versions, Page tasks hash, and META_APP_ID together.");
  if(deleteProbe[0]&&deleteProbe[0]!==String(input.META_GRAPH_API_VERSION??"").trim())throw new Error("Facebook Page delete probe must match META_GRAPH_API_VERSION exactly.");
  if(deleteProbe[1]&&(!Number.isFinite(Date.parse(deleteProbe[1]))||!Number.isFinite(Date.parse(deleteProbe[2]!))||Date.parse(deleteProbe[2]!)<=Date.parse(deleteProbe[1])||Date.parse(deleteProbe[2]!)-Date.parse(deleteProbe[1])>30*24*60*60*1000))throw new Error("Facebook Page delete probe timestamps must be valid and expire within 30 days.");
  if(deleteProbe[7]&&!/^[a-f0-9]{64}$/.test(deleteProbe[7]))throw new Error("Facebook Page delete probe Page tasks hash must be lowercase SHA-256.");
  if (String(input.OAUTH_TEST_MODE ?? "false") === "true" && environment !== "test") throw new Error("OAUTH_TEST_MODE is available only when NODE_ENV=test.");
  adminNetworkAllowed(String(input.ADMIN_ALLOWED_IPS ?? ''), '127.0.0.1');
  const cookieSecure = input.AUTH_COOKIE_SECURE === undefined ? environment === "production" : String(input.AUTH_COOKIE_SECURE) === "true";
  const sessionDays = Number(input.AUTH_SESSION_DAYS ?? 14);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 90) throw new Error("AUTH_SESSION_DAYS must be between 1 and 90.");
  const mediaUploadLeaseMinutes = boundedInteger(input, "MEDIA_UPLOAD_LEASE_MINUTES", 60, 15, 1440);
  const mediaTrashRetentionDays = boundedInteger(input, "MEDIA_TRASH_RETENTION_DAYS", 7, 1, 90);
  const mediaCleanupIntervalMinutes = boundedInteger(input, "MEDIA_CLEANUP_INTERVAL_MINUTES", 15, 1, 1440);
  const mediaCleanupEnabled = String(input.MEDIA_CLEANUP_ENABLED ?? "true") === "true";
  const mediaMalwareScanTimeoutMs = boundedInteger(input, "MEDIA_MALWARE_SCAN_TIMEOUT_MS", 120_000, 1_000, 300_000);
  const mediaMalwareScanMaxBytes = boundedInteger(input, "MEDIA_MALWARE_SCAN_MAX_BYTES", 512 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024);
  const mediaClamAvPort = boundedInteger(input, "MEDIA_CLAMAV_PORT", 3310, 1, 65_535);
  const mediaClamAvSignatureMaxAgeHours = boundedInteger(input, "MEDIA_CLAMAV_SIGNATURE_MAX_AGE_HOURS", 48, 1, 720);
  const mediaClamAvHost = String(input.MEDIA_CLAMAV_HOST ?? "clamav").trim();
  if (mediaMalwareScanMode === "clamav" && (!mediaClamAvHost || mediaClamAvHost.length > 253 || /[^a-zA-Z0-9.-]/u.test(mediaClamAvHost))) throw new Error("MEDIA_CLAMAV_HOST must be a plain DNS name or IPv4 address.");
  if (!["true", "false"].includes(String(input.MEDIA_CLEANUP_ENABLED ?? "true"))) throw new Error("MEDIA_CLEANUP_ENABLED must be true or false.");
  const automationDeliveryIntervalSeconds = boundedInteger(input, "AUTOMATION_DELIVERY_INTERVAL_SECONDS", 5, 2, 300);
  const operationsHealthIntervalMinutes = boundedInteger(input, "OPERATIONS_HEALTH_INTERVAL_MINUTES", 5, 1, 1440);
  const operationsPublishStaleMinutes = boundedInteger(input, "OPERATIONS_PUBLISH_STALE_MINUTES", 30, 5, 1440);
  const operationsOutboxStaleMinutes = boundedInteger(input, "OPERATIONS_OUTBOX_STALE_MINUTES", 15, 5, 1440);
  const operationsHealthEnabled = String(input.OPERATIONS_HEALTH_ENABLED ?? "true") === "true";
  const automationDeliveryEnabled = String(input.AUTOMATION_DELIVERY_ENABLED ?? "true") === "true";
  const automationAllowPrivateWebhooks = String(input.AUTOMATION_ALLOW_PRIVATE_WEBHOOKS ?? "false") === "true";
  const agentAllowPrivateEndpoints = String(input.AGENT_ALLOW_PRIVATE_ENDPOINTS ?? "false") === "true";
  const hermesBoardPluginEnabled = String(input.HERMES_BOARD_PLUGIN_ENABLED ?? "false") === "true";
  const hermesBoardAllowPrivateEndpoints = String(input.HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS ?? "false") === "true";
  if (!["true", "false"].includes(String(input.AUTOMATION_DELIVERY_ENABLED ?? "true")) || !["true", "false"].includes(String(input.AUTOMATION_ALLOW_PRIVATE_WEBHOOKS ?? "false"))) throw new Error("Automation boolean settings must be true or false.");
  if (!["true", "false"].includes(String(input.OPERATIONS_HEALTH_ENABLED ?? "true"))) throw new Error("OPERATIONS_HEALTH_ENABLED must be true or false.");
  if (!["true", "false"].includes(String(input.AGENT_ALLOW_PRIVATE_ENDPOINTS ?? "false"))) throw new Error("AGENT_ALLOW_PRIVATE_ENDPOINTS must be true or false.");
  if (!["true", "false"].includes(String(input.HERMES_BOARD_PLUGIN_ENABLED ?? "false")) || !["true", "false"].includes(String(input.HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS ?? "false"))) throw new Error("Hermes Boards boolean settings must be true or false.");
  if (hermesBoardPluginEnabled) {
    if (authMode !== "sessions") throw new Error("The Hermes Boards plugin requires AUTH_MODE=sessions.");
    if (!input.DATABASE_URL || !input.REDIS_URL) throw new Error("The Hermes Boards plugin requires DATABASE_URL and REDIS_URL for durable reconciliation.");
    if (Buffer.byteLength(String(input.HERMES_BOARD_SECRET ?? ""), "utf8") < 32) throw new Error("HERMES_BOARD_SECRET must contain at least 32 bytes.");
    if (String(input.HERMES_DASHBOARD_SESSION_TOKEN ?? "").length < 32) throw new Error("HERMES_DASHBOARD_SESSION_TOKEN must contain at least 32 characters.");
    if (String(input.HERMES_BOARD_SUPPORTED_VERSION ?? "0.21.2") !== "0.21.2") throw new Error("This OriginPost build supports Hermes 0.21.2 only.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u.test(String(input.HERMES_BOARD_PRIMARY_PROVIDER ?? "")) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(String(input.HERMES_BOARD_PRIMARY_MODEL ?? ""))) throw new Error("The Hermes Boards plugin requires an explicit primary provider and model.");
    if (input.HERMES_BOARD_PRIMARY_PROVIDER !== "openai-codex") throw new Error("The Hermes Boards plugin requires HERMES_BOARD_PRIMARY_PROVIDER=openai-codex.");
    for (const key of ["HERMES_DASHBOARD_URL", "HERMES_API_URL"] as const) {
      let url: URL;
      try { url = new URL(String(input[key] ?? "")); } catch { throw new Error(`${key} must be an absolute URL.`); }
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`${key} must be an origin-only HTTP(S) URL.`);
      if (url.protocol !== "https:" && !loopback && !hermesBoardAllowPrivateEndpoints) throw new Error(`${key} must use HTTPS unless a trusted private Hermes network is explicitly enabled.`);
    }
    const approvedSkills = String(input.HERMES_BOARD_APPROVED_SKILLS ?? "").split(",").map((value)=>value.trim()).filter(Boolean);
    if (approvedSkills.length > 100 || approvedSkills.some((name)=>!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(name))) throw new Error("HERMES_BOARD_APPROVED_SKILLS contains an invalid skill name.");
  }
  return {
    ...input, NODE_ENV: environment, AUTH_MODE: authMode, AUTH_COOKIE_SECURE: cookieSecure, AUTH_SESSION_DAYS: sessionDays, OIDC_ENABLED: oidcEnabled, OIDC_AUTO_PROVISION: oidcAutoProvision,
    MEDIA_UPLOAD_LEASE_MINUTES: mediaUploadLeaseMinutes, MEDIA_TRASH_RETENTION_DAYS: mediaTrashRetentionDays,
    MEDIA_CLEANUP_INTERVAL_MINUTES: mediaCleanupIntervalMinutes, MEDIA_CLEANUP_ENABLED: mediaCleanupEnabled,
    MEDIA_MALWARE_SCAN_MODE: mediaMalwareScanMode, MEDIA_MALWARE_SCAN_TIMEOUT_MS: mediaMalwareScanTimeoutMs,
    MEDIA_MALWARE_SCAN_MAX_BYTES: mediaMalwareScanMaxBytes, MEDIA_CLAMAV_HOST: mediaClamAvHost, MEDIA_CLAMAV_PORT: mediaClamAvPort, MEDIA_CLAMAV_SIGNATURE_MAX_AGE_HOURS: mediaClamAvSignatureMaxAgeHours,
    AUTOMATION_DELIVERY_INTERVAL_SECONDS: automationDeliveryIntervalSeconds, AUTOMATION_DELIVERY_ENABLED: automationDeliveryEnabled, AUTOMATION_ALLOW_PRIVATE_WEBHOOKS: automationAllowPrivateWebhooks,
    OPERATIONS_HEALTH_ENABLED: operationsHealthEnabled, OPERATIONS_HEALTH_INTERVAL_MINUTES: operationsHealthIntervalMinutes, OPERATIONS_PUBLISH_STALE_MINUTES: operationsPublishStaleMinutes, OPERATIONS_OUTBOX_STALE_MINUTES: operationsOutboxStaleMinutes,
    AGENT_ALLOW_PRIVATE_ENDPOINTS: agentAllowPrivateEndpoints,
    IMAGE_GENERATION_MODE: imageGenerationMode, OPENAI_IMAGE_MODEL: imageModel, OPENAI_IMAGE_TIMEOUT_MS: imageTimeoutMs,
    HERMES_BOARD_PLUGIN_ENABLED: hermesBoardPluginEnabled,
    HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS: hermesBoardAllowPrivateEndpoints,
    FACEBOOK_ANALYTICS_CONNECTOR_MODE: facebookAnalyticsMode,
    META_PROVIDER_CALLBACKS_ENABLED: providerCallbacksEnabled,
    API_PORT: Number(input.API_PORT ?? 4000), CORS_ORIGIN: String(input.CORS_ORIGIN ?? "http://localhost:3000"),
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateConfig }),
    InfrastructureModule,
    AuthModule,
    ContentModule,
    MonitoringModule,
    MediaModule,
    AudioModule,
    SystemModule,
    ChannelsModule,
    NotificationsModule,
    OrganizationsModule,
    AnalyticsModule,
    EngagementModule,
    AutomationModule,
    RemoteCorrectionModule,
    PrivateConversationsModule,
    BatchOperationsModule,
    ShareCaptureModule,
    SourceSignalsModule,
    EvergreenModule,
    AgentRuntimeModule,
    CreativeStudioModule,
    ImageGenerationModule,
    AgentPostsModule,
    FirstCommentModule,
    PostingQueueModule,
    BoardsModule,
    ProviderLifecycleModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthContextGuard }],
})
export class AppModule {}
