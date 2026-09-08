import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {InstagramReelCoverPanel} from "./instagram-reel-cover-panel";

describe("InstagramReelCoverPanel",()=>{
  it("renders all three cover choices and an exact approved hash without exposing delivery URLs",()=>{
    const html=renderToStaticMarkup(<InstagramReelCoverPanel workspaceId="workspace-1" accountId="account-1" draftId="draft-1" candidateResponse={[{id:"candidate-1",accountId:"account-1",publishingUsername:"publisher",draftId:"draft-1",draftSha256:"d".repeat(64),requestedBy:"editor",requestedAt:"2026-09-01T10:00:00.000Z",status:"approved",approvalId:"approval-1",settings:{collaborators:[],shareToFeed:true,reelCover:{mode:"instagram_default"},approvedSettingsSha256:"a".repeat(64)}}]} coverAssets={[{id:"cover-1",fileName:"cover.png",sha256:"c".repeat(64),rights:"owned",inspectionStatus:"ready"}]} videoDurationMs={60000} canEdit canApprove busy={false} onSave={()=>undefined} onApprove={()=>undefined}/>);
    expect(html).toContain("Instagram Reel cover review");expect(html).toContain("Custom image");expect(html).toContain("Video frame");expect(html).toContain("Instagram default");expect(html).toContain("Approved cover settings");expect(html).not.toContain("access_token");expect(html).not.toContain("delivery/");
  });
});
