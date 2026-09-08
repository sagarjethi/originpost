import { describe, expect, it, vi } from "vitest";
import { ConnectorRegistry, MockYouTubeConnector } from "@originpost/connectors";
import { InMemoryRemoteCorrectionRepository } from "@originpost/db";
import { InMemoryContentItemRepository, InMemoryNotificationRepository, InMemoryOutboxRepository, advanceRemoteCorrectionOperation, approveRemoteCorrectionRequest, canonicalSha256, createRemoteCorrectionRequest, type AuditEvent, type PublishProof } from "@originpost/domain";
import { processRemoteCorrectionJob } from "../src/remote-correction-worker.js";

const now = "2026-08-29T06:00:00.000Z";
const proof: PublishProof = { id:"proof-1",contentItemId:"content-1",draftId:"draft-1",draftSha256:canonicalSha256("draft"),platform:"youtube",accountId:"account-1",externalPostId:"video-1",liveUrl:"https://youtube.com/shorts/video-1",publishedAt:now,captionSha256:canonicalSha256("caption"),mediaSha256:[canonicalSha256("media")],connectorResponseSha256:canonicalSha256("response"),approvedBy:"editor",sourceIds:["source"],disclosure:"none" };
const event = (id:string,action:string): AuditEvent => ({ id,workspaceId:"workspace-1",contentItemId:"content-1",actorId:"system",actorType:"system",action,detail:{},createdAt:now });

async function setup() {
  const connector = new MockYouTubeConnector();
  const target = { workspaceId:"workspace-1",brandId:"brand-1",publishProofId:proof.id,contentItemId:proof.contentItemId,draftId:proof.draftId,draftSha256:proof.draftSha256,platform:proof.platform,accountId:proof.accountId,externalPostId:proof.externalPostId,mutation:{action:"make_private" as const} };
  const before = await connector.preflightCorrection(target);
  const request = createRemoteCorrectionRequest({ id:"operation-1",workspaceId:"workspace-1",brandId:"brand-1",publishProof:proof,mutation:target.mutation,reason:"Published visibility is incorrect.",requestedBy:"manager",requestedAt:now });
  const operation = approveRemoteCorrectionRequest({ operation:request,approval:{actorId:"owner",actorType:"human",approvedAt:"2026-08-29T06:01:00.000Z"},beforeSnapshot:before });
  const corrections = new InMemoryRemoteCorrectionRepository(new InMemoryOutboxRepository());
  await corrections.create(operation,event("audit-1","approved"));
  const registry = new ConnectorRegistry(); registry.register(connector);
  return { connector,corrections,registry,notifications:new InMemoryNotificationRepository(),repository:new InMemoryContentItemRepository() };
}

describe("remote correction worker", () => {
  it("claims, writes once, verifies, and records provider-confirmed proof", async () => {
    const deps=await setup(); const execute=vi.spyOn(deps.connector,"executeCorrection");
    vi.useFakeTimers();vi.setSystemTime("2026-08-29T06:02:00.000Z");
    try{await processRemoteCorrectionJob({workspaceId:"workspace-1",contentItemId:"content-1",operationId:"operation-1"},{repository:deps.repository,corrections:deps.corrections,connectors:deps.registry,notifications:deps.notifications,now:()=>"2026-08-29T06:02:00.000Z"});}finally{vi.useRealTimers();}
    const record=await deps.corrections.get("workspace-1","operation-1");
    expect(execute).toHaveBeenCalledTimes(1); expect(record?.operation.status).toBe("provider_confirmed"); expect(record?.proofs[0]?.evidenceGrade).toBe("provider_confirmed");
  });

  it("never repeats a finalizing mutation and performs reconciliation only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-29T06:02:00.000Z");
    try {
      const deps=await setup(); const approved=(await deps.corrections.get("workspace-1","operation-1"))!.operation;
      const pre=advanceRemoteCorrectionOperation(approved,"pre_write","2026-08-29T06:02:00.000Z"); await deps.corrections.compareAndSet(pre,["approved"],event("a2","pre"));
      const final=advanceRemoteCorrectionOperation(pre,"finalizing","2026-08-29T06:03:00.000Z"); await deps.corrections.compareAndSet(final,["pre_write"],event("a3","final"));
      const execute=vi.spyOn(deps.connector,"executeCorrection"), reconcile=vi.spyOn(deps.connector,"reconcileCorrection");
      vi.setSystemTime("2026-08-29T06:10:00.000Z");
      await processRemoteCorrectionJob({workspaceId:"workspace-1",contentItemId:"content-1",operationId:"operation-1"},{repository:deps.repository,corrections:deps.corrections,connectors:deps.registry,notifications:deps.notifications,now:()=>"2026-08-29T06:10:00.000Z"});
      expect(execute).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledTimes(1); expect((await deps.corrections.get("workspace-1","operation-1"))?.operation.status).toBe("manual_action_required");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not transition or notify when an ambiguous result belongs to a stale claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-29T06:02:00.000Z");
    try {
      const deps=await setup();
      vi.spyOn(deps.connector,"executeCorrection").mockImplementation(async () => {
        vi.setSystemTime("2026-08-29T06:08:00.000Z");
        await deps.corrections.claim("workspace-1","operation-1","replacement-claim","reconcile","2026-08-29T06:08:00.000Z","2026-08-29T06:13:00.000Z");
        return {kind:"uncertain",reason:"The provider response was ambiguous."};
      });
      await processRemoteCorrectionJob(
        {workspaceId:"workspace-1",contentItemId:"content-1",operationId:"operation-1"},
        {repository:deps.repository,corrections:deps.corrections,connectors:deps.registry,notifications:deps.notifications,now:()=>new Date().toISOString()},
      );
      expect((await deps.corrections.get("workspace-1","operation-1"))?.operation.status).toBe("finalizing");
      await expect(deps.notifications.list("workspace-1")).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
