import { describe, expect, it } from "vitest";
import {
  addDraft,
  addSource,
  approveInstagramPublishSettings,
  assertApprovedInstagramPublishSettings,
  collaboratorInviteProof,
  createContentItem,
  instagramCollaboratorCapability,
  recordInstagramCollaboratorApproval,
  recordApproval,
  scheduleSchema,
  scheduleTarget,
  type Actor,
} from "../src/index.js";

const owner: Actor = { id: "owner-1", name: "Owner", role: "owner" };

describe("Instagram collaborator publishing domain", () => {
  it("normalizes at most three unique usernames and derives an immutable approval hash", () => {
    const parsed = scheduleSchema.parse({
      platform: "instagram",
      accountId: "instagram-1",
      draftId: "draft-1",
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings: { collaborators: [" @News.Room ", "COHOST", "cohost"] },
    });

    expect(parsed.settings?.collaborators).toEqual(["news.room", "cohost"]);
    expect(parsed.settings?.approvedSettingsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertApprovedInstagramPublishSettings({
      ...parsed.settings,
      collaborators: ["changed"],
    })).toThrow("changed after approval");
  });

  it("enforces the API creation limit, syntax, and self-invite rule", () => {
    expect(() => approveInstagramPublishSettings({ collaborators: ["one", "two", "three", "four"] })).toThrow("at most 3");
    expect(() => approveInstagramPublishSettings({ collaborators: ["bad handle"] })).toThrow("letters, numbers");
    expect(() => approveInstagramPublishSettings({ collaborators: ["publisher"] }, "@Publisher")).toThrow("cannot invite itself");
  });

  it("fails closed for existing Instagram Login accounts", () => {
    expect(instagramCollaboratorCapability(undefined)).toMatchObject({
      state: "unsupported",
      connectionMode: "instagram_login",
      reason: "facebook_login_required",
      maxCollaborators: 3,
    });
    expect(() => collaboratorInviteProof(
      approveInstagramPublishSettings({ collaborators: ["cohost"] }),
      "instagram_login",
    )).toThrow("Connect Instagram through Meta");
  });

  it("stores the exact settings hash on the target and scheduling audit", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Collaboration", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/collaboration", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "reel", title: "Collaboration", caption: "Checked", mediaIds: ["video-1"] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Checked", draft.id));
    const settings = approveInstagramPublishSettings({ collaborators: ["cohost"] });
    ({item}=recordInstagramCollaboratorApproval(item,owner,{draftId:draft.id,accountId:"instagram-1",settings}));
    const scheduled = scheduleTarget(item, owner, {
      platform: "instagram",
      accountId: "instagram-1",
      draftId: draft.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings,
    }, "2026-08-29T09:00:00.000Z");

    expect(scheduled.item.targets.at(-1)?.settings).toMatchObject(settings);
    expect(scheduled.item.targets.at(-1)?.settings).toMatchObject({approvalBinding:{platform:"instagram",accountId:"instagram-1",draftSha256:draft.contentSha256,approvedSettingsSha256:settings.approvedSettingsSha256}});
    expect(scheduled.event.detail).toMatchObject({
      collaborators: ["cohost"],
      approvedSettingsSha256: settings.approvedSettingsSha256,
    });
  });

  it("requires a human approval for the exact collaborators, draft, and account",()=>{
    let {item}=createContentItem({workspaceId:"ws-1",title:"Exact approval",actor:owner});
    ({item}=addSource(item,{kind:"url",title:"Source",url:"https://example.com/exact",rights:"reference-only",confidence:95},owner));
    ({item}=addDraft(item,{platform:"instagram",format:"reel",title:"Exact",caption:"Checked",mediaIds:["video-1"]},owner));
    const draft=item.drafts.at(-1)!;
    ({item}=recordApproval(item,owner,"approved","Draft approved",draft.id));
    const settings=approveInstagramPublishSettings({collaborators:["cohost"]});
    const schedule=(accountId:string,value=settings)=>scheduleTarget(item,owner,{platform:"instagram",accountId,draftId:draft.id,scheduledFor:"2026-09-01T09:00:00.000Z",settings:value},"2026-08-29T09:00:00.000Z");
    expect(()=>schedule("instagram-1")).toThrow(/human must approve/i);
    ({item}=recordInstagramCollaboratorApproval(item,owner,{draftId:draft.id,accountId:"instagram-1",settings}));
    expect(()=>schedule("instagram-1")).not.toThrow();
    expect(()=>schedule("instagram-2")).toThrow(/human must approve/i);
    expect(()=>schedule("instagram-1",approveInstagramPublishSettings({collaborators:["different"]}))).toThrow(/human must approve/i);
  });

  it("rejects collaborator settings on unsupported Instagram formats", () => {
    let { item } = createContentItem({ workspaceId: "ws-1", title: "Unsupported", actor: owner });
    ({ item } = addSource(item, { kind: "url", title: "Source", url: "https://example.com/unsupported", rights: "reference-only", confidence: 95 }, owner));
    ({ item } = addDraft(item, { platform: "instagram", format: "short", title: "Unsupported", caption: "Checked", mediaIds: ["video-1"] }, owner));
    const draft = item.drafts.at(-1)!;
    ({ item } = recordApproval(item, owner, "approved", "Checked", draft.id));

    expect(() => scheduleTarget(item, owner, {
      platform: "instagram",
      accountId: "instagram-1",
      draftId: draft.id,
      scheduledFor: "2026-09-01T09:00:00.000Z",
      settings: approveInstagramPublishSettings({ collaborators: ["cohost"] }),
    }, "2026-08-29T09:00:00.000Z")).toThrow("feed images, Reels, and carousel parents");
  });

  it("binds Reel cover and feed choices into the exact human-approved settings hash",()=>{
    const custom=approveInstagramPublishSettings({collaborators:[],shareToFeed:false,reelCover:{mode:"custom_image",mediaId:"cover-1",mediaSha256:"c".repeat(64)}});
    const frame=approveInstagramPublishSettings({collaborators:[],shareToFeed:false,reelCover:{mode:"video_frame",offsetMs:1250}});
    const defaultCover=approveInstagramPublishSettings({collaborators:[],shareToFeed:true,reelCover:{mode:"instagram_default"}});
    expect(new Set([custom.approvedSettingsSha256,frame.approvedSettingsSha256,defaultCover.approvedSettingsSha256]).size).toBe(3);
    expect(()=>assertApprovedInstagramPublishSettings({...custom,reelCover:{mode:"custom_image",mediaId:"cover-1",mediaSha256:"d".repeat(64)}})).toThrow(/changed after approval/i);

    let {item}=createContentItem({workspaceId:"ws-1",title:"Reel cover",actor:owner});
    ({item}=addSource(item,{kind:"url",title:"Source",url:"https://example.com/reel",rights:"reference-only",confidence:95},owner));
    ({item}=addDraft(item,{platform:"instagram",format:"reel",title:"Reel",caption:"Checked",mediaIds:["video-1"]},owner));
    const draft=item.drafts.at(-1)!;
    ({item}=recordApproval(item,owner,"approved","Draft approved",draft.id));
    expect(()=>scheduleTarget(item,owner,{platform:"instagram",accountId:"instagram-1",draftId:draft.id,scheduledFor:"2026-09-01T09:00:00.000Z",settings:frame},"2026-08-29T09:00:00.000Z")).toThrow(/human must approve/i);
    ({item}=recordInstagramCollaboratorApproval(item,owner,{draftId:draft.id,accountId:"instagram-1",settings:frame}));
    const scheduled=scheduleTarget(item,owner,{platform:"instagram",accountId:"instagram-1",draftId:draft.id,scheduledFor:"2026-09-01T09:00:00.000Z",settings:frame},"2026-08-29T09:00:00.000Z");
    expect(scheduled.item.targets.at(-1)?.settings).toMatchObject({shareToFeed:false,reelCover:{mode:"video_frame",offsetMs:1250},approvedSettingsSha256:frame.approvedSettingsSha256});
  });
});
