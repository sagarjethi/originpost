import { describe, expect, it } from "vitest";
import {
  addDraft,
  addSource,
  approveInstagramPublishSettings,
  assertApprovedInstagramPublishSettings,
  confirmManualPublication,
  createContentItem,
  recordApproval,
  recordInstagramCollaboratorApproval,
  acknowledgeManualHandoff,
  markTargetStatus,
  scheduleTarget,
  type Actor,
  type ContentItem,
} from "../src/index.js";

const owner: Actor = { id:"owner-ai", name:"Owner", role:"owner" };

function approvedStory(isAiGenerated:boolean):{item:ContentItem;targetId:string}{
  let {item}=createContentItem({workspaceId:"workspace-ai",title:"AI-labelled Story",actor:owner});
  ({item}=addSource(item,{kind:"url",title:"Official source",url:"https://example.com/source",rights:"reference-only",confidence:100},owner));
  ({item}=addDraft(item,{platform:"instagram",format:"story",title:"Story",caption:"Internal review copy",mediaIds:["story-image"]},owner));
  const draft=item.drafts.at(-1)!;
  ({item}=recordApproval(item,owner,"approved","Checked",draft.id));
  const settings=approveInstagramPublishSettings({collaborators:[],isAiGenerated});
  ({item}=recordInstagramCollaboratorApproval(item,owner,{draftId:draft.id,accountId:"instagram-ai",settings}));
  const scheduled=scheduleTarget(item,owner,{platform:"instagram",accountId:"instagram-ai",draftId:draft.id,scheduledFor:"2026-09-02T12:00:00.000Z",deliveryMode:"manual_handoff",settings},"2026-09-01T12:00:00.000Z");
  const targetId=scheduled.item.targets.at(-1)!.id;
  const due=markTargetStatus(scheduled.item,targetId,"action_required",owner,{reason:"manual_handoff_due"},"2026-09-02T12:00:00.000Z");
  const acknowledged=acknowledgeManualHandoff(due.item,targetId,owner,"2026-09-02T12:01:00.000Z");
  return{item:acknowledged.item,targetId};
}

describe("Instagram native AI disclosure",()=>{
  it("binds true and false decisions to different immutable settings hashes",()=>{
    const enabled=approveInstagramPublishSettings({collaborators:[],isAiGenerated:true});
    const disabled=approveInstagramPublishSettings({collaborators:[],isAiGenerated:false});
    expect(enabled.approvedSettingsSha256).not.toBe(disabled.approvedSettingsSha256);
    expect(()=>assertApprovedInstagramPublishSettings({...enabled,isAiGenerated:false})).toThrow(/changed after approval/i);
  });

  it("requires exact human approval before scheduling a labelled Story",()=>{
    let {item}=createContentItem({workspaceId:"workspace-ai",title:"Approval",actor:owner});
    ({item}=addSource(item,{kind:"url",title:"Source",url:"https://example.com/source",rights:"reference-only",confidence:100},owner));
    ({item}=addDraft(item,{platform:"instagram",format:"story",title:"Story",caption:"Internal",mediaIds:["story-image"]},owner));
    const draft=item.drafts.at(-1)!;
    ({item}=recordApproval(item,owner,"approved","Checked",draft.id));
    const settings=approveInstagramPublishSettings({collaborators:[],isAiGenerated:true});
    expect(()=>scheduleTarget(item,owner,{platform:"instagram",accountId:"instagram-ai",draftId:draft.id,scheduledFor:"2026-09-02T12:00:00.000Z",settings},"2026-09-01T12:00:00.000Z")).toThrow(/human must approve/i);
  });

  it("records requested and observed separately and rejects mismatched manual attestation",()=>{
    const {item,targetId}=approvedStory(true);
    const input={externalPostId:"story-123",liveUrl:"https://www.instagram.com/stories/samplepublisher/story-123/",publishedAt:"2026-09-02T12:00:00.000Z",mediaSha256:["a".repeat(64)]};
    expect(()=>confirmManualPublication(item,targetId,{...input,disclosure:"none"},owner)).toThrow(/must match/i);
    const confirmed=confirmManualPublication(item,targetId,{...input,disclosure:"ai-assisted"},owner);
    expect(confirmed.item.proofs.at(-1)).toMatchObject({disclosure:"ai-assisted",instagramAiDisclosure:{requested:true,observed:true,label:"ai_info"}});
  });
});
