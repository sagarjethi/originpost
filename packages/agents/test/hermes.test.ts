import { describe, expect, it, vi } from "vitest";
import { HermesAgentProvider, HermesSourcingProvider, MockSourcingProvider } from "../src/index.js";

describe("Hermes provider", () => {
  it("uses the official OpenAI-compatible gateway shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "response-1",
      model: "hermes-agent",
      choices: [{ message: { content: "Draft ready" } }],
      usage: { total_tokens: 42 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const provider = new HermesAgentProvider({ baseUrl: "http://localhost:8642", apiKey: "test" });
    const result = await provider.run({
      sessionKey: "workspace:default:content:1",
      messages: [{ role: "user", content: "Write a draft" }],
    });

    expect(result.text).toBe("Draft ready");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8642/v1/chat/completions");
    fetchMock.mockRestore();
  });

  it("runs Hermes sourcing through the Responses API and keeps tool provenance", async () => {
    const report = {
      summary: "Two direct sources support the update.",
      sources: [{
        title: "Official update",
        url: "https://example.com/official",
        publisher: "Example Authority",
        publishedAt: "2026-08-28T10:00:00.000Z",
        excerpt: "The update takes effect tomorrow.",
        confidence: 96,
      }],
      claims: [{
        text: "The update takes effect tomorrow.",
        status: "supported",
        sourceUrls: ["https://example.com/official"],
      }],
      stories: [{ title: "Official update takes effect", summary: "One checked update.", sourceUrls: ["https://example.com/official"] }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "resp-1",
      model: "hermes-agent",
      output: [
        { type: "function_call", name: "web_search", call_id: "call-1" },
        { type: "function_call", name: "web_extract", call_id: "call-2" },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(report) }] },
      ],
      usage: { total_tokens: 100 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const provider = new HermesSourcingProvider({ baseUrl: "http://localhost:8642", apiKey: "test" });
    const result = await provider.research({
      sessionKey: "originpost:ws-1:content-1:research",
      query: "Official update",
      depth: "standard",
      languages: ["English"],
      sourceLimit: 6,
    });

    expect(result.sources[0]?.url).toBe("https://example.com/official");
    expect(result.suggestions).toEqual([{ title: "Official update takes effect", summary: "One checked update.", sourceUrls: ["https://example.com/official"] }]);
    expect(result.toolsUsed).toEqual(["web_search", "web_extract"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8642/v1/responses");
    fetchMock.mockRestore();
  });

  it("provides a safe local sourcing adapter", async () => {
    const result = await new MockSourcingProvider().research({
      sessionKey: "test",
      query: "Local test",
      depth: "quick",
      languages: ["English"],
      sourceLimit: 2,
    });
    expect(result.provider).toBe("mock");
    expect(result.sources[0]?.url).toContain("example.invalid");
    expect(result.suggestions).toHaveLength(1);
  });
});
