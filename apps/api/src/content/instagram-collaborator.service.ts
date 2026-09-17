import { Inject, Injectable } from "@nestjs/common";
import type { InstagramCollaboratorCapability, InstagramCollaboratorCandidate, InstagramPublishSettings } from "@originpost/domain";
import { approveInstagramPublishSettings, assertInstagramReelCoverForDraft, can, DomainError, instagramCollaboratorCapability, normalizeInstagramPublisherUsername, recordInstagramCollaboratorApproval, type Actor, type InstagramReelCoverSelection, type MediaAsset } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";

type CollaboratorIdentity = { capability: InstagramCollaboratorCapability; publishingUsername?: string };
type CollaboratorConnector = { getCollaboratorIdentity(input:{workspaceId:string;accountId:string}):Promise<CollaboratorIdentity> };

function mockPublisherUsername(displayName:string,externalAccountId:string,accountId:string){
  try{return normalizeInstagramPublisherUsername(displayName);}catch{}
  const source=(externalAccountId||accountId).normalize("NFC").trim().toLowerCase().replace(/[^a-z0-9._]+/gu,"_").replace(/^\.+|\.+$/gu,"").replace(/\.{2,}/gu,".").slice(0,30)||"originpost_mock";
  return normalizeInstagramPublisherUsername(source);
}

@Injectable()
export class InstagramCollaboratorService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure:OriginPostInfrastructure){}
  private async lineage(workspaceId:string,contentItemId:string,draftId:string,accountId:string){const item=await this.infrastructure.repository.get(workspaceId,contentItemId);if(!item)throw new DomainError("Content item not found.","not_found",404);const draft=item.drafts.find((entry)=>entry.id===draftId&&entry.platform==="instagram");if(!draft)throw new DomainError("Instagram draft not found.","draft_not_found",404);const account=await this.infrastructure.connectedAccountRepository.get(workspaceId,accountId);if(!account||account.platform!=="instagram")throw new DomainError("Instagram account not found.","connected_account_required",404);if(account.brandId!==item.brandId)throw new DomainError("This Instagram account belongs to another brand.","connected_account_brand_mismatch",409);return{item,draft,account};}
  private async identity(workspaceId:string,account:{id:string;displayName:string;externalAccountId:string}){
    const connector=this.infrastructure.connectors.get("instagram");
    if(connector.manifest.apiMode==="mock")return{publishingUsername:mockPublisherUsername(account.displayName,account.externalAccountId,account.id),capability:instagramCollaboratorCapability({connectionMode:"facebook_login",scopes:["instagram_basic","instagram_content_publish","pages_read_engagement"],endpointFamily:"instagram_api_with_facebook_login",endpointProbe:{state:"verified",apiVersion:"mock-v1"}})};
    const candidate=connector as typeof connector&Partial<CollaboratorConnector>;
    const identity=typeof candidate.getCollaboratorIdentity==="function"?await candidate.getCollaboratorIdentity({workspaceId,accountId:account.id}):{capability:instagramCollaboratorCapability(undefined)};
    if(!identity.publishingUsername)throw new DomainError("The connected Instagram account has no verified publisher username. Reconnect it.","instagram_collaborator_publisher_identity_unavailable",409);
    return{capability:identity.capability,publishingUsername:normalizeInstagramPublisherUsername(identity.publishingUsername)};
  }
  async capability(workspaceId:string,contentItemId:string,draftId:string,accountId:string){const {account}=await this.lineage(workspaceId,contentItemId,draftId,accountId);const identity=await this.identity(workspaceId,account);return{accountId:account.id,...identity};}
  private async coverForSettings(workspaceId:string,brandId:string,draft:{format:string;mediaIds:string[]},input:Record<string,unknown>|undefined):Promise<InstagramReelCoverSelection|undefined>{
    if(input===undefined)return undefined;
    if(input.mode==="custom_image"){
      if(typeof input.mediaId!=="string"||Object.keys(input).some((key)=>!["mode","mediaId"].includes(key)))throw new DomainError("Choose one Library image for the Reel cover.","instagram_reel_cover_invalid",409);
      const asset=await this.infrastructure.mediaRepository.get(workspaceId,input.mediaId);
      this.assertCoverAsset(asset,brandId);
      return{mode:"custom_image",mediaId:asset!.id,mediaSha256:asset!.sha256};
    }
    const cover=input.mode==="video_frame"?{mode:"video_frame",offsetMs:input.offsetMs}:input.mode==="instagram_default"?{mode:"instagram_default"}:input;
    const video=draft.mediaIds.length===1?await this.infrastructure.mediaRepository.get(workspaceId,draft.mediaIds[0]!):null;
    assertInstagramReelCoverForDraft(cover as InstagramReelCoverSelection,draft.format as never,video?.durationMs,true);
    return cover as InstagramReelCoverSelection;
  }
  private assertCoverAsset(asset:MediaAsset|null,brandId:string):asserts asset is MediaAsset{if(!asset||asset.brandId!==brandId||asset.status!=="ready"||asset.kind!=="image"||asset.inspectionStatus!=="ready"||(asset.rights!=="owned"&&asset.rights!=="cleared"))throw new DomainError("Choose a ready, inspected cover image owned or cleared by this brand.","instagram_reel_cover_asset_unavailable",409);}
  async createCandidate(workspaceId:string,contentItemId:string,input:{draftId:string;accountId:string;collaborators:string[];shareToFeed?:boolean;reelCover?:Record<string,unknown>;isAiGenerated?:boolean},actor:Actor){if(!can(actor.role,"content:edit"))throw new DomainError("This role cannot prepare Instagram publishing settings.","permission_denied",403);const {item,draft,account}=await this.lineage(workspaceId,contentItemId,input.draftId,input.accountId);const identity=await this.identity(workspaceId,account);if(input.collaborators.length&&identity.capability.state!=="supported")throw new DomainError("This Instagram connection cannot publish collaborator invitations.","instagram_collaborators_connection_unsupported",409);const reelCover=await this.coverForSettings(workspaceId,item.brandId,draft,input.reelCover);const settings=approveInstagramPublishSettings({collaborators:input.collaborators,shareToFeed:input.shareToFeed,reelCover,isAiGenerated:input.isAiGenerated},identity.publishingUsername);assertInstagramReelCoverForDraft(settings.reelCover,draft.format,(draft.mediaIds.length===1?(await this.infrastructure.mediaRepository.get(workspaceId,draft.mediaIds[0]!))?.durationMs:undefined),Boolean(settings.reelCover?.mode==="video_frame"));const now=new Date().toISOString();const candidate:InstagramCollaboratorCandidate={id:`instagram_collab_candidate_${crypto.randomUUID()}`,workspaceId,brandId:item.brandId,contentItemId,draftId:draft.id,draftSha256:draft.contentSha256,accountId:input.accountId,publishingUsername:identity.publishingUsername,settings,status:"pending_approval",requestedBy:actor.id,requestedAt:now};return this.infrastructure.instagramCollaboratorRepository.createCandidate(candidate);}
  async approve(workspaceId:string,contentItemId:string,candidateId:string,note:string|undefined,actor:Actor){if(actor.id==="originpost-agent"||actor.id==="originpost-worker")throw new DomainError("A human must approve Instagram publishing settings.","human_approval_required",403);const candidate=await this.infrastructure.instagramCollaboratorRepository.getCandidate(workspaceId,contentItemId,candidateId);if(!candidate)throw new DomainError("Instagram settings candidate not found.","instagram_collaborator_candidate_not_found",404);if(candidate.status==="approved")return candidate;const current=await this.lineage(workspaceId,contentItemId,candidate.draftId,candidate.accountId);const identity=await this.identity(workspaceId,current.account);if((candidate.settings.collaborators.length&&identity.capability.state!=="supported")||current.draft.contentSha256!==candidate.draftSha256||identity.publishingUsername!==candidate.publishingUsername)throw new DomainError("The draft or publishing account changed. Create a new Instagram settings candidate.","instagram_collaborator_candidate_stale",409);if(candidate.settings.reelCover?.mode==="custom_image")this.assertCoverAsset(await this.infrastructure.mediaRepository.get(workspaceId,candidate.settings.reelCover.mediaId),current.item.brandId);if(candidate.settings.reelCover?.mode==="video_frame"){const video=current.draft.mediaIds.length===1?await this.infrastructure.mediaRepository.get(workspaceId,current.draft.mediaIds[0]!):null;assertInstagramReelCoverForDraft(candidate.settings.reelCover,current.draft.format,video?.durationMs,true);}let approval=current.item.approvals.find((entry)=>entry.instagramPublishApprovalBinding?.accountId===candidate.accountId&&entry.instagramPublishApprovalBinding.draftSha256===candidate.draftSha256&&entry.instagramPublishApprovalBinding.approvedSettingsSha256===candidate.settings.approvedSettingsSha256);
    if(!approval){const result=recordInstagramCollaboratorApproval(current.item,actor,{draftId:candidate.draftId,accountId:candidate.accountId,settings:candidate.settings,...(note?{note}:{})});return this.infrastructure.instagramCollaboratorRepository.commitCandidateApproval(workspaceId,contentItemId,candidateId,{...result,event:{...result.event,actorType:"human"}});}
    return this.infrastructure.instagramCollaboratorRepository.approveCandidate(workspaceId,contentItemId,candidateId,{id:approval.id,actorId:approval.actorId,createdAt:approval.createdAt});}
  list(workspaceId:string,contentItemId:string){return this.infrastructure.instagramCollaboratorRepository.listCandidates(workspaceId,contentItemId);}
  async status(workspaceId:string,contentItemId:string,proofId:string){
    const {poll,snapshots}=await this.infrastructure.instagramCollaboratorRepository.getStatus(workspaceId,contentItemId,proofId);
    if(!poll)return{trackingStatus:"not_started",providerReadComplete:false,availability:"not_fetched",snapshots:[]};
    return{
      trackingStatus:poll.status,
      providerReadComplete:poll.latestReadComplete===true,
      availability:poll.availability??"not_fetched",
      inviteProof:poll.inviteProof,
      snapshots,
      ...(poll.capturedAt?{capturedAt:poll.capturedAt}:{}),
      ...(poll.rawResponseSha256?{rawResponseSha256:poll.rawResponseSha256}:{}),
      ...(poll.errorSummary?{error:{message:poll.errorSummary}}:{}),
      ...(["pending","processing","unavailable"].includes(poll.status)?{retry:{recommended:true,nextAttemptAt:poll.nextAttemptAt}}:{retry:{recommended:false}}),
    };
  }
  async approvedSettings(workspaceId:string,contentItemId:string,approvalId:string,accountId:string,draftId:string):Promise<InstagramPublishSettings>{const candidate=await this.infrastructure.instagramCollaboratorRepository.getApprovedCandidate(workspaceId,contentItemId,approvalId);if(!candidate||candidate.accountId!==accountId||candidate.draftId!==draftId)throw new DomainError("The approved collaborator binding does not match this target.","instagram_collaborator_approval_required",409);return candidate.settings;}
}
