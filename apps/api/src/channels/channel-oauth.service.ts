import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { can, type Actor, type AuditEvent, type ConnectedAccount, type InstagramAccountType, type ProviderGrant } from "@originpost/domain";
import { metaPrivateGrantSetSha256, type MetaPrivateMessagingGrant } from "@originpost/connectors";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { resolveActiveBrand } from "../common/brand-context.js";
import { CredentialVaultService } from "./credential-vault.service.js";
import { instagramCollaboratorProbe, instagramFacebookAppVersion, instagramFacebookEndpointFamily, instagramFacebookProviderAccountVersion, instagramFacebookScopes } from "./instagram-facebook-credential.js";
import { MetaMessagingOAuthProvider, metaMessagingScopes, type MetaMessagingCandidate } from "./meta-messaging-oauth.js";
import { parseProviderLookupKeyring, providerLookupHmac } from "../provider-lifecycle/provider-lookup-keyring.js";

type InstagramIdentity = { accessToken: string; externalAccountId: string; displayName: string; expiresAt: string; accountType: InstagramAccountType };
type InstagramCredentialPayload = { accessToken: string; tokenType: string; provider: "instagram"; externalAccountId: string; connectionMode?:"instagram_login"|"facebook_login"; accountType?:InstagramAccountType; scope?:string; publisherUsername?:string; issuedAt?: string; expiresAt?: string };
type YouTubeIdentity = { accessToken: string; refreshToken: string; externalAccountId: string; displayName: string; expiresAt: string; scope: string };
type YouTubeCredentialPayload = { accessToken: string; refreshToken: string; tokenType: string; provider: "youtube"; externalAccountId: string; scope: string; issuedAt?: string; expiresAt?: string };
type FacebookPageCandidate = { externalAccountId: string; displayName: string; accessToken: string; tasks: string[] };
type FacebookSelectionPayload = { provider: "facebook-selection"; workspaceId: string; brandId: string; actorId: string; expiresAt: string; providerSubject: string; grantExpiresAt?: string; pages: FacebookPageCandidate[] };
type FacebookCredentialPayload = { accessToken: string; tokenType: "bearer"; provider: "facebook"; externalAccountId: string; scope?:string; issuedAt: string; pageTasks:string[]; privateMessagingGrant?:MetaPrivateMessagingGrant };
type InstagramFacebookCandidate = { externalAccountId:string; username:string; displayName:string; pageId:string; pageName:string; accessToken:string; pageTasks:string[]; grantedScopes:string[]; endpointFamily:typeof instagramFacebookEndpointFamily; providerVersion:string; appVersion:string; providerAccountVersion:string };
type InstagramFacebookSelectionPayload = { provider:"instagram-facebook-selection"; workspaceId:string; brandId:string; actorId:string; expiresAt:string; providerSubject:string; grantExpiresAt?:string; accounts:InstagramFacebookCandidate[] };
type InstagramFacebookCredentialPayload = { accessToken:string; tokenType:"bearer"; provider:"instagram"; externalAccountId:string; connectionMode:"facebook_login"; accountType:"BUSINESS"; canonicalUsername:string; scope:string; grantedScopes:string[]; endpointFamily:typeof instagramFacebookEndpointFamily; providerVersion:string; appVersion:string; providerAccountVersion:string; accountVersion:string; pageId:string; pageTasks:string[]; issuedAt:string; privateMessagingGrant?:MetaPrivateMessagingGrant };
type MetaMessagingSelectionCandidate = MetaMessagingCandidate & { accountId:string };
type MetaMessagingSelectionPayload = { provider:"meta-messaging-selection"; workspaceId:string; brandId:string; actorId:string; expiresAt:string; providerSubject:string; candidates:MetaMessagingSelectionCandidate[] };

const instagramFacebookStatePrefix="igfb_";
const metaMessagingStatePrefix="metamsg_";
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function credentialId(ref?: string): string | undefined { return ref?.startsWith("secret:") ? ref.slice(7) : undefined; }

@Injectable()
export class ChannelOAuthService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly config: ConfigService,
    private readonly vault: CredentialVaultService,
  ) {}

  private callbackUrl(): string { return `${(this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "")}/v1/channels/oauth/instagram/callback`; }
  private facebookCallbackUrl(): string { return `${(this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "")}/v1/channels/oauth/facebook/callback`; }
  private instagramFacebookCallbackUrl(): string { return `${(this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "")}/v1/channels/oauth/instagram-facebook/callback`; }
  private metaMessagingCallbackUrl(): string { return `${(this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "")}/v1/channels/oauth/meta-messaging/callback`; }
  private youtubeCallbackUrl(): string { return `${(this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "")}/v1/channels/oauth/youtube/callback`; }
  private returnUrl(): string { return `${(this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, "")}/`; }
  private testMode(): boolean { return this.config.get<string>("NODE_ENV") === "test" && this.config.get<string>("OAUTH_TEST_MODE") === "true"; }
  private facebookAnalyticsRequested(): boolean { return this.config.get<string>("FACEBOOK_ANALYTICS_CONNECTOR_MODE") === "official"; }
  private facebookScopes(): string[] { return ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "pages_manage_engagement", ...(this.facebookAnalyticsRequested() ? ["read_insights"] : [])]; }
  configured(): boolean { return !this.config.get<string>("INSTALLATION_SETTINGS_PATH") && this.facebookConfigured(); }
  facebookConfigured(): boolean { return this.vault.configured() && (this.testMode() || Boolean(this.config.get<string>("META_APP_ID") && this.config.get<string>("META_APP_SECRET"))); }
  instagramFacebookConfigured(): boolean { return this.testMode() || Boolean(this.vault.configured()&&this.config.get<string>("META_APP_ID")&&this.config.get<string>("META_APP_SECRET")&&this.config.get<string>("META_GRAPH_API_VERSION")); }
  metaMessagingConfigured(): boolean { return this.config.get<string>("PRIVATE_MESSAGE_CONNECTOR_MODE") === "official" && Boolean(this.vault.configured() && this.config.get<string>("META_APP_ID") && this.config.get<string>("META_APP_SECRET") && this.config.get<string>("META_GRAPH_API_VERSION") && this.metaMessagingAppReviewReference()); }
  youtubeConfigured(): boolean { return this.vault.configured() && (this.testMode() || Boolean(this.config.get<string>("GOOGLE_CLIENT_ID") && this.config.get<string>("GOOGLE_CLIENT_SECRET"))); }

  private providerKeyring() {
    if (this.testMode() && !this.config.get<string>("PROVIDER_LOOKUP_HMAC_KEYS")) return parseProviderLookupKeyring(`test-v1:${Buffer.alloc(32, 0x6d).toString("base64")}`, "test-v1");
    return parseProviderLookupKeyring(this.config.get<string>("PROVIDER_LOOKUP_HMAC_KEYS") ?? "", this.config.get<string>("PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION") ?? "");
  }

  private grantId(workspaceId: string, provider: "meta" | "google", clientId: string, authorizationKind: ProviderGrant["authorizationKind"], lookupDigest: string): string {
    return `provider_grant_${createHash("sha256").update(`${workspaceId}\0${provider}\0${clientId}\0${authorizationKind}\0${lookupDigest}`).digest("hex").slice(0, 32)}`;
  }

  private metaGrant(input: { workspaceId: string; actorId: string; authorizationKind: "instagram_login" | "facebook_login"; providerSubject: string; scopes: string[]; issuedAt: string; accessExpiresAt?: string }): ProviderGrant {
    const clientId = this.testMode() ? (input.authorizationKind === "instagram_login" ? "test-client" : "test-facebook-client") : this.config.get<string>("META_APP_ID")!;
    const lookup = providerLookupHmac(this.providerKeyring(), "meta", clientId, input.providerSubject);
    const nextValidationAt = new Date(Date.parse(input.issuedAt) + 7 * 24 * 60 * 60_000).toISOString();
    const nextRefreshAt = input.authorizationKind === "instagram_login" && input.accessExpiresAt ? new Date(Math.max(Date.parse(input.issuedAt) + 24 * 60 * 60_000, Date.parse(input.accessExpiresAt) - 7 * 24 * 60 * 60_000)).toISOString() : undefined;
    return { id: this.grantId(input.workspaceId, "meta", clientId, input.authorizationKind, lookup.digest), workspaceId: input.workspaceId, provider: "meta", authorizationKind: input.authorizationKind, clientId, lookupKeyVersion: lookup.version, subjectLookupHmac: lookup.digest, status: "active", scopes: [...new Set(input.scopes)].sort(), version: 1, issuedAt: input.issuedAt, ...(input.accessExpiresAt ? { accessExpiresAt: input.accessExpiresAt } : {}), ...(nextRefreshAt ? { nextRefreshAt } : {}), nextValidationAt, lastCheckedAt: input.issuedAt, lastHealthyAt: input.issuedAt, createdBy: input.actorId, createdAt: input.issuedAt, updatedAt: input.issuedAt };
  }

  private googleGrant(input: { workspaceId: string; actorId: string; refreshToken: string; scopes: string[]; issuedAt: string; accessExpiresAt: string }): ProviderGrant {
    const clientId = this.testMode() ? "test-youtube-client" : this.config.get<string>("GOOGLE_CLIENT_ID")!;
    const lookup = providerLookupHmac(this.providerKeyring(), "google", clientId, input.refreshToken);
    return { id: this.grantId(input.workspaceId, "google", clientId, "google_oauth", lookup.digest), workspaceId: input.workspaceId, provider: "google", authorizationKind: "google_oauth", clientId, lookupKeyVersion: lookup.version, refreshTokenLookupHmac: lookup.digest, status: "active", scopes: [...new Set(input.scopes)].sort(), version: 1, issuedAt: input.issuedAt, accessExpiresAt: input.accessExpiresAt, nextRefreshAt: new Date(Math.max(Date.parse(input.issuedAt), Date.parse(input.accessExpiresAt) - 15 * 60_000)).toISOString(), nextValidationAt: new Date(Date.parse(input.issuedAt) + 30 * 24 * 60 * 60_000).toISOString(), lastCheckedAt: input.issuedAt, lastHealthyAt: input.issuedAt, createdBy: input.actorId, createdAt: input.issuedAt, updatedAt: input.issuedAt };
  }

  async startFacebook(workspaceId: string, requestedBrandId: string | undefined, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can connect Facebook Pages.");
    if (!this.facebookConfigured()) throw new ConflictException("Facebook OAuth is not configured. Add the Meta app settings and credential encryption key.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    const rawState = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60_000).toISOString();
    await this.infrastructure.oauthRepository.createState({ id: `oauth_${randomUUID()}`, workspaceId, brandId, platform: "facebook", actorId: actor.id, stateHash: hash(rawState), returnUrl: this.returnUrl(), createdAt: createdAt.toISOString(), expiresAt });
    const authorization = new URL(this.testMode() ? "https://oauth.test.invalid/facebook-authorize" : `https://www.facebook.com/${this.metaApiVersion()}/dialog/oauth`);
    authorization.searchParams.set("client_id", this.testMode() ? "test-facebook-client" : this.config.get<string>("META_APP_ID")!);
    authorization.searchParams.set("redirect_uri", this.facebookCallbackUrl());
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", this.facebookScopes().join(","));
    authorization.searchParams.set("state", rawState);
    return { authorizationUrl: authorization.toString(), expiresAt, callbackUrl: this.facebookCallbackUrl() };
  }

  async startInstagramFacebook(workspaceId:string,requestedBrandId:string|undefined,actor:Actor){
    if(!can(actor.role,"workspace:manage"))throw new ForbiddenException("Only workspace owners can connect Instagram professional accounts.");
    if(!this.instagramFacebookConfigured())throw new ConflictException("Instagram Facebook Login is not configured. Add the pinned Meta Graph version, app settings, and credential encryption key.");
    const brandId=await resolveActiveBrand(this.infrastructure.organizationRepository,workspaceId,requestedBrandId);
    const rawState=`${instagramFacebookStatePrefix}${randomBytes(32).toString("base64url")}`; const createdAt=new Date(); const expiresAt=new Date(createdAt.getTime()+10*60_000).toISOString();
    await this.infrastructure.oauthRepository.createState({id:`oauth_${randomUUID()}`,workspaceId,brandId,platform:"facebook",actorId:actor.id,stateHash:hash(rawState),returnUrl:this.returnUrl(),createdAt:createdAt.toISOString(),expiresAt});
    const authorization=new URL(this.testMode()?"https://oauth.test.invalid/instagram-facebook-authorize":`https://www.facebook.com/${this.metaApiVersion()}/dialog/oauth`);
    authorization.searchParams.set("client_id",this.testMode()?"test-facebook-client":this.config.get<string>("META_APP_ID")!);
    authorization.searchParams.set("redirect_uri",this.instagramFacebookCallbackUrl()); authorization.searchParams.set("response_type","code"); authorization.searchParams.set("scope",[...instagramFacebookScopes].sort().join(",")); authorization.searchParams.set("state",rawState);
    return{authorizationUrl:authorization.toString(),expiresAt,callbackUrl:this.instagramFacebookCallbackUrl(),connectionMode:"facebook_login" as const};
  }

  async startMetaMessaging(workspaceId:string,requestedBrandId:string|undefined,actor:Actor){
    if(!can(actor.role,"workspace:manage"))throw new ForbiddenException("Only workspace owners can enable private messaging.");
    if(!this.metaMessagingConfigured())throw new ConflictException("Official Meta private messaging is not configured or its App Review evidence is missing.");
    const brandId=await resolveActiveBrand(this.infrastructure.organizationRepository,workspaceId,requestedBrandId);
    const rawState=`${metaMessagingStatePrefix}${randomBytes(32).toString("base64url")}`;const createdAt=new Date();const expiresAt=new Date(createdAt.getTime()+10*60_000).toISOString();
    await this.infrastructure.oauthRepository.createState({id:`oauth_${randomUUID()}`,workspaceId,brandId,platform:"facebook",actorId:actor.id,stateHash:hash(rawState),returnUrl:this.returnUrl(),createdAt:createdAt.toISOString(),expiresAt});
    return{authorizationUrl:this.metaMessagingProvider().authorizationUrl(rawState),expiresAt,callbackUrl:this.metaMessagingCallbackUrl(),requestedScopes:[...metaMessagingScopes],connectionModes:["facebook_page_messenger","instagram_linked_page"] as const};
  }

  async callbackMetaMessaging(input:{state:string;code?:string;error?:string;errorDescription?:string}){
    if(!input.state.startsWith(metaMessagingStatePrefix))throw new BadRequestException("This Meta messaging connection request is invalid.");
    const consumedAt=new Date().toISOString();const state=await this.infrastructure.oauthRepository.consumeState(hash(input.state),"facebook",consumedAt);
    if(!state)throw new BadRequestException("This Meta messaging connection request is invalid, expired, or already used.");
    if(input.error)return{redirectUrl:this.redirect(state.returnUrl,{channel:"error",reason:"provider_denied"}),connected:false as const};
    if(!input.code)throw new BadRequestException("Facebook did not return an authorization code.");
    if(this.config.get<string>("AUTH_MODE")==="sessions"){const membership=await this.infrastructure.authRepository.getMembership(state.workspaceId,state.actorId);if(!membership||!can(membership.role,"workspace:manage"))throw new ForbiddenException("The person who started this connection no longer manages the workspace.");}
    const discovered=await this.metaMessagingProvider().exchangeAndDiscover(input.code);const accounts=await this.infrastructure.connectedAccountRepository.list(state.workspaceId,state.brandId);const candidates:MetaMessagingSelectionCandidate[]=[];
    for(const candidate of discovered.candidates){const platform=candidate.connectionMode==="facebook_page_messenger"?"facebook":"instagram";const account=accounts.find((entry)=>entry.platform===platform&&entry.externalAccountId===candidate.externalBusinessAccountId&&entry.status!=="disconnected");if(!account)continue;
      if(candidate.connectionMode==="instagram_linked_page"){const id=credentialId(account.credentialRef);if(!id)continue;let current:Record<string,unknown>;try{current=JSON.parse(await this.vault.open(state.workspaceId,id)) as Record<string,unknown>;}catch{continue;}if(current.provider!=="instagram"||current.connectionMode!=="facebook_login"||current.pageId!==candidate.endpointPageId)continue;}
      candidates.push({...candidate,accountId:account.id});
    }
    if(!candidates.length)return{redirectUrl:this.redirect(state.returnUrl,{channel:"error",reason:"no_existing_messaging_accounts"}),connected:false as const};
    const expiresAt=new Date(Date.now()+10*60_000).toISOString();const selection=this.vault.seal(state.workspaceId,"provider-discovery",JSON.stringify({provider:"meta-messaging-selection",workspaceId:state.workspaceId,brandId:state.brandId,actorId:state.actorId,expiresAt,providerSubject:discovered.providerSubject,candidates} satisfies MetaMessagingSelectionPayload),consumedAt);
    await this.infrastructure.oauthRepository.saveCredential(selection);
    return{redirectUrl:this.redirect(state.returnUrl,{channel:"select_meta_messaging",selectionId:selection.id}),connected:false as const,selectionId:selection.id};
  }

  async getMetaMessagingSelection(workspaceId:string,selectionId:string,actor:Actor){
    if(!can(actor.role,"workspace:manage"))throw new ForbiddenException("Only workspace owners can select private-message accounts.");
    const selection=await this.openMetaMessagingSelection(workspaceId,selectionId,actor);
    return{selectionId,expiresAt:selection.expiresAt,candidates:selection.candidates.map(({targetKey,connectionMode,externalBusinessAccountId,displayName,pageName,username,accountId})=>({targetKey,connectionMode,externalBusinessAccountId,displayName,pageName,...(username?{username}:{}),accountId}))};
  }

  async completeMetaMessagingSelection(workspaceId:string,selectionId:string,targetKeys:string[],actor:Actor){
    if(!can(actor.role,"workspace:manage"))throw new ForbiddenException("Only workspace owners can enable private messaging.");
    if(!this.metaMessagingConfigured())throw new ConflictException("Official Meta private messaging is not configured.");
    if(!this.infrastructure.privateConversationRepository||!this.infrastructure.privateConversationQueue)throw new ConflictException("Durable private-message storage and Redis are required before re-consent.");
    const selection=await this.openMetaMessagingSelection(workspaceId,selectionId,actor);const uniqueKeys=[...new Set(targetKeys.map((value)=>value.normalize("NFC").trim()).filter(Boolean))];
    if(!uniqueKeys.length||uniqueKeys.length>100)throw new BadRequestException("Select between 1 and 100 private-message accounts.");
    const candidates=uniqueKeys.map((key)=>selection.candidates.find((candidate)=>candidate.targetKey===key));if(candidates.some((candidate)=>!candidate))throw new BadRequestException("One or more selected private-message accounts are not part of this connection request.");
    const provider=this.metaMessagingProvider();const appId=this.config.get<string>("META_APP_ID")!;const apiVersion=this.metaApiVersion();const environment=(this.config.get<string>("NODE_ENV")??"development") as "production"|"development"|"test";const appReviewReferenceSha256=this.metaMessagingAppReviewReference();if(!appReviewReferenceSha256)throw new ConflictException("Meta private-messaging App Review evidence is missing.");
    const prepared:Array<{candidate:MetaMessagingSelectionCandidate;account:ConnectedAccount;oldCredentialId:string;accountNext:ConnectedAccount;secret:ReturnType<CredentialVaultService["seal"]>;audit:AuditEvent}>=[];
    for(const candidate of candidates as MetaMessagingSelectionCandidate[]){const account=await this.infrastructure.connectedAccountRepository.get(workspaceId,candidate.accountId);if(!account||account.brandId!==selection.brandId||account.externalAccountId!==candidate.externalBusinessAccountId||account.status==="disconnected")throw new ConflictException("A selected private-message account changed. Start re-consent again.");
      const oldCredentialId=credentialId(account.credentialRef);if(!oldCredentialId)throw new ConflictException("A selected account is not managed by OriginPost OAuth. Reconnect it first.");const currentRaw=await this.vault.open(workspaceId,oldCredentialId);let current:Record<string,unknown>;try{current=JSON.parse(currentRaw) as Record<string,unknown>;}catch{throw new ConflictException("A selected account credential is invalid. Reconnect it first.");}
      if(candidate.connectionMode==="facebook_page_messenger"&&(account.platform!=="facebook"||current.provider!=="facebook"))throw new ConflictException("The Facebook Page messaging selection does not match its account.");
      if(candidate.connectionMode==="instagram_linked_page"&&(account.platform!=="instagram"||current.provider!=="instagram"||current.connectionMode!=="facebook_login"||current.pageId!==candidate.endpointPageId))throw new ConflictException("The linked Instagram messaging selection does not match its Page.");
      const sync=await this.infrastructure.privateConversationRepository?.getSyncState({workspaceId,brandId:selection.brandId},account.id);if(sync&&(sync.platform!==account.platform||sync.connectionMode!==candidate.connectionMode))throw new ConflictException("This account already has a different private-message connection mode.");
      const probe=await provider.probe(candidate);const now=new Date().toISOString();const grant:MetaPrivateMessagingGrant={task:"meta_private_messaging",connectionMode:candidate.connectionMode,apiVersion,environment,appId,accountId:account.id,externalBusinessAccountId:candidate.externalBusinessAccountId,endpointPageId:candidate.endpointPageId,credentialVersion:now,accountVersion:now,scopesSha256:metaPrivateGrantSetSha256(candidate.grantedScopes),pageTasksSha256:metaPrivateGrantSetSha256(candidate.pageTasks),appReviewReferenceSha256,verifiedAt:probe.verifiedAt,expiresAt:probe.expiresAt};
      const payload=candidate.connectionMode==="facebook_page_messenger"?{...current,accessToken:candidate.accessToken,tokenType:"bearer",provider:"facebook",externalAccountId:candidate.externalBusinessAccountId,scope:candidate.grantedScopes.join(" "),issuedAt:now,pageTasks:candidate.pageTasks,privateMessagingGrant:grant}:{...current,accessToken:candidate.accessToken,tokenType:"bearer",provider:"instagram",externalAccountId:candidate.externalBusinessAccountId,connectionMode:"facebook_login",scope:candidate.grantedScopes.join(" "),grantedScopes:candidate.grantedScopes,pageId:candidate.endpointPageId,pageTasks:candidate.pageTasks,issuedAt:now,accountVersion:now,privateMessagingGrant:grant};
      const secret=this.vault.seal(workspaceId,"provider-token",JSON.stringify(payload),now);const accountNext:ConnectedAccount={...account,credentialRef:`secret:${secret.id}`,capabilities:[...new Set([...account.capabilities,"private_message_read" as const,"private_message_send" as const])],status:"healthy",lastCheckedAt:now,lastHealthyAt:now,lastErrorCode:undefined,lastErrorStep:undefined,lastErrorSummary:undefined,updatedAt:now};
      const audit:AuditEvent={id:`audit_${randomUUID()}`,workspaceId,actorId:actor.id,actorType:"human",action:"channel.meta-messaging-consented",detail:{connectedAccountId:account.id,platform:account.platform,connectionMode:candidate.connectionMode,externalAccountId:account.externalAccountId,webhookFields:probe.webhookFields,appReviewReferenceSha256},createdAt:now};prepared.push({candidate,account,oldCredentialId,accountNext,secret,audit});
    }
    const lifecycleGrant=this.metaGrant({workspaceId,actorId:actor.id,authorizationKind:"facebook_login",providerSubject:selection.providerSubject,scopes:[...metaMessagingScopes],issuedAt:new Date().toISOString()});
    const completed=await this.infrastructure.connectedAccountRepository.completeOAuthSelection(workspaceId,selectionId,prepared.map(({accountNext,audit,secret,oldCredentialId})=>({account:accountNext,event:audit,credentialChange:{save:secret,deleteId:oldCredentialId}})),{grant:lifecycleGrant});if(!completed)throw new ConflictException("This private-message account selection was already completed.");
    try{for(const entry of prepared){let sync=await this.infrastructure.privateConversationRepository?.getSyncState({workspaceId,brandId:selection.brandId},entry.accountNext.id);if(!sync){const at=new Date().toISOString();const initial={workspaceId,brandId:selection.brandId,accountId:entry.accountNext.id,platform:entry.accountNext.platform as "facebook"|"instagram",connectionMode:entry.candidate.connectionMode,nextSyncAt:at,failureCount:0,version:1};await this.infrastructure.privateConversationRepository?.saveSyncPage({workspaceId,brandId:selection.brandId},{syncState:initial,batches:[],fetchedAt:at},{id:`audit_${randomUUID()}`,workspaceId,actorId:actor.id,actorType:"human",action:"private-conversation.official-sync-initialized",detail:{accountId:entry.accountNext.id,connectionMode:entry.candidate.connectionMode},createdAt:at});sync=initial;}
        const connector=this.infrastructure.connectors.getPrivateConversations(entry.candidate.connectionMode);if(connector.privateConversationManifest.apiMode!=="official")throw new Error("official_messaging_connector_required");const capability=await connector.inspectCapability({workspaceId,brandId:selection.brandId,accountId:entry.accountNext.id,platform:entry.accountNext.platform as "facebook"|"instagram",connectionMode:entry.candidate.connectionMode});if(capability.state!=="available")throw new Error("stored_messaging_grant_unavailable");await connector.subscribe({workspaceId,brandId:selection.brandId,accountId:entry.accountNext.id,platform:entry.accountNext.platform as "facebook"|"instagram",connectionMode:entry.candidate.connectionMode,externalBusinessAccountId:entry.candidate.externalBusinessAccountId});await this.infrastructure.privateConversationQueue.add("sync-account",{name:"sync-account",workspaceId,brandId:selection.brandId,accountId:entry.accountNext.id},{jobId:`private-official-sync-${entry.accountNext.id}-v${sync.version}`,attempts:3,backoff:{type:"exponential",delay:30_000},removeOnComplete:500,removeOnFail:1_000});}}
    catch(error){for(const entry of prepared){const latest=await this.infrastructure.connectedAccountRepository.get(workspaceId,entry.accountNext.id).catch(()=>null);if(latest?.updatedAt===entry.accountNext.updatedAt){const at=new Date().toISOString();await this.infrastructure.connectedAccountRepository.save({...latest,capabilities:latest.capabilities.filter((capability)=>capability!=="private_message_read"&&capability!=="private_message_send"),status:"setup_required",lastErrorCode:"private_messaging_setup",lastErrorStep:"Reconnect private messaging",lastErrorSummary:"Meta messaging setup did not finish. Run private-message re-consent again.",updatedAt:at},{id:`audit_${randomUUID()}`,workspaceId,actorId:actor.id,actorType:"human",action:"channel.meta-messaging-setup-failed",detail:{connectedAccountId:latest.id,connectionMode:entry.candidate.connectionMode},createdAt:at}).catch(()=>undefined);}}throw new BadGatewayException("Meta messaging permissions were saved, but inbox setup did not finish. Run private-message re-consent again.");}
    return{connected:true as const,accounts:prepared.map(({accountNext,candidate})=>({accountId:accountNext.id,displayName:accountNext.displayName,platform:accountNext.platform,connectionMode:candidate.connectionMode,capabilities:accountNext.capabilities}))};
  }

  async startYouTube(workspaceId: string, requestedBrandId: string | undefined, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can connect YouTube.");
    if (!this.youtubeConfigured()) throw new ConflictException("YouTube OAuth is not configured. Add the Google client ID, client secret, and credential encryption key.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    const rawState = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60_000).toISOString();
    await this.infrastructure.oauthRepository.createState({ id: `oauth_${randomUUID()}`, workspaceId, brandId, platform: "youtube", actorId: actor.id, stateHash: hash(rawState), returnUrl: this.returnUrl(), createdAt: createdAt.toISOString(), expiresAt });
    const authorization = new URL(this.testMode() ? "https://oauth.test.invalid/youtube-authorize" : "https://accounts.google.com/o/oauth2/v2/auth");
    authorization.searchParams.set("client_id", this.testMode() ? "test-youtube-client" : this.config.get<string>("GOOGLE_CLIENT_ID")!);
    authorization.searchParams.set("redirect_uri", this.youtubeCallbackUrl());
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly");
    authorization.searchParams.set("access_type", "offline");
    authorization.searchParams.set("include_granted_scopes", "true");
    authorization.searchParams.set("prompt", "consent");
    authorization.searchParams.set("state", rawState);
    return { authorizationUrl: authorization.toString(), expiresAt, callbackUrl: this.youtubeCallbackUrl() };
  }

  async callbackYouTube(input: { state: string; code?: string; error?: string; errorDescription?: string }) {
    const state = await this.infrastructure.oauthRepository.consumeState(hash(input.state), "youtube", new Date().toISOString());
    if (!state) throw new BadRequestException("This YouTube connection request is invalid, expired, or already used.");
    if (input.error) return { redirectUrl: this.redirect(state.returnUrl, { channel: "error", reason: "provider_denied" }), connected: false as const };
    if (!input.code) throw new BadRequestException("YouTube did not return an authorization code.");
    if (this.config.get<string>("AUTH_MODE") === "sessions") {
      const membership = await this.infrastructure.authRepository.getMembership(state.workspaceId, state.actorId);
      if (!membership || !can(membership.role, "workspace:manage")) throw new ForbiddenException("The person who started this connection no longer manages the workspace.");
    }
    const identity = await this.exchangeYouTube(input.code);
    const existing = (await this.infrastructure.connectedAccountRepository.list(state.workspaceId)).find((account) => account.platform === "youtube" && account.externalAccountId === identity.externalAccountId);
    if (existing && existing.brandId !== state.brandId) throw new ConflictException("This YouTube channel is already assigned to another brand in this workspace.");
    const now = new Date().toISOString();
    const secret = this.vault.seal(state.workspaceId, "provider-token", JSON.stringify({ accessToken: identity.accessToken, refreshToken: identity.refreshToken, tokenType: "bearer", provider: "youtube", externalAccountId: identity.externalAccountId, scope: identity.scope, issuedAt: now, expiresAt: identity.expiresAt } satisfies YouTubeCredentialPayload), now);
    const account: ConnectedAccount = {
      id: existing?.id ?? `account_${randomUUID()}`, workspaceId: state.workspaceId, brandId: state.brandId, platform: "youtube", displayName: identity.displayName,
      externalAccountId: identity.externalAccountId, credentialRef: `secret:${secret.id}`, capabilities: ["channel_read", "video_upload"], status: "healthy",
      expiresAt: identity.expiresAt, lastCheckedAt: now, lastHealthyAt: now, createdBy: existing?.createdBy ?? state.actorId, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId: state.workspaceId, actorId: state.actorId, actorType: "human", action: existing ? "channel.oauth-reconnected" : "channel.oauth-connected", detail: { connectedAccountId: account.id, platform: "youtube", externalAccountId: account.externalAccountId, capabilities: account.capabilities, expiresAt: account.expiresAt }, createdAt: now };
    const oldCredentialId = credentialId(existing?.credentialRef);
    const grant = this.googleGrant({ workspaceId: state.workspaceId, actorId: state.actorId, refreshToken: identity.refreshToken, scopes: identity.scope.split(/\s+/).filter(Boolean), issuedAt: now, accessExpiresAt: identity.expiresAt });
    await this.infrastructure.connectedAccountRepository.save(account, audit, { save: secret, ...(oldCredentialId ? { deleteId: oldCredentialId } : {}) }, { grant });
    return { redirectUrl: this.redirect(state.returnUrl, { channel: "connected", accountId: account.id }), connected: true as const, accountId: account.id };
  }

  async refreshConnectedAccount(workspaceId: string, accountId: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can renew provider access.");
    const current = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId);
    if (!current) throw new BadRequestException("Connected account not found in this workspace.");
    if (current.platform === "youtube") return this.refreshYouTube(workspaceId, accountId, actor);
    if (current.platform === "facebook") return this.refreshFacebook(workspaceId, accountId, actor);
    return this.refreshInstagram(workspaceId, accountId, actor);
  }

  async refreshFacebook(workspaceId: string, accountId: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can check Facebook access.");
    if (!this.facebookConfigured()) throw new ConflictException("Facebook OAuth or credential encryption is not configured.");
    const current = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId);
    if (!current || current.platform !== "facebook") throw new BadRequestException("Facebook Page not found in this workspace.");
    const currentCredentialId = credentialId(current.credentialRef);
    if (!currentCredentialId) throw new ConflictException("This Page does not use the built-in OAuth credential store. Reconnect it with Facebook OAuth.");
    const payload = this.parseFacebookCredential(await this.vault.open(workspaceId, currentCredentialId), current.externalAccountId);
    try {
      const identity = await this.readFacebookPageIdentity(payload);
      const now = new Date().toISOString();
      const capabilities = identity.pageTasks.includes("ANALYZE") ? current.capabilities : current.capabilities.filter((capability) => capability !== "analytics_read");
      const updated: ConnectedAccount = {
        ...current,
        displayName: identity.displayName,
        capabilities,
        status: "healthy",
        lastCheckedAt: now,
        lastHealthyAt: now,
        lastErrorCode: undefined,
        lastErrorStep: undefined,
        lastErrorSummary: undefined,
        updatedAt: now,
      };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: "channel.oauth-refreshed", detail: { connectedAccountId: accountId, platform: "facebook", externalAccountId: current.externalAccountId, accessChecked: true, analyticsAccess: capabilities.includes("analytics_read"), pageTasks: identity.pageTasks.filter((task) => task === "CREATE_CONTENT" || task === "ANALYZE") }, createdAt: now };
      await this.infrastructure.connectedAccountRepository.save(updated, audit);
      const { credentialRef: _credentialRef, ...safe } = updated;
      return { ...safe, credentialConfigured: true, credentialManaged: true };
    } catch (cause) {
      if (cause instanceof ConflictException || cause instanceof BadRequestException || cause instanceof ForbiddenException) throw cause;
      const now = new Date().toISOString();
      const failed: ConnectedAccount = { ...current, status: "refresh_failed", lastCheckedAt: now, lastErrorCode: "token_check", lastErrorStep: "Check Facebook access", lastErrorSummary: "Facebook could not confirm this Page access. Reconnect the Page and try again.", updatedAt: now };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: "channel.oauth-refresh-failed", detail: { connectedAccountId: accountId, platform: "facebook", externalAccountId: current.externalAccountId, reason: "provider_rejected" }, createdAt: now };
      await this.infrastructure.connectedAccountRepository.save(failed, audit);
      throw new BadGatewayException("Facebook could not confirm this Page access. Reconnect the Page and try again.");
    }
  }

  async startInstagram(workspaceId: string, requestedBrandId: string | undefined, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can connect Instagram.");
    if (this.config.get<string>("INSTALLATION_SETTINGS_PATH")) throw new ConflictException("Connect Instagram through Facebook Login. Separate Instagram app credentials are not supported by guided installation yet.");
    if (!this.configured()) throw new ConflictException("Instagram OAuth is not configured. Add the Meta app settings and credential encryption key.");
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, requestedBrandId);
    const rawState = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60_000).toISOString();
    await this.infrastructure.oauthRepository.createState({ id: `oauth_${randomUUID()}`, workspaceId, brandId, platform: "instagram", actorId: actor.id, stateHash: hash(rawState), returnUrl: this.returnUrl(), createdAt: createdAt.toISOString(), expiresAt });
    const authorization = new URL(this.testMode() ? "https://oauth.test.invalid/authorize" : this.config.get<string>("META_INSTAGRAM_AUTHORIZATION_URL") ?? "https://www.instagram.com/oauth/authorize");
    authorization.searchParams.set("client_id", this.testMode() ? "test-client" : this.config.get<string>("META_APP_ID")!);
    authorization.searchParams.set("redirect_uri", this.callbackUrl());
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments");
    authorization.searchParams.set("state", rawState);
    return { authorizationUrl: authorization.toString(), expiresAt, callbackUrl: this.callbackUrl() };
  }

  async callbackInstagram(input: { state: string; code?: string; error?: string; errorDescription?: string }) {
    if (this.config.get<string>("INSTALLATION_SETTINGS_PATH")) throw new ConflictException("Connect Instagram through Facebook Login. Separate Instagram app credentials are not supported by guided installation yet.");
    const consumedAt = new Date().toISOString();
    const state = await this.infrastructure.oauthRepository.consumeState(hash(input.state), "instagram", consumedAt);
    if (!state) throw new BadRequestException("This Instagram connection request is invalid, expired, or already used.");
    if (input.error) return { redirectUrl: this.redirect(state.returnUrl, { channel: "error", reason: "provider_denied" }), connected: false as const };
    if (!input.code) throw new BadRequestException("Instagram did not return an authorization code.");
    if (this.config.get<string>("AUTH_MODE") === "sessions") {
      const membership = await this.infrastructure.authRepository.getMembership(state.workspaceId, state.actorId);
      if (!membership || !can(membership.role, "workspace:manage")) throw new ForbiddenException("The person who started this connection no longer manages the workspace.");
    }
    const identity = await this.exchangeInstagram(input.code);
    const existing = (await this.infrastructure.connectedAccountRepository.list(state.workspaceId)).find((account) => account.platform === "instagram" && account.externalAccountId === identity.externalAccountId);
    if (existing && existing.brandId !== state.brandId) throw new ConflictException("This Instagram account is already assigned to another brand in this workspace.");
    const now = new Date().toISOString();
    const secret = this.vault.seal(state.workspaceId, "provider-token", JSON.stringify({ accessToken: identity.accessToken, tokenType: "bearer", provider: "instagram", externalAccountId: identity.externalAccountId, connectionMode:"instagram_login",accountType:identity.accountType,scope:"instagram_business_basic instagram_business_content_publish instagram_business_manage_insights instagram_business_manage_comments",issuedAt: now, expiresAt: identity.expiresAt } satisfies InstagramCredentialPayload), now);
    const account: ConnectedAccount = {
      id: existing?.id ?? `account_${randomUUID()}`, workspaceId: state.workspaceId, brandId: state.brandId, platform: "instagram", displayName: identity.displayName,
      externalAccountId: identity.externalAccountId, credentialRef: `secret:${secret.id}`, capabilities: ["profile_read", "media_publish", "comment_read", "comment_reply"], status: "healthy",
      expiresAt: identity.expiresAt, lastCheckedAt: now, lastHealthyAt: now, createdBy: existing?.createdBy ?? state.actorId, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId: state.workspaceId, actorId: state.actorId, actorType: "human", action: existing ? "channel.oauth-reconnected" : "channel.oauth-connected", detail: { connectedAccountId: account.id, platform: "instagram", externalAccountId: account.externalAccountId, accountType: identity.accountType, capabilities: account.capabilities, expiresAt: account.expiresAt }, createdAt: now };
    const oldCredentialId = credentialId(existing?.credentialRef);
    const grant = this.metaGrant({ workspaceId: state.workspaceId, actorId: state.actorId, authorizationKind: "instagram_login", providerSubject: identity.externalAccountId, scopes: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights", "instagram_business_manage_comments"], issuedAt: now, accessExpiresAt: identity.expiresAt });
    await this.infrastructure.connectedAccountRepository.save(account, audit, { save: secret, ...(oldCredentialId ? { deleteId: oldCredentialId } : {}) }, { grant });
    await this.infrastructure.engagementQueue?.add("subscribe-account", { name: "subscribe-account", workspaceId: account.workspaceId, brandId: account.brandId, accountId: account.id }, {
      jobId: `engagement-subscribe-${account.id}-${Date.parse(account.updatedAt)}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return { redirectUrl: this.redirect(state.returnUrl, { channel: "connected", accountId: account.id }), connected: true as const, accountId: account.id };
  }

  async callbackFacebook(input: { state: string; code?: string; error?: string; errorDescription?: string }) {
    if(input.state.startsWith(instagramFacebookStatePrefix))throw new BadRequestException("This connection request belongs to the Instagram Facebook Login callback.");
    const consumedAt = new Date().toISOString();
    const state = await this.infrastructure.oauthRepository.consumeState(hash(input.state), "facebook", consumedAt);
    if (!state) throw new BadRequestException("This Facebook connection request is invalid, expired, or already used.");
    if (input.error) return { redirectUrl: this.redirect(state.returnUrl, { channel: "error", reason: "provider_denied" }), connected: false as const };
    if (!input.code) throw new BadRequestException("Facebook did not return an authorization code.");
    if (this.config.get<string>("AUTH_MODE") === "sessions") {
      const membership = await this.infrastructure.authRepository.getMembership(state.workspaceId, state.actorId);
      if (!membership || !can(membership.role, "workspace:manage")) throw new ForbiddenException("The person who started this connection no longer manages the workspace.");
    }
    const discovery = await this.exchangeAndDiscoverFacebookPages(input.code);
    if (!discovery.pages.length) return { redirectUrl: this.redirect(state.returnUrl, { channel: "error", reason: "no_eligible_facebook_pages" }), connected: false as const };
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const selection = this.vault.seal(state.workspaceId, "provider-discovery", JSON.stringify({ provider: "facebook-selection", workspaceId: state.workspaceId, brandId: state.brandId, actorId: state.actorId, expiresAt, providerSubject: discovery.providerSubject, ...(discovery.grantExpiresAt ? { grantExpiresAt: discovery.grantExpiresAt } : {}), pages: discovery.pages } satisfies FacebookSelectionPayload), consumedAt);
    await this.infrastructure.oauthRepository.saveCredential(selection);
    return { redirectUrl: this.redirect(state.returnUrl, { channel: "select_facebook", selectionId: selection.id }), connected: false as const, selectionId: selection.id };
  }

  async callbackInstagramFacebook(input:{state:string;code?:string;error?:string;errorDescription?:string}){
    if(!input.state.startsWith(instagramFacebookStatePrefix))throw new BadRequestException("This Instagram Facebook Login request is invalid.");
    const consumedAt=new Date().toISOString(); const state=await this.infrastructure.oauthRepository.consumeState(hash(input.state),"facebook",consumedAt);
    if(!state)throw new BadRequestException("This Instagram Facebook Login request is invalid, expired, or already used.");
    if(input.error)return{redirectUrl:this.redirect(state.returnUrl,{channel:"error",reason:"provider_denied"}),connected:false as const};
    if(!input.code)throw new BadRequestException("Facebook did not return an authorization code.");
    if(this.config.get<string>("AUTH_MODE")==="sessions"){const membership=await this.infrastructure.authRepository.getMembership(state.workspaceId,state.actorId);if(!membership||!can(membership.role,"workspace:manage"))throw new ForbiddenException("The person who started this connection no longer manages the workspace.");}
    const discovery=await this.exchangeAndDiscoverInstagramAccounts(input.code);
    if(!discovery.accounts.length)return{redirectUrl:this.redirect(state.returnUrl,{channel:"error",reason:"no_eligible_instagram_accounts"}),connected:false as const};
    const expiresAt=new Date(Date.now()+10*60_000).toISOString(); const selection=this.vault.seal(state.workspaceId,"provider-discovery",JSON.stringify({provider:"instagram-facebook-selection",workspaceId:state.workspaceId,brandId:state.brandId,actorId:state.actorId,expiresAt,providerSubject:discovery.providerSubject,...(discovery.grantExpiresAt?{grantExpiresAt:discovery.grantExpiresAt}:{}),accounts:discovery.accounts} satisfies InstagramFacebookSelectionPayload),consumedAt);
    await this.infrastructure.oauthRepository.saveCredential(selection);
    return{redirectUrl:this.redirect(state.returnUrl,{channel:"select_instagram",selectionId:selection.id}),connected:false as const,selectionId:selection.id};
  }

  async getInstagramFacebookSelection(workspaceId:string,selectionId:string,actor:Actor){
    if(!can(actor.role,"workspace:manage"))throw new ForbiddenException("Only workspace owners can select Instagram accounts.");
    const selection=await this.openInstagramFacebookSelection(workspaceId,selectionId,actor);
    return{selectionId,expiresAt:selection.expiresAt,connectionMode:"facebook_login" as const,accounts:selection.accounts.map(({externalAccountId,username,displayName,pageId,pageName})=>({externalAccountId,username,displayName,pageId,pageName}))};
  }

  async completeInstagramFacebookSelection(workspaceId:string,selectionId:string,instagramAccountIds:string[],actor:Actor){
    if(!can(actor.role,"workspace:manage"))throw new ForbiddenException("Only workspace owners can select Instagram accounts.");
    const selection=await this.openInstagramFacebookSelection(workspaceId,selectionId,actor); const uniqueIds=[...new Set(instagramAccountIds.map((value)=>value.trim()).filter(Boolean))];
    if(!uniqueIds.length||uniqueIds.length>100)throw new BadRequestException("Select between 1 and 100 Instagram accounts.");
    const candidates=uniqueIds.map((id)=>selection.accounts.find((account)=>account.externalAccountId===id)); if(candidates.some((account)=>!account))throw new BadRequestException("One or more selected Instagram accounts are not part of this connection request.");
    const existingAccounts=await this.infrastructure.connectedAccountRepository.list(workspaceId);
    for(const candidate of candidates as InstagramFacebookCandidate[]){const existing=existingAccounts.find((account)=>account.platform==="instagram"&&account.externalAccountId===candidate.externalAccountId);if(existing&&existing.brandId!==selection.brandId)throw new ConflictException(`${candidate.displayName} is already assigned to another brand in this workspace.`);}
    const connected=[];const entries=[];
    for(const candidate of candidates as InstagramFacebookCandidate[]){const existing=existingAccounts.find((account)=>account.platform==="instagram"&&account.externalAccountId===candidate.externalAccountId);const now=new Date().toISOString();const probe=instagramCollaboratorProbe(this.config,candidate.providerVersion);const collaboratorCapabilities=probe.state==="verified"?["collaborator_publish","collaborator_status_read"] as const:[];const secret=this.vault.seal(workspaceId,"provider-token",JSON.stringify({accessToken:candidate.accessToken,tokenType:"bearer",provider:"instagram",externalAccountId:candidate.externalAccountId,connectionMode:"facebook_login",accountType:"BUSINESS",canonicalUsername:candidate.username,scope:candidate.grantedScopes.join(" "),grantedScopes:candidate.grantedScopes,endpointFamily:candidate.endpointFamily,providerVersion:candidate.providerVersion,appVersion:candidate.appVersion,providerAccountVersion:candidate.providerAccountVersion,accountVersion:now,pageId:candidate.pageId,pageTasks:candidate.pageTasks,issuedAt:now} satisfies InstagramFacebookCredentialPayload),now);
      const account:ConnectedAccount={id:existing?.id??`account_${randomUUID()}`,workspaceId,brandId:selection.brandId,platform:"instagram",displayName:candidate.displayName,externalAccountId:candidate.externalAccountId,credentialRef:`secret:${secret.id}`,capabilities:["profile_read","media_publish","comment_read","comment_reply",...collaboratorCapabilities],status:"healthy",lastCheckedAt:now,lastHealthyAt:now,createdBy:existing?.createdBy??actor.id,createdAt:existing?.createdAt??now,updatedAt:now};
      const audit:AuditEvent={id:`audit_${randomUUID()}`,workspaceId,actorId:actor.id,actorType:"human",action:existing?"channel.oauth-reconnected":"channel.oauth-connected",detail:{connectedAccountId:account.id,platform:"instagram",externalAccountId:account.externalAccountId,connectionMode:"facebook_login",accountType:"BUSINESS",publisherUsername:candidate.username,capabilities:account.capabilities,endpointFamily:candidate.endpointFamily,providerVersion:candidate.providerVersion,appVersion:candidate.appVersion,providerAccountVersion:candidate.providerAccountVersion,accountVersion:now,grantedScopes:candidate.grantedScopes},createdAt:now};
      const oldCredentialId=credentialId(existing?.credentialRef);entries.push({account,event:audit,credentialChange:{save:secret,...(oldCredentialId?{deleteId:oldCredentialId}:{})}});const{credentialRef:_credentialRef,...safe}=account;connected.push({...safe,credentialConfigured:true,credentialManaged:true});}
    const grant=this.metaGrant({workspaceId,actorId:actor.id,authorizationKind:"facebook_login",providerSubject:selection.providerSubject,scopes:[...instagramFacebookScopes],issuedAt:new Date().toISOString(),...(selection.grantExpiresAt?{accessExpiresAt:selection.grantExpiresAt}:{})});
    if(!await this.infrastructure.connectedAccountRepository.completeOAuthSelection(workspaceId,selectionId,entries,{grant}))throw new ConflictException("This Instagram account selection is already being completed or was already used.");
    return{connected:true as const,connectionMode:"facebook_login" as const,accounts:connected};
  }

  async getFacebookSelection(workspaceId: string, selectionId: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can select Facebook Pages.");
    const selection = await this.openFacebookSelection(workspaceId, selectionId, actor);
    return {
      selectionId,
      expiresAt: selection.expiresAt,
      pages: selection.pages.map(({ externalAccountId, displayName }) => ({ externalAccountId, displayName })),
    };
  }

  async completeFacebookSelection(workspaceId: string, selectionId: string, pageIds: string[], actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can select Facebook Pages.");
    const selection = await this.openFacebookSelection(workspaceId, selectionId, actor);
    const uniqueIds = [...new Set(pageIds.map((value) => value.trim()).filter(Boolean))];
    if (!uniqueIds.length || uniqueIds.length > 100) throw new BadRequestException("Select between 1 and 100 Facebook Pages.");
    const candidates = uniqueIds.map((id) => selection.pages.find((page) => page.externalAccountId === id));
    if (candidates.some((page) => !page)) throw new BadRequestException("One or more selected Facebook Pages are not part of this connection request.");
    const existingAccounts = await this.infrastructure.connectedAccountRepository.list(workspaceId);
    for (const page of candidates as FacebookPageCandidate[]) {
      const existing = existingAccounts.find((account) => account.platform === "facebook" && account.externalAccountId === page.externalAccountId);
      if (existing && existing.brandId !== selection.brandId) throw new ConflictException(`${page.displayName} is already assigned to another brand in this workspace.`);
    }

    const connected = [];
    const entries = [];
    for (const page of candidates as FacebookPageCandidate[]) {
      const existing = existingAccounts.find((account) => account.platform === "facebook" && account.externalAccountId === page.externalAccountId);
      const now = new Date().toISOString();
      const pageTasks = [...new Set(page.tasks)].sort();
      const scopes = this.facebookScopes();
      const secret = this.vault.seal(workspaceId, "provider-token", JSON.stringify({ accessToken: page.accessToken, tokenType: "bearer", provider: "facebook", externalAccountId: page.externalAccountId, scope: scopes.join(" "), issuedAt: now, pageTasks } satisfies FacebookCredentialPayload), now);
      const account: ConnectedAccount = {
        id: existing?.id ?? `account_${randomUUID()}`,
        workspaceId,
        brandId: selection.brandId,
        platform: "facebook",
        displayName: page.displayName,
        externalAccountId: page.externalAccountId,
        credentialRef: `secret:${secret.id}`,
        capabilities: ["page_read", "media_publish", ...(scopes.includes("read_insights") && pageTasks.includes("ANALYZE") ? ["analytics_read" as const] : [])],
        status: "healthy",
        lastCheckedAt: now,
        lastHealthyAt: now,
        createdBy: existing?.createdBy ?? actor.id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: existing ? "channel.oauth-reconnected" : "channel.oauth-connected", detail: { connectedAccountId: account.id, platform: "facebook", externalAccountId: account.externalAccountId, capabilities: account.capabilities, tasks: pageTasks.filter((task) => task === "CREATE_CONTENT" || task === "ANALYZE") }, createdAt: now };
      const oldCredentialId = credentialId(existing?.credentialRef);
      entries.push({ account, event: audit, credentialChange: { save: secret, ...(oldCredentialId ? { deleteId: oldCredentialId } : {}) } });
      const { credentialRef: _credentialRef, ...safe } = account;
      connected.push({ ...safe, credentialConfigured: true, credentialManaged: true });
    }
    const grant = this.metaGrant({ workspaceId, actorId: actor.id, authorizationKind: "facebook_login", providerSubject: selection.providerSubject, scopes: this.facebookScopes(), issuedAt: new Date().toISOString(), ...(selection.grantExpiresAt ? { accessExpiresAt: selection.grantExpiresAt } : {}) });
    if (!await this.infrastructure.connectedAccountRepository.completeOAuthSelection(workspaceId, selectionId, entries, { grant })) throw new ConflictException("This Facebook Page selection is already being completed or was already used.");
    return { connected: true as const, accounts: connected };
  }

  async refreshInstagram(workspaceId: string, accountId: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can renew Instagram access.");
    if (!this.vault.configured()) throw new ConflictException("Credential encryption is not configured.");
    const current = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId);
    if (!current || current.platform !== "instagram") throw new BadRequestException("Instagram account not found in this workspace.");
    const oldCredentialId = credentialId(current.credentialRef);
    if (!oldCredentialId) throw new ConflictException("This account does not use the built-in OAuth credential store. Reconnect it with Instagram OAuth.");
    if (!current.expiresAt) throw new ConflictException("This Instagram access has no renewable expiry. Reconnect the account.");
    const payload = this.parseInstagramCredential(await this.vault.open(workspaceId, oldCredentialId), current.externalAccountId);
    if(payload.connectionMode==="facebook_login")throw new ConflictException("Facebook Login Instagram access must be renewed by reconnecting the account through Facebook Login.");
    try {
      const refreshed = await this.refreshInstagramToken(payload.accessToken);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + Math.max(60, refreshed.expiresIn) * 1000).toISOString();
      const secret = this.vault.seal(workspaceId, "provider-token", JSON.stringify({ ...payload, accessToken: refreshed.accessToken, tokenType: refreshed.tokenType, issuedAt: now, expiresAt } satisfies InstagramCredentialPayload), now);
      const updated: ConnectedAccount = {
        ...current, credentialRef: `secret:${secret.id}`, status: "healthy", expiresAt,
        lastCheckedAt: now, lastHealthyAt: now, lastErrorCode: undefined, lastErrorStep: undefined, lastErrorSummary: undefined, updatedAt: now,
      };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: "channel.oauth-refreshed", detail: { connectedAccountId: accountId, platform: "instagram", externalAccountId: current.externalAccountId, expiresAt }, createdAt: now };
      if (!await this.infrastructure.connectedAccountRepository.saveCredentialRefreshResult(updated, audit, { expectedCredentialRef: current.credentialRef!, expectedExpiresAt: current.expiresAt }, { save: secret, deleteId: oldCredentialId })) throw new ConflictException("This Instagram account changed while access was renewing. Refresh Channels and try again.");
      const { credentialRef: _credentialRef, ...safe } = updated;
      return { ...safe, credentialConfigured: true, credentialManaged: true };
    } catch (cause) {
      if (cause instanceof ConflictException || cause instanceof BadRequestException || cause instanceof ForbiddenException) throw cause;
      const now = new Date().toISOString();
      const failed: ConnectedAccount = { ...current, status: "refresh_failed", lastCheckedAt: now, lastErrorCode: "token_refresh", lastErrorStep: "Renew provider access", lastErrorSummary: "Instagram did not renew this access. Reconnect the account and try again.", updatedAt: now };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: "channel.oauth-refresh-failed", detail: { connectedAccountId: accountId, platform: "instagram", externalAccountId: current.externalAccountId, reason: "provider_rejected" }, createdAt: now };
      if (!await this.infrastructure.connectedAccountRepository.saveCredentialRefreshResult(failed, audit, { expectedCredentialRef: current.credentialRef!, expectedExpiresAt: current.expiresAt })) throw new ConflictException("This Instagram account changed while access was renewing. Refresh Channels and try again.");
      throw new BadGatewayException("Instagram could not renew this access. Reconnect the account and try again.");
    }
  }

  async refreshYouTube(workspaceId: string, accountId: string, actor: Actor) {
    if (!can(actor.role, "workspace:manage")) throw new ForbiddenException("Only workspace owners can renew YouTube access.");
    if (!this.youtubeConfigured()) throw new ConflictException("YouTube OAuth or credential encryption is not configured.");
    const current = await this.infrastructure.connectedAccountRepository.get(workspaceId, accountId);
    if (!current || current.platform !== "youtube") throw new BadRequestException("YouTube account not found in this workspace.");
    const oldCredentialId = credentialId(current.credentialRef);
    if (!oldCredentialId) throw new ConflictException("This account does not use the built-in OAuth credential store. Reconnect it with YouTube OAuth.");
    if (!current.expiresAt) throw new ConflictException("This YouTube access has no renewable expiry. Reconnect the account.");
    const payload = this.parseYouTubeCredential(await this.vault.open(workspaceId, oldCredentialId), current.externalAccountId);
    try {
      const refreshed = await this.refreshYouTubeToken(payload.refreshToken);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + Math.max(60, refreshed.expiresIn) * 1000).toISOString();
      const secret = this.vault.seal(workspaceId, "provider-token", JSON.stringify({ ...payload, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? payload.refreshToken, tokenType: refreshed.tokenType, scope: refreshed.scope ?? payload.scope, issuedAt: now, expiresAt } satisfies YouTubeCredentialPayload), now);
      const updated: ConnectedAccount = {
        ...current, credentialRef: `secret:${secret.id}`, status: "healthy", expiresAt,
        lastCheckedAt: now, lastHealthyAt: now, lastErrorCode: undefined, lastErrorStep: undefined, lastErrorSummary: undefined, updatedAt: now,
      };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: "channel.oauth-refreshed", detail: { connectedAccountId: accountId, platform: "youtube", externalAccountId: current.externalAccountId, expiresAt }, createdAt: now };
      if (!await this.infrastructure.connectedAccountRepository.saveCredentialRefreshResult(updated, audit, { expectedCredentialRef: current.credentialRef!, expectedExpiresAt: current.expiresAt }, { save: secret, deleteId: oldCredentialId })) throw new ConflictException("This YouTube account changed while access was renewing. Refresh Channels and try again.");
      const { credentialRef: _credentialRef, ...safe } = updated;
      return { ...safe, credentialConfigured: true, credentialManaged: true };
    } catch (cause) {
      if (cause instanceof ConflictException || cause instanceof BadRequestException || cause instanceof ForbiddenException) throw cause;
      const now = new Date().toISOString();
      const failed: ConnectedAccount = { ...current, status: "refresh_failed", lastCheckedAt: now, lastErrorCode: "token_refresh", lastErrorStep: "Renew provider access", lastErrorSummary: "YouTube did not renew this access. Reconnect the account and try again.", updatedAt: now };
      const audit: AuditEvent = { id: `audit_${randomUUID()}`, workspaceId, actorId: actor.id, actorType: "human", action: "channel.oauth-refresh-failed", detail: { connectedAccountId: accountId, platform: "youtube", externalAccountId: current.externalAccountId, reason: "provider_rejected" }, createdAt: now };
      if (!await this.infrastructure.connectedAccountRepository.saveCredentialRefreshResult(failed, audit, { expectedCredentialRef: current.credentialRef!, expectedExpiresAt: current.expiresAt })) throw new ConflictException("This YouTube account changed while access was renewing. Refresh Channels and try again.");
      throw new BadGatewayException("YouTube could not renew this access. Reconnect the account and try again.");
    }
  }

  private metaApiVersion(): string {
    const value = this.config.get<string>("META_GRAPH_API_VERSION") ?? "v26.0";
    if (!/^v\d+\.\d+$/.test(value)) throw new ConflictException("META_GRAPH_API_VERSION must look like v26.0.");
    return value;
  }

  private metaMessagingAppReviewReference():string|undefined{
    const value=this.config.get<string>("META_PRIVATE_MESSAGING_APP_REVIEW_SHA256")?.trim()??(this.testMode()?"f".repeat(64):"");
    return /^[a-f0-9]{64}$/.test(value)?value:undefined;
  }

  private metaMessagingProvider():MetaMessagingOAuthProvider{
    return new MetaMessagingOAuthProvider({apiVersion:this.metaApiVersion(),appId:this.config.get<string>("META_APP_ID")??"test-meta-app",appSecret:this.config.get<string>("META_APP_SECRET")??"test-meta-secret",callbackUrl:this.metaMessagingCallbackUrl(),testMode:this.testMode()});
  }

  private async openMetaMessagingSelection(workspaceId:string,selectionId:string,actor:Actor):Promise<MetaMessagingSelectionPayload>{
    if(!selectionId.startsWith("credential_"))throw new BadRequestException("This Meta messaging selection is invalid.");let payload:Partial<MetaMessagingSelectionPayload>;
    try{payload=JSON.parse(await this.vault.open(workspaceId,selectionId)) as Partial<MetaMessagingSelectionPayload>;}catch{throw new BadRequestException("This Meta messaging selection is invalid or no longer available.");}
    const validCandidates=Array.isArray(payload.candidates)&&payload.candidates.length<=200&&payload.candidates.every((candidate)=>candidate&&typeof candidate.targetKey==="string"&&typeof candidate.accountId==="string"&&(candidate.connectionMode==="facebook_page_messenger"||candidate.connectionMode==="instagram_linked_page")&&typeof candidate.externalBusinessAccountId==="string"&&typeof candidate.endpointPageId==="string"&&typeof candidate.displayName==="string"&&typeof candidate.pageName==="string"&&typeof candidate.accessToken==="string"&&Boolean(candidate.accessToken)&&Array.isArray(candidate.pageTasks)&&candidate.pageTasks.every((task)=>typeof task==="string")&&Array.isArray(candidate.grantedScopes)&&candidate.grantedScopes.every((scope)=>typeof scope==="string")&&metaMessagingScopes.every((scope)=>candidate.grantedScopes.includes(scope))&&candidate.targetKey===`${candidate.connectionMode}:${candidate.externalBusinessAccountId}`);
    if(payload.provider!=="meta-messaging-selection"||payload.workspaceId!==workspaceId||payload.actorId!==actor.id||typeof payload.brandId!=="string"||typeof payload.expiresAt!=="string"||typeof payload.providerSubject!=="string"||!/^[1-9][0-9]{0,39}$/.test(payload.providerSubject)||!validCandidates)throw new ForbiddenException("This Meta messaging selection does not belong to your connection request.");
    if(Date.parse(payload.expiresAt)<=Date.now()){await this.infrastructure.oauthRepository.deleteCredential(workspaceId,selectionId);throw new BadRequestException("This Meta messaging selection expired. Start re-consent again.");}
    return payload as MetaMessagingSelectionPayload;
  }

  private async openFacebookSelection(workspaceId: string, selectionId: string, actor: Actor): Promise<FacebookSelectionPayload> {
    if (!selectionId.startsWith("credential_")) throw new BadRequestException("This Facebook Page selection is invalid.");
    let payload: Partial<FacebookSelectionPayload>;
    try { payload = JSON.parse(await this.vault.open(workspaceId, selectionId)) as Partial<FacebookSelectionPayload>; }
    catch { throw new BadRequestException("This Facebook Page selection is invalid or no longer available."); }
    const validPages = Array.isArray(payload.pages) && payload.pages.every((page) => page && typeof page.externalAccountId === "string" && typeof page.displayName === "string" && typeof page.accessToken === "string" && Array.isArray(page.tasks));
    if (payload.provider !== "facebook-selection" || payload.workspaceId !== workspaceId || payload.actorId !== actor.id || typeof payload.brandId !== "string" || typeof payload.expiresAt !== "string" || typeof payload.providerSubject !== "string" || !/^[1-9][0-9]{0,39}$/.test(payload.providerSubject) || (payload.grantExpiresAt !== undefined && !Number.isFinite(Date.parse(payload.grantExpiresAt))) || !validPages) {
      throw new ForbiddenException("This Facebook Page selection does not belong to your connection request.");
    }
    if (new Date(payload.expiresAt).getTime() <= Date.now()) {
      await this.infrastructure.oauthRepository.deleteCredential(workspaceId, selectionId);
      throw new BadRequestException("This Facebook Page selection expired. Start the connection again.");
    }
    return payload as FacebookSelectionPayload;
  }

  private async openInstagramFacebookSelection(workspaceId:string,selectionId:string,actor:Actor):Promise<InstagramFacebookSelectionPayload>{
    if(!selectionId.startsWith("credential_"))throw new BadRequestException("This Instagram account selection is invalid.");
    let payload:Partial<InstagramFacebookSelectionPayload>;try{payload=JSON.parse(await this.vault.open(workspaceId,selectionId)) as Partial<InstagramFacebookSelectionPayload>;}catch{throw new BadRequestException("This Instagram account selection is invalid or no longer available.");}
    const providerVersion=this.metaApiVersion();const expectedAppVersion=instagramFacebookAppVersion(this.testMode()?"test-facebook-client":this.config.get<string>("META_APP_ID")!,providerVersion,this.instagramFacebookCallbackUrl());
    const validAccounts=Array.isArray(payload.accounts)&&payload.accounts.every((account)=>account&&typeof account.externalAccountId==="string"&&typeof account.username==="string"&&/^[a-z0-9._]{1,30}$/.test(account.username)&&typeof account.displayName==="string"&&typeof account.pageId==="string"&&typeof account.pageName==="string"&&typeof account.accessToken==="string"&&Boolean(account.accessToken)&&Array.isArray(account.pageTasks)&&account.pageTasks.every((task)=>typeof task==="string")&&account.pageTasks.includes("CREATE_CONTENT")&&Array.isArray(account.grantedScopes)&&account.grantedScopes.every((scope)=>typeof scope==="string")&&instagramFacebookScopes.every((scope)=>account.grantedScopes.includes(scope))&&account.endpointFamily===instagramFacebookEndpointFamily&&account.providerVersion===providerVersion&&account.appVersion===expectedAppVersion&&account.providerAccountVersion===instagramFacebookProviderAccountVersion(account.pageId,account.externalAccountId,account.username));
    if(payload.provider!=="instagram-facebook-selection"||payload.workspaceId!==workspaceId||payload.actorId!==actor.id||typeof payload.brandId!=="string"||typeof payload.expiresAt!=="string"||typeof payload.providerSubject!=="string"||!/^[1-9][0-9]{0,39}$/.test(payload.providerSubject)||(payload.grantExpiresAt!==undefined&&!Number.isFinite(Date.parse(payload.grantExpiresAt)))||!validAccounts)throw new ForbiddenException("This Instagram account selection does not belong to your connection request.");
    if(Date.parse(payload.expiresAt)<=Date.now()){await this.infrastructure.oauthRepository.deleteCredential(workspaceId,selectionId);throw new BadRequestException("This Instagram account selection expired. Start the connection again.");}
    return payload as InstagramFacebookSelectionPayload;
  }

  private parseFacebookCredential(value: string, expectedExternalAccountId: string): FacebookCredentialPayload {
    let payload: Partial<FacebookCredentialPayload>;
    try { payload = JSON.parse(value) as Partial<FacebookCredentialPayload>; }
    catch { throw new ConflictException("The protected Facebook credential is invalid. Reconnect the Page."); }
    if (payload.provider !== "facebook" || typeof payload.accessToken !== "string" || !payload.accessToken || payload.externalAccountId !== expectedExternalAccountId || typeof payload.issuedAt !== "string" || !Array.isArray(payload.pageTasks) || !payload.pageTasks.every((task)=>typeof task==="string"&&Boolean(task.trim()))) {
      throw new ConflictException("The protected Facebook credential does not match this Page. Reconnect it.");
    }
    return { accessToken: payload.accessToken, tokenType: "bearer", provider: "facebook", externalAccountId: payload.externalAccountId, ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}), issuedAt: payload.issuedAt, pageTasks:[...new Set(payload.pageTasks)].sort() };
  }

  private async readFacebookPageIdentity(payload: FacebookCredentialPayload): Promise<{ displayName: string; pageTasks: string[] }> {
    if (this.testMode()) return { displayName: `Facebook Page ${payload.externalAccountId}`, pageTasks: [...payload.pageTasks] };
    const query = new URLSearchParams({ fields: "id,name,tasks", appsecret_proof: this.metaAppSecretProof(payload.accessToken), appsecret_time: String(Math.floor(Date.now() / 1000)) });
    const response = await fetch(`https://graph.facebook.com/${this.metaApiVersion()}/${encodeURIComponent(payload.externalAccountId)}?${query.toString()}`, {
      headers: { authorization: `Bearer ${payload.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => ({})) as { id?: string; name?: string; tasks?: string[]; error?: unknown };
    if (!response.ok || value.error || value.id !== payload.externalAccountId || !value.name || !value.tasks?.includes("CREATE_CONTENT")) throw new Error("Facebook Page access is no longer valid.");
    return { displayName: value.name, pageTasks: [...new Set(value.tasks.filter((task) => typeof task === "string"))].sort() };
  }

  private metaAppSecretProof(accessToken: string): string {
    return createHmac("sha256", this.config.get<string>("META_APP_SECRET")!).update(accessToken).digest("hex");
  }

  private async exchangeAndDiscoverInstagramAccounts(code:string):Promise<{providerSubject:string;grantExpiresAt?:string;accounts:InstagramFacebookCandidate[]}>{
    const providerVersion=this.metaApiVersion(); const endpointFamily=instagramFacebookEndpointFamily; const graphOrigin="graph.facebook.com"; const callbackUrl=this.instagramFacebookCallbackUrl(); const scopes=[...instagramFacebookScopes].sort();
    if(this.testMode()){
      if(code!=="originpost-instagram-facebook-oauth-test-code")throw new BadGatewayException("The test provider rejected this Instagram Facebook Login authorization code.");
      const appVersion=instagramFacebookAppVersion("test-facebook-client",providerVersion,callbackUrl);
      return{providerSubject:"100000000000001",grantExpiresAt:new Date(Date.now()+60*24*60*60_000).toISOString(),accounts:[
        {externalAccountId:"test-instagram-facebook-1",username:"originpost.test",displayName:"@originpost.test",pageId:"test-facebook-page-1",pageName:"OAuth Test Facebook Page",accessToken:"test-instagram-facebook-page-token-1-never-returned",pageTasks:["CREATE_CONTENT","MODERATE"],grantedScopes:scopes,endpointFamily,providerVersion,appVersion,providerAccountVersion:instagramFacebookProviderAccountVersion("test-facebook-page-1","test-instagram-facebook-1","originpost.test")},
        {externalAccountId:"test-instagram-facebook-2",username:"originpost.community",displayName:"@originpost.community",pageId:"test-facebook-page-2",pageName:"OAuth Test Community Page",accessToken:"test-instagram-facebook-page-token-2-never-returned",pageTasks:["CREATE_CONTENT"],grantedScopes:scopes,endpointFamily,providerVersion,appVersion,providerAccountVersion:instagramFacebookProviderAccountVersion("test-facebook-page-2","test-instagram-facebook-2","originpost.community")},
      ]};
    }
    const appId=this.config.get<string>("META_APP_ID")!;const appSecret=this.config.get<string>("META_APP_SECRET")!;const graphBase=`https://${graphOrigin}/${providerVersion}`;
    const tokenResponse=await fetch(`${graphBase}/oauth/access_token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:appId,client_secret:appSecret,redirect_uri:callbackUrl,code}),redirect:"error",signal:AbortSignal.timeout(15_000)});
    const short=await tokenResponse.json().catch(()=>({})) as{access_token?:string;error?:unknown};if(!tokenResponse.ok||short.error||!short.access_token)throw new BadGatewayException("Facebook could not exchange the Instagram authorization code.");
    const debugResponse=await fetch(`${graphBase}/debug_token`,{method:"POST",headers:{authorization:`Bearer ${appId}|${appSecret}`,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({input_token:short.access_token}),redirect:"error",signal:AbortSignal.timeout(15_000)});
    const debug=await debugResponse.json().catch(()=>({})) as{data?:{is_valid?:boolean;app_id?:string;user_id?:string};error?:unknown};if(!debugResponse.ok||debug.error||debug.data?.is_valid!==true||debug.data.app_id!==appId||!debug.data.user_id)throw new BadGatewayException("Facebook returned an invalid Instagram access grant.");
    const longResponse=await fetch(`${graphBase}/oauth/access_token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"fb_exchange_token",client_id:appId,client_secret:appSecret,fb_exchange_token:short.access_token}),redirect:"error",signal:AbortSignal.timeout(15_000)});
    const long=await longResponse.json().catch(()=>({})) as{access_token?:string;expires_in?:number;error?:unknown};if(!longResponse.ok||long.error||!long.access_token)throw new BadGatewayException("Facebook could not create long-lived Instagram access.");
    const proof=this.metaAppSecretProof(long.access_token);const permissionQuery=new URLSearchParams({appsecret_proof:proof,appsecret_time:String(Math.floor(Date.now()/1000))});
    const permissionResponse=await fetch(`${graphBase}/me/permissions?${permissionQuery.toString()}`,{headers:{authorization:`Bearer ${long.access_token}`},redirect:"error",signal:AbortSignal.timeout(15_000)});const permissionBody=await permissionResponse.json().catch(()=>({})) as{data?:Array<{permission?:string;status?:string}>;error?:unknown};
    const granted=[...new Set((permissionBody.data??[]).filter((entry)=>entry.status==="granted"&&entry.permission).map((entry)=>entry.permission!))].sort();if(!permissionResponse.ok||permissionBody.error||scopes.some((scope)=>!granted.includes(scope)))throw new BadGatewayException("Instagram permissions were not fully granted. Reconnect and approve Page discovery, publishing, comments, insights, and content management access.");
    const appVersion=instagramFacebookAppVersion(appId,providerVersion,callbackUrl);const accounts:InstagramFacebookCandidate[]=[];let after:string|undefined;
    for(let pageNo=0;pageNo<10;pageNo+=1){const query=new URLSearchParams({fields:"id,name,access_token,tasks,instagram_business_account{id,username}",limit:"100",appsecret_proof:proof,appsecret_time:String(Math.floor(Date.now()/1000))});if(after)query.set("after",after);
      const response=await fetch(`${graphBase}/me/accounts?${query.toString()}`,{headers:{authorization:`Bearer ${long.access_token}`},redirect:"error",signal:AbortSignal.timeout(15_000)});const value=await response.json().catch(()=>({})) as{data?:Array<{id?:string;name?:string;access_token?:string;tasks?:string[];instagram_business_account?:{id?:string;username?:string}}>;paging?:{cursors?:{after?:string};next?:string};error?:unknown};if(!response.ok||value.error)throw new BadGatewayException("Facebook could not list Instagram professional accounts.");
      for(const page of value.data??[]){const identity=page.instagram_business_account;const username=identity?.username?.normalize("NFC").trim().replace(/^@/,"").toLowerCase();const pageTasks=[...new Set((page.tasks??[]).filter((task)=>typeof task==="string"&&Boolean(task.trim())))].sort();if(!page.id||!page.name||!page.access_token||!identity?.id||!username||!/^[a-z0-9._]{1,30}$/.test(username)||!pageTasks.includes("CREATE_CONTENT")||accounts.some((entry)=>entry.externalAccountId===identity.id))continue;accounts.push({externalAccountId:identity.id,username,displayName:`@${username}`,pageId:page.id,pageName:page.name,accessToken:page.access_token,pageTasks,grantedScopes:granted,endpointFamily,providerVersion,appVersion,providerAccountVersion:instagramFacebookProviderAccountVersion(page.id,identity.id,username)});}
      const nextAfter=value.paging?.next?value.paging.cursors?.after:undefined;if(!nextAfter||nextAfter===after)break;after=nextAfter;
    }
    return{providerSubject:String(debug.data.user_id),...(long.expires_in?{grantExpiresAt:new Date(Date.now()+Math.max(60,long.expires_in)*1000).toISOString()}:{}),accounts};
  }

  private async exchangeAndDiscoverFacebookPages(code: string): Promise<{ providerSubject: string; grantExpiresAt?: string; pages: FacebookPageCandidate[] }> {
    if (this.testMode()) {
      if (code !== "originpost-facebook-oauth-test-code") throw new BadGatewayException("The test provider rejected this Facebook authorization code.");
      return { providerSubject: "100000000000001", grantExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60_000).toISOString(), pages: [
        { externalAccountId: "test-facebook-page-1", displayName: "OAuth Test Facebook Page", accessToken: "test-facebook-page-token-1-never-returned", tasks: ["CREATE_CONTENT", "MODERATE", "ANALYZE"] },
        { externalAccountId: "test-facebook-page-2", displayName: "OAuth Test Community Page", accessToken: "test-facebook-page-token-2-never-returned", tasks: ["CREATE_CONTENT"] },
      ] };
    }
    const appId = this.config.get<string>("META_APP_ID")!;
    const appSecret = this.config.get<string>("META_APP_SECRET")!;
    const tokenUrl = new URL(`https://graph.facebook.com/${this.metaApiVersion()}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", this.facebookCallbackUrl());
    tokenUrl.searchParams.set("code", code);
    const shortResponse = await fetch(tokenUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const short = await shortResponse.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: unknown };
    if (!shortResponse.ok || short.error || !short.access_token) throw new BadGatewayException("Facebook could not exchange the authorization code.");

    const debugUrl = new URL(`https://graph.facebook.com/${this.metaApiVersion()}/debug_token`);
    debugUrl.searchParams.set("input_token", short.access_token);
    debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);
    const debugResponse = await fetch(debugUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const debug = await debugResponse.json().catch(() => ({})) as { data?: { is_valid?: boolean; app_id?: string; user_id?: string }; error?: unknown };
    if (!debugResponse.ok || debug.error || debug.data?.is_valid !== true || debug.data.app_id !== appId || !debug.data.user_id) throw new BadGatewayException("Facebook returned an invalid access grant.");

    const longUrl = new URL(`https://graph.facebook.com/${this.metaApiVersion()}/oauth/access_token`);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", short.access_token);
    const longResponse = await fetch(longUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const long = await longResponse.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: unknown };
    if (!longResponse.ok || long.error || !long.access_token) throw new BadGatewayException("Facebook could not create long-lived Page access.");

    const permissionQuery = new URLSearchParams({ appsecret_proof: createHmac("sha256", appSecret).update(long.access_token).digest("hex"), appsecret_time: String(Math.floor(Date.now() / 1000)) });
    const permissionResponse = await fetch(`https://graph.facebook.com/${this.metaApiVersion()}/me/permissions?${permissionQuery.toString()}`, { headers: { authorization: `Bearer ${long.access_token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const permissionBody = await permissionResponse.json().catch(() => ({})) as { data?: Array<{ permission?: string; status?: string }>; error?: unknown };
    const granted = new Set((permissionBody.data ?? []).filter((entry) => entry.status === "granted" && entry.permission).map((entry) => entry.permission!));
    const required = this.facebookScopes();
    if (!permissionResponse.ok || permissionBody.error || required.some((permission) => !granted.has(permission))) throw new BadGatewayException("Facebook Page permissions were not fully granted. Reconnect and approve Page listing, reading, and publishing access.");

    const pages: FacebookPageCandidate[] = [];
    let after: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const query = new URLSearchParams({ fields: "id,name,access_token,tasks", limit: "100", appsecret_proof: createHmac("sha256", appSecret).update(long.access_token).digest("hex"), appsecret_time: String(Math.floor(Date.now() / 1000)) });
      if (after) query.set("after", after);
      const response = await fetch(`https://graph.facebook.com/${this.metaApiVersion()}/me/accounts?${query.toString()}`, { headers: { authorization: `Bearer ${long.access_token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const value = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; name?: string; access_token?: string; tasks?: string[] }>; paging?: { cursors?: { after?: string }; next?: string }; error?: unknown };
      if (!response.ok || value.error) throw new BadGatewayException("Facebook could not list the Pages you manage.");
      for (const candidate of value.data ?? []) {
        if (candidate.id && candidate.name && candidate.access_token && candidate.tasks?.includes("CREATE_CONTENT") && !pages.some((page) => page.externalAccountId === candidate.id)) {
          pages.push({ externalAccountId: candidate.id, displayName: candidate.name, accessToken: candidate.access_token, tasks: candidate.tasks });
        }
      }
      const nextAfter = value.paging?.next ? value.paging.cursors?.after : undefined;
      if (!nextAfter || nextAfter === after) break;
      after = nextAfter;
    }
    return { providerSubject: String(debug.data.user_id), ...(long.expires_in ? { grantExpiresAt: new Date(Date.now() + Math.max(60, long.expires_in) * 1000).toISOString() } : {}), pages };
  }

  private redirect(base: string, values: Record<string, string>): string {
    const url = new URL(base);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    return url.toString();
  }

  private parseInstagramCredential(value: string, expectedExternalAccountId: string): InstagramCredentialPayload {
    let payload: Partial<InstagramCredentialPayload>;
    try { payload = JSON.parse(value) as Partial<InstagramCredentialPayload>; }
    catch { throw new ConflictException("The protected Instagram credential is invalid. Reconnect the account."); }
    if (payload.provider !== "instagram" || typeof payload.accessToken !== "string" || !payload.accessToken || payload.externalAccountId !== expectedExternalAccountId) {
      throw new ConflictException("The protected Instagram credential does not match this account. Reconnect it.");
    }
    return { accessToken: payload.accessToken, tokenType: payload.tokenType ?? "bearer", provider: "instagram", externalAccountId: payload.externalAccountId, ...(payload.connectionMode==="facebook_login"||payload.connectionMode==="instagram_login"?{connectionMode:payload.connectionMode}:{}), ...(payload.accountType==="BUSINESS"||payload.accountType==="MEDIA_CREATOR"?{accountType:payload.accountType}:{}), ...(typeof payload.scope==="string"?{scope:payload.scope}:{}), ...(typeof payload.publisherUsername==="string"?{publisherUsername:payload.publisherUsername}:{}), ...(payload.issuedAt ? { issuedAt: payload.issuedAt } : {}), ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}) };
  }

  private parseYouTubeCredential(value: string, expectedExternalAccountId: string): YouTubeCredentialPayload {
    let payload: Partial<YouTubeCredentialPayload>;
    try { payload = JSON.parse(value) as Partial<YouTubeCredentialPayload>; }
    catch { throw new ConflictException("The protected YouTube credential is invalid. Reconnect the account."); }
    if (payload.provider !== "youtube" || typeof payload.accessToken !== "string" || !payload.accessToken || typeof payload.refreshToken !== "string" || !payload.refreshToken || payload.externalAccountId !== expectedExternalAccountId) {
      throw new ConflictException("The protected YouTube credential does not match this account. Reconnect it.");
    }
    return { accessToken: payload.accessToken, refreshToken: payload.refreshToken, tokenType: payload.tokenType ?? "bearer", provider: "youtube", externalAccountId: payload.externalAccountId, scope: payload.scope ?? "", ...(payload.issuedAt ? { issuedAt: payload.issuedAt } : {}), ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}) };
  }

  private async refreshYouTubeToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; tokenType: string; expiresIn: number; scope?: string }> {
    if (this.testMode()) {
      if (!refreshToken.startsWith("test-")) throw new BadGatewayException("The test provider rejected this refresh token.");
      return { accessToken: "test-youtube-refreshed-access-token-never-returned", tokenType: "bearer", expiresIn: 3600 };
    }
    const body = new URLSearchParams({ client_id: this.config.get<string>("GOOGLE_CLIENT_ID")!, client_secret: this.config.get<string>("GOOGLE_CLIENT_SECRET")!, grant_type: "refresh_token", refresh_token: refreshToken });
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
    const value = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; scope?: string };
    if (!response.ok || !value.access_token || !value.expires_in) throw new BadGatewayException("YouTube rejected the access refresh.");
    return { accessToken: value.access_token, ...(value.refresh_token ? { refreshToken: value.refresh_token } : {}), tokenType: value.token_type ?? "bearer", expiresIn: value.expires_in, ...(value.scope ? { scope: value.scope } : {}) };
  }

  private async refreshInstagramToken(accessToken: string): Promise<{ accessToken: string; tokenType: string; expiresIn: number }> {
    if (this.testMode()) {
      if (!accessToken.startsWith("test-")) throw new BadGatewayException("The test provider rejected this access token.");
      return { accessToken: "test-refreshed-access-token-never-returned", tokenType: "bearer", expiresIn: 5_184_000 };
    }
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({})) as { access_token?: string; token_type?: string; expires_in?: number };
    if (!response.ok || !body.access_token || !body.expires_in) throw new BadGatewayException("Instagram rejected the access refresh.");
    return { accessToken: body.access_token, tokenType: body.token_type ?? "bearer", expiresIn: body.expires_in };
  }

  private async exchangeInstagram(code: string): Promise<InstagramIdentity> {
    if (this.testMode()) {
      if (code !== "originpost-oauth-test-code") throw new BadGatewayException("The test provider rejected this authorization code.");
      return { accessToken: "test-access-token-never-returned", externalAccountId: "test-instagram-oauth", displayName: "OAuth Test Instagram", expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60_000).toISOString(), accountType: "BUSINESS" };
    }
    const clientId = this.config.get<string>("META_APP_ID")!;
    const clientSecret = this.config.get<string>("META_APP_SECRET")!;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: this.callbackUrl(), code });
    const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
    const short = await shortResponse.json().catch(() => ({})) as { access_token?: string; user_id?: string | number };
    if (!shortResponse.ok || !short.access_token) throw new BadGatewayException("Instagram could not exchange the authorization code.");
    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token"); longUrl.searchParams.set("client_secret", clientSecret); longUrl.searchParams.set("access_token", short.access_token);
    const longResponse = await fetch(longUrl, { signal: AbortSignal.timeout(15_000) });
    const long = await longResponse.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
    if (!longResponse.ok || !long.access_token) throw new BadGatewayException("Instagram could not create long-lived access.");
    const profileUrl = new URL("https://graph.instagram.com/me");
    profileUrl.searchParams.set("fields", "user_id,username,account_type"); profileUrl.searchParams.set("access_token", long.access_token);
    const profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(15_000) });
    const profile = await profileResponse.json().catch(() => ({})) as { user_id?: string; id?: string; username?: string; account_type?: string };
    const externalAccountId = profile.user_id ?? profile.id ?? String(short.user_id ?? "");
    if (!profileResponse.ok || !externalAccountId || (profile.account_type !== "BUSINESS" && profile.account_type !== "MEDIA_CREATOR")) throw new BadGatewayException("Instagram could not confirm the connected professional account type.");
    return { accessToken: long.access_token, externalAccountId, displayName: profile.username ? `@${profile.username}` : `Instagram ${externalAccountId}`, expiresAt: new Date(Date.now() + Math.max(60, long.expires_in ?? 5_184_000) * 1000).toISOString(), accountType: profile.account_type };
  }

  private async exchangeYouTube(code: string): Promise<YouTubeIdentity> {
    if (this.testMode()) {
      if (code !== "originpost-youtube-oauth-test-code") throw new BadGatewayException("The test provider rejected this YouTube authorization code.");
      return {
        accessToken: "test-youtube-access-token-never-returned",
        refreshToken: "test-youtube-refresh-token-never-returned",
        externalAccountId: "test-youtube-channel",
        displayName: "OAuth Test YouTube",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
      };
    }
    const body = new URLSearchParams({
      client_id: this.config.get<string>("GOOGLE_CLIENT_ID")!,
      client_secret: this.config.get<string>("GOOGLE_CLIENT_SECRET")!,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.youtubeCallbackUrl(),
    });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
    const token = await tokenResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number; scope?: string };
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token || !token.expires_in) throw new BadGatewayException("YouTube could not create scheduled access. Reconnect and approve offline access.");
    const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000) });
    const channelBody = await channelResponse.json().catch(() => ({})) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
    const channel = channelBody.items?.[0];
    if (!channelResponse.ok || !channel?.id) throw new BadGatewayException("YouTube could not read a channel for this Google account.");
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      externalAccountId: channel.id,
      displayName: channel.snippet?.title ?? `YouTube ${channel.id}`,
      expiresAt: new Date(Date.now() + Math.max(60, token.expires_in) * 1000).toISOString(),
      scope: token.scope ?? "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
    };
  }
}
