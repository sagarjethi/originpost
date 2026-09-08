import { ConfigService } from "@nestjs/config";
import { ConnectorRegistry, MockYouTubeConnector } from "@originpost/connectors";
import { InMemoryRemoteCorrectionRepository } from "@originpost/db";
import { InMemoryNotificationRepository, InMemoryOutboxRepository, canonicalSha256, createRemoteCorrectionRequest, type AuditEvent, type PublishProof, type WorkspaceMember } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
import { RemoteCorrectionService } from "../src/remote-correction/remote-correction.service.js";

const requestedAt = "2026-08-29T06:00:00.000Z";
const proof: PublishProof = {
  id: "proof-1", contentItemId: "content-1", draftId: "draft-1", draftSha256: canonicalSha256("draft"),
  platform: "youtube", accountId: "account-1", externalPostId: "video-1", liveUrl: "https://youtube.com/shorts/video-1",
  publishedAt: requestedAt, captionSha256: canonicalSha256("caption"), mediaSha256: [canonicalSha256("media")],
  connectorResponseSha256: canonicalSha256("response"), approvedBy: "editor", sourceIds: ["source"], disclosure: "none",
};
const event: AuditEvent = { id:"audit-1", workspaceId:"default", contentItemId:"content-1", actorId:"local-owner", actorType:"human", action:"remote_correction.requested", detail:{}, createdAt:requestedAt };

async function fixture(authMode:"single-user"|"sessions",members:WorkspaceMember[]=[]){
  const corrections=new InMemoryRemoteCorrectionRepository(new InMemoryOutboxRepository());
  const operation=createRemoteCorrectionRequest({id:"operation-1",workspaceId:"default",brandId:"brand-1",publishProof:proof,mutation:{action:"make_private"},reason:"The published visibility is incorrect.",requestedBy:"local-owner",requestedAt});
  await corrections.create(operation,event);
  const connector=new MockYouTubeConnector(); const connectors=new ConnectorRegistry(); connectors.register(connector);
  const infrastructure={
    repository:{get:vi.fn(async()=>({id:"content-1",workspaceId:"default",brandId:"brand-1",proofs:[proof]}))},
    connectedAccountRepository:{get:vi.fn(async()=>({id:"account-1",workspaceId:"default",brandId:"brand-1",platform:"youtube"}))},
    authRepository:{listWorkspaceMembers:vi.fn(async()=>members)},
    remoteCorrectionRepository:corrections, connectors,
    notificationRepository:new InMemoryNotificationRepository(),
  } as unknown as OriginPostInfrastructure;
  const config=new ConfigService({AUTH_MODE:authMode,BOOTSTRAP_USER_ID:"local-owner"});
  const service=new (RemoteCorrectionService as unknown as new(infrastructure:OriginPostInfrastructure,config:ConfigService)=>RemoteCorrectionService)(infrastructure,config);
  return {service,corrections};
}

describe("RemoteCorrectionService approval authority",()=>{
  it("allows the trusted single-user owner to self-approve with both explicit confirmations",async()=>{
    const {service,corrections}=await fixture("single-user");
    await expect(service.approve("default","content-1","operation-1",{singleOwnerOverride:true,secondConfirmation:true},{id:"local-owner",name:"Local Owner",role:"owner"})).resolves.toMatchObject({data:{operation:{approval:{mode:"single_owner_override",actorId:"local-owner"}}}});
    await expect(corrections.get("default","operation-1")).resolves.toMatchObject({operation:{status:"approved"}});
  });

  it("rejects the single-user override when either explicit confirmation is missing",async()=>{
    const {service}=await fixture("single-user");
    await expect(service.approve("default","content-1","operation-1",{singleOwnerOverride:true},{id:"local-owner",name:"Local Owner",role:"owner"})).rejects.toThrow(/explicit second confirmation/i);
  });

  it.each([
    ["non-member",[]],
    ["disabled member",[{workspaceId:"default",workspaceName:"Default",workspaceSlug:"default",userId:"local-owner",displayName:"Local Owner",email:"owner@example.test",role:"owner",status:"disabled",createdAt:requestedAt,updatedAt:requestedAt}]],
  ] as const)("does not let a session-mode %s use the single-owner override",async(_label,members)=>{
    const {service}=await fixture("sessions",members as unknown as WorkspaceMember[]);
    await expect(service.approve("default","content-1","operation-1",{singleOwnerOverride:true,secondConfirmation:true},{id:"local-owner",name:"Local Owner",role:"owner"})).rejects.toThrow(/active workspace owner or manager membership/i);
  });
});
