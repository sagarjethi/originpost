import { randomUUID } from "node:crypto";
import { assertRemoteCorrectionObservation,assertRemoteCorrectionOutcome,type ConnectorRegistry, type RemoteContentSnapshot } from "@originpost/connectors";
import { advanceRemoteCorrectionOperation, canonicalSha256, type AuditEvent, type ContentItemRepository, type NotificationRepository, type RemoteCorrectionAttempt, type RemoteCorrectionOperation, type RemoteCorrectionRepository } from "@originpost/domain";

export interface RemoteCorrectionJob { workspaceId:string; contentItemId:string; operationId:string; mode?:"execute"|"reconcile" }
export interface RemoteCorrectionWorkerDependencies { repository:ContentItemRepository; corrections:RemoteCorrectionRepository; connectors:ConnectorRegistry; notifications:NotificationRepository; now?:()=>string }

export async function processRemoteCorrectionJob(job:RemoteCorrectionJob,deps:RemoteCorrectionWorkerDependencies):Promise<void>{
  const initial=await deps.corrections.get(job.workspaceId,job.operationId); if(!initial||initial.operation.contentItemId!==job.contentItemId)return;
  const reconcileOnly=job.mode==="reconcile"||initial.operation.status==="finalizing"||initial.operation.status==="uncertain";
  const kind=reconcileOnly?"reconcile":"execute"; const now=deps.now?.()??new Date().toISOString(); const claimId=`claim_${randomUUID()}`;
  const claimed=await deps.corrections.claim(job.workspaceId,job.operationId,claimId,kind,now,new Date(Date.parse(now)+300_000).toISOString()); if(!claimed)return;
  const attempt:RemoteCorrectionAttempt={id:`attempt_${randomUUID()}`,workspaceId:job.workspaceId,operationId:claimed.id,kind,status:"started",requestSha256:canonicalSha256({schemaVersion:"originpost.remote-correction-attempt.v1",operationId:claimed.id,intent:claimed.immutableIntentSha256,kind}),startedAt:now};
  await deps.corrections.saveAttempt(attempt);
  if(reconcileOnly){await reconcile(claimed,attempt,claimId,deps);return;}
  let prewrite=claimed;
  if(claimed.status==="approved"){
    prewrite=advanceRemoteCorrectionOperation(claimed,"pre_write",now);
    if(!await deps.corrections.compareAndSet(prewrite,["approved"],audit(prewrite,"remote_correction.pre_write",now),[],claimId))return;
  }
  const finalizing=advanceRemoteCorrectionOperation(prewrite,"finalizing",now);
  if(!await deps.corrections.compareAndSet(finalizing,["pre_write"],audit(finalizing,"remote_correction.finalizing",now),[],claimId))return;
  const before=finalizing.beforeSnapshot as RemoteContentSnapshot|undefined;
  if(!before){await ambiguous(finalizing,attempt,claimId,"Approved preflight evidence is missing.",deps);return;}
  try{
    const outcome=assertRemoteCorrectionOutcome(finalizing,await deps.connectors.getRemoteCorrection(finalizing.platform).executeCorrection({operation:finalizing,before}));
    const completedAt=deps.now?.()??new Date().toISOString();
    await deps.corrections.saveAttempt({...attempt,status:"completed",responseSha256:canonicalSha256({schemaVersion:"originpost.remote-correction-outcome.v1",outcome}),completedAt});
    if(outcome.kind==="provider_confirmed"){
      const evidence={grade:"provider_confirmed" as const,afterObservationSha256:outcome.after.canonicalSha256,providerReceiptSha256:outcome.receipt.responseSha256,occurredAt:outcome.receipt.occurredAt,observedAt:outcome.after.observedAt};
      const proofAt=latestIso(completedAt,evidence.occurredAt,evidence.observedAt); const result=await deps.corrections.resolveWithProof({workspaceId:finalizing.workspaceId,operationId:finalizing.id,expected:["finalizing"],claimId,proofId:`removal_${randomUUID()}`,evidence,resolvedAt:proofAt},audit(finalizing,"remote_correction.provider_confirmed",proofAt));
      if(result)await notify(result.operation,"Remote correction was confirmed by the provider and removal proof was recorded.","info",deps,proofAt); return;
    }
    if(outcome.kind==="manual_action_required"){const operation=advanceRemoteCorrectionOperation(finalizing,"manual_action_required",completedAt,outcome.reason);await deps.corrections.compareAndSet(operation,["finalizing"],audit(operation,"remote_correction.manual_action_required",completedAt),[],claimId);await notify(operation,outcome.reason,"warning",deps,completedAt);return;}
    if(outcome.kind==="rejected"){const operation=advanceRemoteCorrectionOperation(finalizing,"rejected",completedAt,outcome.reason);await deps.corrections.compareAndSet(operation,["finalizing"],audit(operation,"remote_correction.rejected",completedAt),[],claimId);await notify(operation,outcome.reason,"error",deps,completedAt);return;}
    await ambiguous(finalizing,attempt,claimId,outcome.reason,deps);
  }catch(error){await ambiguous(finalizing,attempt,claimId,error instanceof Error?error.message:"Provider result is unknown.",deps);}
}

async function reconcile(operation:RemoteCorrectionOperation,attempt:RemoteCorrectionAttempt,claimId:string,deps:RemoteCorrectionWorkerDependencies){
  const at=deps.now?.()??new Date().toISOString();
  try{
    const observation=assertRemoteCorrectionObservation(operation,await deps.connectors.getRemoteCorrection(operation.platform).reconcileCorrection({operation}));
    await deps.corrections.saveAttempt({...attempt,status:"completed",responseSha256:canonicalSha256({schemaVersion:"originpost.remote-correction-reconcile.v1",observation}),completedAt:at});
    if(observation.result==="matches_desired"||observation.result==="absence_consistent_with_removal"){
      const evidence={grade:"provider_reconciled" as const,afterObservationSha256:observation.snapshot.canonicalSha256,occurredAt:observation.snapshot.observedAt,observedAt:observation.snapshot.observedAt};
      const proofAt=latestIso(at,evidence.occurredAt,evidence.observedAt); const result=await deps.corrections.resolveWithProof({workspaceId:operation.workspaceId,operationId:operation.id,expected:[operation.status],claimId,proofId:`removal_${randomUUID()}`,evidence,resolvedAt:proofAt},audit(operation,"remote_correction.reconciled",proofAt)); if(result)await notify(result.operation,"Remote correction was verified by provider read-back and removal proof was recorded.","info",deps,proofAt);return;
    }
    const manual=advanceRemoteCorrectionOperation(operation,"manual_action_required",at,"Provider read-back did not prove the approved correction. No mutation was retried."); await deps.corrections.compareAndSet(manual,[operation.status],audit(manual,"remote_correction.reconciliation_inconclusive",at),[],claimId);await notify(manual,manual.statusReason!,"warning",deps,at);
  }catch(error){const manual=advanceRemoteCorrectionOperation(operation,"manual_action_required",at,"Provider reconciliation failed. No mutation was retried.");await deps.corrections.compareAndSet(manual,[operation.status],audit(manual,"remote_correction.reconciliation_failed",at,{error:bounded(error)}),[],claimId);await notify(manual,manual.statusReason!,"warning",deps,at);}
}

async function ambiguous(operation:RemoteCorrectionOperation,attempt:RemoteCorrectionAttempt,claimId:string,reason:string,deps:RemoteCorrectionWorkerDependencies){const at=deps.now?.()??new Date().toISOString();await deps.corrections.saveAttempt({...attempt,status:"failed",errorCode:"provider_result_uncertain",errorSummary:reason.slice(0,500),completedAt:at});const uncertain=advanceRemoteCorrectionOperation(operation,"uncertain",at,reason.slice(0,500));const changed=await deps.corrections.compareAndSet(uncertain,["finalizing"],audit(uncertain,"remote_correction.uncertain",at,{reason:reason.slice(0,500)}),[],claimId);if(changed)await notify(uncertain,"Provider result is uncertain. OriginPost will reconcile state and will not repeat the mutation blindly.","warning",deps,at);}
function audit(operation:RemoteCorrectionOperation,action:string,createdAt:string,detail:Record<string,unknown>={}):AuditEvent{return{id:`audit_${randomUUID()}`,workspaceId:operation.workspaceId,contentItemId:operation.contentItemId,actorId:"originpost-remote-correction-worker",actorType:"system",action,detail:{operationId:operation.id,immutableIntentSha256:operation.immutableIntentSha256,...detail},createdAt};}
async function notify(operation:RemoteCorrectionOperation,body:string,severity:"info"|"warning"|"error",deps:RemoteCorrectionWorkerDependencies,createdAt:string){await deps.notifications.create({id:`notification_${randomUUID()}`,workspaceId:operation.workspaceId,kind:operation.status==="provider_confirmed"||operation.status==="reconciled"?"system":"action_required",severity,title:"Remote correction",body,contentItemId:operation.contentItemId,accountId:operation.accountId,targetId:operation.id,actionUrl:`/content/${operation.contentItemId}`,dedupeKey:`remote-correction:${operation.id}:${operation.status}`,createdAt});}
function bounded(error:unknown){return(error instanceof Error?error.message:String(error)).slice(0,500);}
function latestIso(...values:string[]){return new Date(Math.max(...values.map((value)=>Date.parse(value)))).toISOString();}
