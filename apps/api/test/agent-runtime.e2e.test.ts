import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { AgentRuntimeService } from "../src/agent-runtimes/agent-runtime.service.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { startE2eApp } from "./test-app.js";

describe("workspace AI runtime",()=>{
  let app:NestFastifyApplication;
  beforeAll(async()=>{Object.assign(process.env,{NODE_ENV:"test",AUTH_MODE:"single-user",DATABASE_URL:"",REDIS_URL:"",BOOTSTRAP_USER_ID:"runtime-owner",BOOTSTRAP_USER_NAME:"Runtime Owner",REVIEW_LINK_SECRET:"runtime-review-secret-with-more-than-32-characters",MEDIA_DELIVERY_SECRET:"runtime-media-secret-with-more-than-32-characters",CREDENTIAL_ENCRYPTION_KEY:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",AUTOMATION_DELIVERY_ENABLED:"false"});const fixture=await Test.createTestingModule({imports:[AppModule]}).compile();app=fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({logger:false}));configureApp(app,app.get(ConfigService));await startE2eApp(app);});
  afterAll(async()=>{vi.unstubAllGlobals();await app.close();});
  it("encrypts a BYOK key, tests and assigns the runtime, then records a draft run without prompt text",async()=>{
    const calls:Array<{url:string;authorization?:string}>=[];vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),...(typeof (init?.headers as Record<string,string>|undefined)?.authorization==="string"?{authorization:(init!.headers as Record<string,string>).authorization}:{})});if(String(input).endsWith("/models"))return new Response(JSON.stringify({data:[{id:"openai/gpt-test"}]}),{status:200});return new Response(JSON.stringify({id:"completion-1",model:"openai/gpt-test",choices:[{message:{content:"A clear tested caption"}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}}),{status:200});}));
    const created=await request(app.getHttpServer()).post("/v1/agent-runtimes").send({workspaceId:"default",name:"Editorial OpenRouter",preset:"openrouter",textModel:"openai/gpt-test",apiKey:"runtime-secret"}).expect(201);
    expect(created.body).toMatchObject({preset:"openrouter",baseUrl:"https://openrouter.ai/api/v1",credentialConfigured:true,status:"unverified",version:1});expect(JSON.stringify(created.body)).not.toContain("runtime-secret");expect(created.body).not.toHaveProperty("credential");
    const tested=await request(app.getHttpServer()).post(`/v1/agent-runtimes/${created.body.id}/test?workspaceId=default`).expect(201);expect(tested.body).toMatchObject({ok:true,profile:{status:"healthy",version:2}});
    await request(app.getHttpServer()).post(`/v1/agent-runtimes/${created.body.id}/assign`).send({workspaceId:"default",brandId:"brand_default"}).expect(201);
    const item=await request(app.getHttpServer()).post("/v1/content-items").send({workspaceId:"default",brandId:"brand_default",title:"Runtime draft test",summary:"Only these supplied facts may be used."}).expect(201);
    const drafted=await request(app.getHttpServer()).post(`/v1/content-items/${item.body.id}/agent-draft?workspaceId=default`).set("If-Match",String(item.body.version)).send({platform:"instagram",format:"image",language:"English"}).expect(201);expect(drafted.body.drafts.at(-1)).toMatchObject({caption:"A clear tested caption"});
    const view=await request(app.getHttpServer()).get("/v1/agent-runtimes?workspaceId=default&brandId=brand_default").expect(200);expect(view.body.assignment).toMatchObject({profileId:created.body.id,brandId:"brand_default"});expect(view.body.runs[0]).toMatchObject({profileId:created.body.id,status:"succeeded",inputTokens:20,outputTokens:5});expect(view.body.runs[0]).not.toHaveProperty("prompt");expect(view.body.runs[0]).not.toHaveProperty("response");expect(JSON.stringify(view.body)).not.toContain("runtime-secret");
    await app.get(AgentRuntimeService).runCopyReview({workspaceId:"default",brandId:"brand_default",contentItemId:item.body.id,actor:{id:"runtime-owner",name:"Runtime Owner",role:"owner"},messages:[{role:"user",content:"Review frozen copy"}]});
    const reviewed=await request(app.getHttpServer()).get("/v1/agent-runtimes?workspaceId=default&brandId=brand_default").expect(200);
    expect(reviewed.body.runs[0]).toMatchObject({feature:"copy_review",contentItemId:item.body.id,status:"succeeded"});
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({url:"https://openrouter.ai/api/v1/models",authorization:"Bearer runtime-secret"}),expect.objectContaining({url:"https://openrouter.ai/api/v1/chat/completions",authorization:"Bearer runtime-secret"})]));
  });
  it("does not silently fall back after an assigned provider fails, and lets the owner return to the server default",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({error:{message:"Provider is unavailable"}}),{status:503})));
    const item=await request(app.getHttpServer()).post("/v1/content-items").send({workspaceId:"default",brandId:"brand_default",title:"No fallback test",summary:"Use only this supplied fact."}).expect(201);
    const failed=await request(app.getHttpServer()).post(`/v1/content-items/${item.body.id}/agent-draft?workspaceId=default`).set("If-Match",String(item.body.version)).send({platform:"instagram",format:"image",language:"English"}).expect(503);
    expect(failed.body.message).toMatch(/did not switch to another provider/i);
    const before=await request(app.getHttpServer()).get("/v1/agent-runtimes?workspaceId=default&brandId=brand_default").expect(200);
    expect(before.body.assignment).not.toBeNull();expect(before.body.runs[0]).toMatchObject({status:"failed",errorCode:"provider_failed"});
    await request(app.getHttpServer()).delete("/v1/agent-runtimes/assignments/brand_default?workspaceId=default").expect(200);
    const after=await request(app.getHttpServer()).get("/v1/agent-runtimes?workspaceId=default&brandId=brand_default").expect(200);
    await request(app.getHttpServer()).delete(`/v1/agent-runtimes/${before.body.profiles[0].id}?workspaceId=default`).set("If-Match",String(before.body.profiles[0].version)).expect(409).expect(({body})=>expect(body.message).toContain("usage history"));
    expect(after.body.assignment).toBeNull();expect(after.body.serverHermes).toMatchObject({fallbackOnlyWhenUnassigned:true});
  });
});
