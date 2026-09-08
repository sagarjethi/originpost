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
});
