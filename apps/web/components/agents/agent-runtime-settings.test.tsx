import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRuntimeSettings } from "./agent-runtime-settings";

const auth={mode:"single-user" as const,user:{id:"owner",email:"owner@example.test",displayName:"Owner"},memberships:[{workspaceId:"workspace",workspaceName:"Workspace",workspaceSlug:"workspace",userId:"owner",role:"owner" as const}]};

describe("workspace AI runtime UI",()=>{
  it("shows the provider flow and separate text/image entry points without exposing identity",()=>{
    const markup=renderToStaticMarkup(<AgentRuntimeSettings auth={auth} workspaceId="workspace" brandId="brand"/>);
    expect(markup).toContain("Connect your generation tools");
    expect(markup).toContain("Keys are encrypted on the server");
    expect(markup).toContain("Connect OpenAI API");
    expect(markup).toContain("Connect local Codex");
    expect(markup).toContain("Hermes is managed on the server");
    expect(markup).toContain("billed separately from ChatGPT");
    expect(markup).toContain("3. Assign");
    expect(markup).toContain('href="/create"');
    expect(markup).toContain('href="/creative-studio?generate=image"');
    expect(markup).toContain('href="/setup?provider=images"');
    expect(markup).toContain("Prompt and response text are not stored");
    expect(markup).not.toContain("owner@example.test");
  });

  it("does not report an unconfigured provider before the initial check finishes",()=>{
    const markup=renderToStaticMarkup(<AgentRuntimeSettings auth={auth} workspaceId="workspace" brandId="brand"/>);
    expect(markup).toContain("Checking provider connections");
    expect(markup).not.toContain("No text provider assigned");
    expect(markup).not.toContain("No text provider connected yet");
  });

  it("does not use ownership of another workspace to expose provider management",()=>{
    const markup=renderToStaticMarkup(<AgentRuntimeSettings auth={auth} workspaceId="another-workspace" brandId="brand"/>);
    expect(markup).toContain("Your workspace owner manages provider connections and keys");
    expect(markup).toContain('href="/create"');
    expect(markup).toContain('href="/creative-studio?generate=image"');
    expect(markup).not.toContain("Connect OpenAI API");
    expect(markup).not.toContain("Add provider");
    expect(markup).not.toContain("Usage ledger");
    expect(markup).not.toContain('href="/setup');
  });
});
