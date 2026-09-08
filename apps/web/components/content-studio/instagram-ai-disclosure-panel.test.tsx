import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstagramAiDisclosurePanel } from "./instagram-ai-disclosure-panel";

const hash = "a".repeat(64);
const approved = [{ id:"candidate-1", status:"approved", requestedBy:"creator", requestedAt:"2026-09-01T10:00:00.000Z", approvalId:"approval-1", accountId:"ig-1", publishingUsername:"samplepublisher", draftId:"draft-1", settings:{ collaborators:[], shareToFeed:true, isAiGenerated:true, approvedSettingsSha256:hash } }];

describe("InstagramAiDisclosurePanel",()=>{
  it("shows the exact approved native label and provider observation",()=>{
    const html=renderToStaticMarkup(<InstagramAiDisclosurePanel accountId="ig-1" draftId="draft-1" candidateResponse={approved} canEdit canApprove proof={{requested:true,observed:true,label:"ai_info"}} onSave={()=>{}} onApprove={()=>{}}/>);
    expect(html).toContain("AI info label approved");
    expect(html).toContain("Native label observed");
    expect(html).toContain("Requested in the approved publish");
  });

  it("never claims an unobserved label was verified",()=>{
    const html=renderToStaticMarkup(<InstagramAiDisclosurePanel accountId="ig-1" draftId="draft-1" candidateResponse={approved} canEdit canApprove proof={{requested:true,observed:false,label:"ai_info"}} onSave={()=>{}} onApprove={()=>{}}/>);
    expect(html).toContain("Native label not verified");
    expect(html).not.toContain("Native label observed");
  });
});
