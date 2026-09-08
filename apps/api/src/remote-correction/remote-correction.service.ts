import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { advanceRemoteCorrectionOperation, approveRemoteCorrectionRequest, canonicalSha256, createRemoteCorrectionRequest, operatorAttestationObservationSha256, type Actor, type AuditEvent, type OutboxMessageInput, type PublishProof, type RemoteCorrectionMutation, type RemoteCorrectionOperation } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { ApproveRemoteCorrectionDto, CreateRemoteCorrectionDto, ManualAttestationDto } from "./remote-correction.dto.js";

@Injectable()
export class RemoteCorrectionService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,private readonly config:ConfigService) {}

  async capabilities(workspaceId:string,contentItemId:string,publishProofId:string,_actor:Actor) {
    const { proof } = await this.lineage(workspaceId,contentItemId,publishProofId);
    const capabilities = await this.infrastructure.connectors.getRemoteCorrection(proof.platform).correctionCapabilities({workspaceId,accountId:proof.accountId,platform:proof.platform});
    return {data:{lineage:this.proofLineage(proof),capabilities}};
  }

  async create(workspaceId:string,contentItemId:string,dto:CreateRemoteCorrectionDto,actor:Actor) {
    this.requireHuman(actor); if(actor.role==="viewer") throw new ForbiddenException("Viewers cannot request remote corrections.");
    const {item,proof}=await this.lineage(workspaceId,contentItemId,dto.publishProofId);
    const now=new Date().toISOString();
    const operation=createRemoteCorrectionRequest({id:`correction_${randomUUID()}`,workspaceId,brandId:item.brandId,publishProof:proof,mutation:this.mutation(dto),reason:dto.reason,requestedBy:actor.id,requestedAt:now});
    const created=await this.infrastructure.remoteCorrectionRepository.create(operation,this.audit(operation,actor,"remote_correction.requested",now,{publishProofId:proof.id}));
    if(!created) throw new ConflictException("An identical correction request already exists.");
    return {data:{operation},meta:{accepted:false,approvalRequired:true}};
  }

  async approve(workspaceId:string,contentItemId:string,operationId:string,dto:ApproveRemoteCorrectionDto,actor:Actor) {
    this.requireApprover(actor); const record=await this.record(workspaceId,contentItemId,operationId); const pending=record.operation;
    if(pending.status!=="pending_approval") throw new ConflictException("This correction is not awaiting approval.");
    const {proof}=await this.lineage(workspaceId,contentItemId,pending.publishProofId);
    if(canonicalSha256({schemaVersion:"originpost.publish-proof.v1",value:proof})!==pending.publishProofSha256) throw new ConflictException("The publication proof changed after the request was created.");
    const authority=await this.approvalAuthority(workspaceId,actor);
    let mode:"two_person"|"single_owner_override"="two_person"; const now=new Date().toISOString();
    if(pending.requestedBy===actor.id){
      if(actor.role!=="owner"||!authority.soleOwner||!dto.singleOwnerOverride||!dto.secondConfirmation) throw new ForbiddenException("Self-approval is allowed only for the sole owner with the explicit second confirmation.");
      mode="single_owner_override";
    }
    const connector=this.infrastructure.connectors.getRemoteCorrection(pending.platform);
    const target={workspaceId,brandId:pending.brandId,...this.proofLineage(proof),mutation:pending.mutation};
    const before=await (pending.mutation.action==="manual_remove"?connector.preflightManualCorrection(target):connector.preflightCorrection(target));
    let approved=approveRemoteCorrectionRequest({operation:pending,approval:{actorId:actor.id,actorType:"human",approvedAt:now,mode,...(mode==="single_owner_override"?{secondConfirmedAt:now}:{})},beforeSnapshot:before});
    const outbox:OutboxMessageInput[]=[];
    if(approved.mutation.action==="manual_remove") approved=advanceRemoteCorrectionOperation(approved,"manual_action_required",now,"Provider deletion is unavailable; complete the action in the named provider console and attest evidence.");
    else outbox.push(this.outbox(approved,now));
    const saved=await this.infrastructure.remoteCorrectionRepository.compareAndSet(approved,["pending_approval"],this.audit(approved,actor,"remote_correction.approved",now,{approvalMode:mode,approverId:actor.id}),outbox);
    if(!saved) throw new ConflictException("The correction changed before approval completed.");
    if(approved.status==="manual_action_required") await this.notify(approved,"Remote correction requires a manual provider action.","warning",now);
    return {data:{operation:approved},meta:{accepted:approved.status!=="manual_action_required",manualHandoff:approved.status==="manual_action_required"}};
  }

  async list(workspaceId:string,contentItemId:string,publishProofId:string|undefined,_actor:Actor){await this.item(workspaceId,contentItemId);return {data:await this.infrastructure.remoteCorrectionRepository.list(workspaceId,{contentItemId,...(publishProofId?{publishProofId}:{})})};}
  async get(workspaceId:string,contentItemId:string,operationId:string,_actor:Actor){return {data:await this.record(workspaceId,contentItemId,operationId)};}

  async reconcile(workspaceId:string,contentItemId:string,operationId:string,actor:Actor){
    this.requireApprover(actor); const record=await this.record(workspaceId,contentItemId,operationId); if(record.operation.status!=="uncertain"&&record.operation.status!=="finalizing") throw new ConflictException("Only an uncertain or finalizing correction can be reconciled.");
    const now=new Date().toISOString(); const message=this.outbox(record.operation,now,"reconcile");
    const saved=await this.infrastructure.remoteCorrectionRepository.compareAndSet(record.operation,[record.operation.status],this.audit(record.operation,actor,"remote_correction.reconciliation_requested",now,{}),[message]);
    if(!saved) throw new ConflictException("The correction changed before reconciliation was queued.");
    return {data:{operation:record.operation},meta:{accepted:true,reconciliationOnly:true}};
  }

  async attest(workspaceId:string,contentItemId:string,operationId:string,dto:ManualAttestationDto,actor:Actor){
    this.requireApprover(actor); const record=await this.record(workspaceId,contentItemId,operationId); const now=new Date().toISOString();
    if(Date.parse(dto.occurredAt)>Date.parse(now)+60_000) throw new BadRequestException("Attestation time cannot be in the future.");
    const noteSha256=canonicalSha256({schemaVersion:"originpost.operator-attestation-note.v1",note:dto.note.normalize("NFC").trim()});
    const operatorEvidence={actorId:actor.id,occurredAt:dto.occurredAt,evidenceRef:dto.evidenceUrl,target:record.operation.externalPostId,noteSha256};
    const evidence={grade:"operator_attested" as const,afterObservationSha256:operatorAttestationObservationSha256(operatorEvidence),observedAt:now,...operatorEvidence};
    const result=await this.infrastructure.remoteCorrectionRepository.resolveWithProof({workspaceId,operationId,expected:["manual_action_required"],proofId:`removal_${randomUUID()}`,evidence,resolvedAt:now},this.audit(record.operation,actor,"remote_correction.operator_attested",now,{evidenceUrl:dto.evidenceUrl,target:record.operation.externalPostId}));
    if(!result) throw new ConflictException("The manual correction was already completed or changed.");
    await this.notify(result.operation,"Manual correction evidence was recorded. Provider deletion was not independently confirmed.","info",now);
    return {data:result};
  }

  private requireHuman(actor:Actor){if(actor.actorType&&actor.actorType!=="human")throw new ForbiddenException("Remote correction requires an authenticated human.");}
  private requireApprover(actor:Actor){this.requireHuman(actor);if(actor.role!=="owner"&&actor.role!=="manager")throw new ForbiddenException("Only a manager or owner can approve or attest a remote correction.");}
  private async approvalAuthority(workspaceId:string,actor:Actor):Promise<{soleOwner:boolean}>{
    if(this.config.get<string>("AUTH_MODE")!=="sessions"){
      const localOwnerId=this.config.get<string>("BOOTSTRAP_USER_ID")??"local-owner";
      if(actor.id!==localOwnerId||actor.role!=="owner")throw new ForbiddenException("Only the trusted local owner can approve in single-user mode.");
      return{soleOwner:true};
    }
    const members=(await this.infrastructure.authRepository.listWorkspaceMembers(workspaceId)).filter((member)=>member.status==="active"&&(member.role==="owner"||member.role==="manager"));
    const current=members.find((member)=>member.userId===actor.id);
    if(!current||current.role!==actor.role)throw new ForbiddenException("An active workspace owner or manager membership is required to approve.");
    return{soleOwner:members.length===1&&current.role==="owner"};
  }
  private mutation(dto:CreateRemoteCorrectionDto):RemoteCorrectionMutation{if(dto.action==="restore_visibility"){if(!dto.visibility)throw new BadRequestException("visibility is required for restore_visibility.");return{action:dto.action,visibility:dto.visibility};}if(dto.visibility)throw new BadRequestException("visibility is valid only for restore_visibility.");return{action:dto.action};}
  private async item(workspaceId:string,id:string){const item=await this.infrastructure.repository.get(workspaceId,id);if(!item)throw new NotFoundException("Content item not found.");return item;}
  private async lineage(workspaceId:string,contentItemId:string,publishProofId:string){const item=await this.item(workspaceId,contentItemId);const proof=item.proofs.find((entry)=>entry.id===publishProofId);if(!proof)throw new NotFoundException("Publication proof not found for this content item.");const account=await this.infrastructure.connectedAccountRepository.get(workspaceId,proof.accountId);if(!account||account.brandId!==item.brandId||account.platform!==proof.platform)throw new ConflictException("Publication proof no longer matches its workspace, brand, platform, and connected account.");return{item,proof,account};}
  private async record(workspaceId:string,contentItemId:string,operationId:string){const value=await this.infrastructure.remoteCorrectionRepository.get(workspaceId,operationId);if(!value||value.operation.contentItemId!==contentItemId)throw new NotFoundException("Remote correction not found.");return value;}
  private proofLineage(proof:PublishProof){return{publishProofId:proof.id,contentItemId:proof.contentItemId,draftId:proof.draftId,draftSha256:proof.draftSha256,platform:proof.platform,accountId:proof.accountId,externalPostId:proof.externalPostId};}
  private audit(operation:RemoteCorrectionOperation,actor:Actor,action:string,createdAt:string,detail:Record<string,unknown>):AuditEvent{return{id:`audit_${randomUUID()}`,workspaceId:operation.workspaceId,contentItemId:operation.contentItemId,actorId:actor.id,actorType:actor.actorType??"human",action,detail:{operationId:operation.id,immutableIntentSha256:operation.immutableIntentSha256,...detail},createdAt};}
  private outbox(operation:RemoteCorrectionOperation,now:string,mode:"execute"|"reconcile"="execute"):OutboxMessageInput{return{id:`outbox_${randomUUID()}`,workspaceId:operation.workspaceId,topic:"remote-correction.requested",dedupeKey:`remote-correction:${operation.id}:${mode}`,payload:{workspaceId:operation.workspaceId,contentItemId:operation.contentItemId,operationId:operation.id,mode},availableAt:now,createdAt:now};}
  private async notify(operation:RemoteCorrectionOperation,body:string,severity:"info"|"warning"|"error",now:string){await this.infrastructure.notificationRepository.create({id:`notification_${randomUUID()}`,workspaceId:operation.workspaceId,kind:"action_required",severity,title:"Remote correction",body,contentItemId:operation.contentItemId,accountId:operation.accountId,targetId:operation.id,actionUrl:`/content/${operation.contentItemId}`,dedupeKey:`remote-correction:${operation.id}:${operation.status}`,createdAt:now});}
}
