import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRuntimeSettings } from "./agent-runtime-settings";

const auth={mode:"single-user" as const,user:{id:"owner",email:"owner@example.test",displayName:"Owner"},memberships:[{workspaceId:"workspace",workspaceName:"Workspace",workspaceSlug:"workspace",userId:"owner",role:"owner" as const}]};

describe("workspace AI runtime UI",()=>{
  it("renders a privacy-safe owner setup shell",()=>{
    const markup=renderToStaticMarkup(<AgentRuntimeSettings auth={auth} workspaceId="workspace" brandId="brand"/>);
    expect(markup).toContain("Choose who writes the first draft");
    expect(markup).toContain("Keys are encrypted on the server");
    expect(markup).toContain("No text provider assigned");
    expect(markup).toContain("managed only inside each Board");
    expect(markup).not.toContain("Research still stays with Hermes");
    expect(markup).toContain("Prompt and response text are not stored");
    expect(markup).not.toContain("owner@example.test");
  });
});
