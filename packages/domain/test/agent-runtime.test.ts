import { describe, expect, it } from "vitest";
import { createAgentRuntimeProfile, InMemoryAgentRuntimeRepository, reviseAgentRuntimeProfile } from "../src/agent-runtime.js";

const owner={id:"owner",name:"Owner",role:"owner" as const,actorType:"human" as const};

describe("workspace AI runtimes",()=>{
  it("uses fixed public endpoints for known providers and never stores a key in the profile",()=>{
    const {profile}=createAgentRuntimeProfile({workspaceId:"workspace",name:"OpenRouter",preset:"openrouter",baseUrl:"https://attacker.invalid",textModel:"openai/gpt-5-mini",credentialConfigured:true,actor:owner,now:"2026-09-01T10:00:00.000Z"});
    expect(profile.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(profile).not.toHaveProperty("apiKey");
  });
  it("requires a key for hosted presets and owner authority",()=>{
    expect(()=>createAgentRuntimeProfile({workspaceId:"workspace",name:"OpenAI",preset:"openai",textModel:"gpt-5-mini",credentialConfigured:false,actor:owner})).toThrow(/needs an API key/i);
    expect(()=>createAgentRuntimeProfile({workspaceId:"workspace",name:"Local",preset:"ollama",baseUrl:"http://127.0.0.1:11434/v1",textModel:"qwen3",credentialConfigured:false,actor:{...owner,role:"manager"}})).toThrow(/workspace owner/i);
  });
  it("requires a healthy test before brand assignment and has no silent runtime fallback",async()=>{
    const repo=new InMemoryAgentRuntimeRepository();const created=createAgentRuntimeProfile({id:"runtime",workspaceId:"workspace",name:"Local",preset:"ollama",baseUrl:"http://127.0.0.1:11434/v1",textModel:"qwen3",credentialConfigured:false,actor:owner,now:"2026-09-01T10:00:00.000Z"});await repo.createProfile(created.profile,null,created.event);
    await expect(repo.assign({workspaceId:"workspace",brandId:"brand",profileId:"runtime",assignedBy:"owner",assignedAt:"2026-09-01T10:01:00.000Z"},created.event)).rejects.toThrow(/test this/i);
    const healthy=await repo.updateHealth("workspace","runtime",1,{status:"healthy",checkedAt:"2026-09-01T10:02:00.000Z"},created.event);await repo.assign({workspaceId:"workspace",brandId:"brand",profileId:"runtime",assignedBy:"owner",assignedAt:"2026-09-01T10:03:00.000Z"},created.event);
    expect((await repo.getExecutionContext("workspace","brand"))?.profile.id).toBe("runtime");
    const disabled=reviseAgentRuntimeProfile(healthy!,{disabled:true,actor:owner,now:"2026-09-01T10:04:00.000Z"});await repo.updateProfile(disabled.profile,healthy!.version,undefined,disabled.event);
    expect(await repo.getExecutionContext("workspace","brand")).toBeNull();
  });
  it("re-enables as unverified and can return a brand to the explicit server default",async()=>{
    const repo=new InMemoryAgentRuntimeRepository();const created=createAgentRuntimeProfile({id:"runtime",workspaceId:"workspace",name:"Local",preset:"ollama",baseUrl:"http://127.0.0.1:11434/v1",textModel:"qwen3",credentialConfigured:false,actor:owner,now:"2026-09-01T10:00:00.000Z"});await repo.createProfile(created.profile,null,created.event);
    const disabled=reviseAgentRuntimeProfile(created.profile,{disabled:true,actor:owner,now:"2026-09-01T10:01:00.000Z"});expect(disabled.profile.status).toBe("disabled");
    const enabled=reviseAgentRuntimeProfile(disabled.profile,{disabled:false,actor:owner,now:"2026-09-01T10:02:00.000Z"});expect(enabled.profile.status).toBe("unverified");
    const healthy=await repo.updateHealth("workspace","runtime",1,{status:"healthy",checkedAt:"2026-09-01T10:03:00.000Z"},created.event);await repo.assign({workspaceId:"workspace",brandId:"brand",profileId:"runtime",assignedBy:"owner",assignedAt:"2026-09-01T10:04:00.000Z"},created.event);expect(await repo.unassign("workspace","brand",created.event)).toBe(true);expect(await repo.getAssignment("workspace","brand")).toBeNull();expect(healthy?.status).toBe("healthy");
  });
  it("requires a fresh test after vision changes and preserves an explicit disable", () => {
    const created = createAgentRuntimeProfile({ workspaceId: "workspace", name: "Vision", preset: "custom", baseUrl: "https://models.example/v1", textModel: "text", visionModel: "vision", credentialConfigured: false, actor: owner });
    const healthy = { ...created.profile, status: "healthy" as const };
    const changed = reviseAgentRuntimeProfile(healthy, { visionModel: "next-vision", actor: owner }).profile;
    expect(changed).toMatchObject({ visionModel: "next-vision", status: "unverified" });
    const cleared = reviseAgentRuntimeProfile(healthy, { visionModel: "", actor: owner }).profile;
    expect(cleared.visionModel).toBeUndefined();
    expect(cleared.status).toBe("unverified");
    const disabled = reviseAgentRuntimeProfile({ ...healthy, status: "disabled" }, { visionModel: "next-vision", actor: owner }).profile;
    expect(disabled.status).toBe("disabled");
  });

});
