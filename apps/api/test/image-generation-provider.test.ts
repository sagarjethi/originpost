import { describe, expect, it, vi } from "vitest";
import { ImageGenerationProviderError, OpenAIImageGenerationProvider } from "../src/image-generation/image-generation.provider.js";

describe("OpenAI image generation provider", () => {
  it("uses the fixed official endpoint and returns bounded PNG bytes with request lineage", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("png-bytes").toString("base64"), revised_prompt: "A revised visual brief" }],
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_image_1" } }));
    const provider = new OpenAIImageGenerationProvider({ apiKey: "secret", model: "gpt-image-2.5-sunburst", timeoutMs: 10_000, fetch: fetcher as typeof fetch });
    await expect(provider.generate({ requestId: "image_generation_1", prompt: "An editorial illustration", size: "1024x1536", quality: "medium" })).resolves.toMatchObject({
      bytes: Buffer.from("png-bytes"),
      contentType: "image/png",
      providerRequestId: "req_image_1",
      revisedPrompt: "A revised visual brief",
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/images/generations", expect.objectContaining({ method: "POST" }));
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: "Bearer secret", "idempotency-key": "image_generation_1" });
    expect(JSON.parse(String(request.body))).toMatchObject({ model: "gpt-image-2.5-sunburst", size: "1024x1536", quality: "medium", output_format: "png", moderation: "auto", n: 1 });
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [400, "request_rejected"],
    [503, "provider_unavailable"],
  ] as const)("maps HTTP %s to a safe %s error", async (status, code) => {
    const provider = new OpenAIImageGenerationProvider({ apiKey: "secret", model: "gpt-image-2.5-sunburst", timeoutMs: 10_000, fetch: vi.fn(async () => new Response("raw provider secret", { status, headers: { "x-request-id": "req_safe" } })) as typeof fetch });
    await expect(provider.generate({ requestId: "request-1", prompt: "Visual", size: "1024x1024", quality: "low" })).rejects.toMatchObject<Partial<ImageGenerationProviderError>>({ code, providerRequestId: "req_safe" });
  });

  it("rejects malformed base64 instead of saving provider output", async () => {
    const provider = new OpenAIImageGenerationProvider({ apiKey: "secret", model: "gpt-image-2.5-sunburst", timeoutMs: 10_000, fetch: vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "not base64!" }] }), { status: 200 })) as typeof fetch });
    await expect(provider.generate({ requestId: "request-1", prompt: "Visual", size: "1024x1024", quality: "low" })).rejects.toMatchObject<Partial<ImageGenerationProviderError>>({ code: "invalid_response" });
  });
});

it("sends selected references as multipart image edits without a manual boundary", async () => {
  const fetcher=vi.fn(async (_url: string | URL | Request, _init?: RequestInit)=>new Response(JSON.stringify({data:[{b64_json:Buffer.from("png").toString("base64")}]}),{status:200}));
  const provider=new OpenAIImageGenerationProvider({apiKey:"test",model:"test",timeoutMs:10000,fetch:fetcher as typeof fetch});
  await provider.generate({requestId:"refs",prompt:"Style only",size:"1024x1024",quality:"medium",referenceImages:[new Uint8Array([1,2,3])]});
  const [url,init]=fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/images/edits");
  expect(init!.body).toBeInstanceOf(FormData);
  expect((init!.body as FormData).getAll("image[]")).toHaveLength(1);
  expect(new Headers(init!.headers).has("content-type")).toBe(false);
});
