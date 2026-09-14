import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderError, OpenAICompatibleAgentProvider } from "../src/openai-compatible.js";

describe("OpenAI-compatible agent runtime",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("checks the configured model without following redirects or exposing the key in the URL",async()=>{
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>new Response(JSON.stringify({data:[{id:"local-model"}]}),{status:200,headers:{"content-type":"application/json"}}));vi.stubGlobal("fetch",fetchMock);
    const provider=new OpenAICompatibleAgentProvider({baseUrl:"https://models.example/v1",apiKey:"secret-key",textModel:"local-model"});await expect(provider.inspect()).resolves.toMatchObject({ok:true,model:"local-model"});
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://models.example/v1/models");expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("secret-key");expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({redirect:"error",headers:expect.objectContaining({authorization:"Bearer secret-key"})});
  });
  it("runs chat completions and returns normalized token use",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({id:"response",model:"local-model",choices:[{message:{content:"Finished caption"}}],usage:{prompt_tokens:12,completion_tokens:7,total_tokens:19}}),{status:200})));const provider=new OpenAICompatibleAgentProvider({baseUrl:"https://models.example/v1",textModel:"local-model"});await expect(provider.run({sessionKey:"session",messages:[{role:"user",content:"Write"}]})).resolves.toMatchObject({text:"Finished caption",usage:{inputTokens:12,outputTokens:7,totalTokens:19}});});
  it("returns a stable safe error for rejected credentials",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({error:{message:"raw secret error"}}),{status:401})));const provider=new OpenAICompatibleAgentProvider({baseUrl:"https://models.example/v1",apiKey:"bad",textModel:"model"});await expect(provider.inspect()).rejects.toEqual(expect.objectContaining<Partial<AgentProviderError>>({code:"unauthorized",message:"The provider rejected the API key."}));});
  it("sends image bytes as multimodal content and refuses external image URLs", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "Observed image" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleAgentProvider({ baseUrl: "https://models.example/v1", textModel: "vision-model" });
    const input = { sessionKey: "review", messages: [{ role: "system" as const, content: "Inspect" }, { role: "user" as const, content: "Read this" }], imageInputs: [{ dataUrl: "data:image/png;base64,aW1hZ2U=", detail: "high" as const }] };
    await provider.run(input);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.model).toBe("vision-model");
    expect(body.messages[0].content).toBe("Inspect");
    expect(body.messages[1].content).toEqual([{ type: "text", text: "Read this" }, { type: "image_url", image_url: { url: input.imageInputs[0]!.dataUrl, detail: "high" } }]);
    await expect(provider.run({ ...input, imageInputs: [{ dataUrl: "http://localhost/private.png", detail: "high" }] })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the current completion-token field on the official OpenAI endpoint", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "Read" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAICompatibleAgentProvider({ baseUrl: "https://api.openai.com/v1", textModel: "configured-model" }).run({ sessionKey: "s", messages: [{ role: "user", content: "Read" }], maxTokens: 4000 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.max_completion_tokens).toBe(4000);
    expect(body).not.toHaveProperty("max_tokens");
  });

});
