import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import sharp from "sharp";
import { AgentPostsService } from "../src/agent-posts/agent-posts.service.js";
import { AgentRuntimeService } from "../src/agent-runtimes/agent-runtime.service.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { startE2eApp } from "./test-app.js";

describe("workspace AI runtime",()=>{
  let app:NestFastifyApplication;
  beforeAll(async()=>{Object.assign(process.env,{NODE_ENV:"test",AUTH_MODE:"single-user",DATABASE_URL:"",REDIS_URL:"",BOOTSTRAP_USER_ID:"runtime-owner",BOOTSTRAP_USER_NAME:"Runtime Owner",REVIEW_LINK_SECRET:"runtime-review-secret-with-more-than-32-characters",MEDIA_DELIVERY_SECRET:"runtime-media-secret-with-more-than-32-characters",CREDENTIAL_ENCRYPTION_KEY:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",AUTOMATION_DELIVERY_ENABLED:"false"});const fixture=await Test.createTestingModule({imports:[AppModule]}).compile();app=fixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter({logger:false}));configureApp(app,app.get(ConfigService));await startE2eApp(app);});
  afterAll(async()=>{vi.unstubAllGlobals();await app.close();});
  it("routes Local Codex only through a configured single-owner endpoint", async () => {
    const config=app.get(ConfigService), original=config.get.bind(config);
    let route:string|undefined, authMode="single-user", ownerWorkspace:string|undefined, ownerUser:string|undefined;
    const spy=vi.spyOn(config,"get").mockImplementation(((key:string,...args:unknown[])=>key==="LOCAL_CODEX_BASE_URL"?route:key==="LOCAL_CODEX_OWNER_WORKSPACE_ID"?ownerWorkspace:key==="LOCAL_CODEX_OWNER_USER_ID"?ownerUser:key==="AUTH_MODE"?authMode:original(key,...args as [])) as typeof config.get);
    const service=app.get(AgentRuntimeService), actor={id:"runtime-owner",name:"Runtime Owner",role:"owner" as const};
    const input={workspaceId:"default",name:"Local Codex test",preset:"codex-local" as const,baseUrl:"https://attacker.invalid/v1",textModel:"test-codex",apiKey:"local-bridge-secret"};
    try {
      await expect(service.create("default",input,actor)).rejects.toThrow("Start the local Codex bridge");
      route="http://attacker.invalid/v1";
      await expect(service.create("default",input,actor)).rejects.toThrow("server-owned local HTTP");
      route="http://127.0.0.1:8765/v1";
      authMode="sessions";
      await expect(service.create("default",input,actor)).rejects.toThrow("single-owner");
      authMode="single-user";
      const created=await service.create("default",input,actor);
      expect(created).toMatchObject({preset:"codex-local",baseUrl:"http://127.0.0.1:8765/v1",credentialConfigured:true});
      const calls:string[]=[];
      vi.stubGlobal("fetch",vi.fn(async(url:RequestInfo|URL)=>{calls.push(String(url));return new Response(JSON.stringify({data:[{id:"test-codex"}]}),{status:200});}));
      route="http://host.docker.internal:8765/v1";
      expect((await service.test("default",created.id,actor)).ok).toBe(true);
      expect(calls).toEqual(["http://host.docker.internal:8765/v1/models"]);
      authMode="sessions";ownerWorkspace="default";ownerUser=actor.id;
      expect((await service.test("default",created.id,actor)).ok).toBe(true);
      const count=calls.length;
      await expect(service.test("default",created.id,{...actor,id:"another-owner"})).rejects.toThrow("configured session owner");
      await expect(service.create("another-workspace",input,actor)).rejects.toThrow("configured session owner");
      await expect(service.create("default",input,{...actor,role:"creator"})).rejects.toThrow("Only a workspace owner");
      await service.assign("default",created.id,{workspaceId:"default",brandId:"brand_default"},actor);
      const other={...actor,id:"another-owner"};
      await expect(service.runDraft({workspaceId:"default",brandId:"brand_default",contentItemId:"scope-test",actor:other,messages:[{role:"user",content:"Must never reach Codex"}]})).rejects.toThrow("configured session owner");
      expect(await app.get(AgentPostsService).capability("default","brand_default",other)).toMatchObject({text:false,imageReview:false,research:false,codexUpload:false,available:false});
      ownerUser=undefined;
      await expect(service.test("default",created.id,actor)).rejects.toThrow("configured session owner");
      expect(calls).toHaveLength(count);

    }finally{spy.mockRestore();vi.unstubAllGlobals();}
  });
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
  it("tests image pixels before enabling vision and records image-review usage separately", async () => {
    let wrongAnswer = false;
    let sampleImage = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "text-fixture" }, { id: "vision-fixture" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("vision-fixture");
      const image = body.messages.at(-1).content.find((part: { type: string }) => part.type === "image_url");
      sampleImage = image.image_url.url;
      const { data, info } = await sharp(Buffer.from(sampleImage.split(",")[1]!, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const names: Record<string,string> = { "255,0,0": "red", "0,0,255": "blue", "0,128,0": "green", "255,255,0": "yellow", "0,0,0": "black", "255,255,255": "white" };
      const colors = [80,240,400].map(x => { const offset = (80 * info.width + x) * info.channels; return names[[data[offset],data[offset+1],data[offset+2]].join(",")]; });
      return new Response(JSON.stringify({ model: "vision-fixture", choices: [{ message: { content: JSON.stringify({ colors: wrongAnswer ? ["red","red","red"] : colors }) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), { status: 200 });
    }));
    const created = await request(app.getHttpServer()).post("/v1/agent-runtimes").send({ workspaceId: "default", name: "Visual reviewer", preset: "openrouter", textModel: "text-fixture", visionModel: "vision-fixture", apiKey: "vision-test-key" }).expect(201);
    expect(created.body).toMatchObject({ status: "unverified", visionModel: "vision-fixture" });
    const tested = await request(app.getHttpServer()).post(`/v1/agent-runtimes/${created.body.id}/test`).expect(201);
    expect(tested.body).toMatchObject({ ok: true, profile: { status: "healthy" } });
    await request(app.getHttpServer()).post(`/v1/agent-runtimes/${created.body.id}/assign`).send({ workspaceId: "default", brandId: "brand_default" }).expect(201);
    const service = app.get(AgentRuntimeService);
    expect(await service.imageReviewCapability("default", "brand_default")).toBe(true);
    const item = await request(app.getHttpServer()).post("/v1/content-items").send({ workspaceId: "default", brandId: "brand_default", title: "Vision review test" }).expect(201);
    await service.runImageReview({ workspaceId: "default", brandId: "brand_default", contentItemId: item.body.id, actor: { id: "runtime-owner", name: "Runtime Owner", role: "owner" }, messages: [{ role: "user", content: "Read the sample" }], imageInputs: [{ dataUrl: sampleImage, detail: "high" }] });
    const ledger = await request(app.getHttpServer()).get("/v1/agent-runtimes?workspaceId=default&brandId=brand_default").expect(200);
    expect(ledger.body.runs[0]).toMatchObject({ feature: "image_review", model: "vision-fixture", status: "succeeded" });
    expect(JSON.stringify(ledger.body.runs)).not.toContain("data:image/");
    wrongAnswer = true;
    const failed = await request(app.getHttpServer()).post(`/v1/agent-runtimes/${created.body.id}/test`).expect(201);
    expect(failed.body).toMatchObject({ ok: false, profile: { status: "error" } });
    expect(await service.imageReviewCapability("default", "brand_default")).toBe(false);
    await request(app.getHttpServer()).patch(`/v1/agent-runtimes/${created.body.id}?workspaceId=default`).set("If-Match", String(failed.body.profile.version)).send({ visionModel: null }).expect(400);
    const removedVision = await request(app.getHttpServer()).patch(`/v1/agent-runtimes/${created.body.id}?workspaceId=default`).set("If-Match", String(failed.body.profile.version)).send({ visionModel: "" }).expect(200);
    expect(removedVision.body.visionModel).toBeUndefined();
    expect(removedVision.body.status).toBe("unverified");
  });

});
