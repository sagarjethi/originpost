import { z } from "zod";

export interface SourcingRequest {
  sessionKey: string;
  query: string;
  context?: string | undefined;
  depth: "quick" | "standard" | "deep";
  languages: string[];
  region?: string | undefined;
  sourceLimit: number;
  freshnessHours?: number | undefined;
}

export interface SourcingResult {
  provider: string;
  model: string;
  responseId?: string | undefined;
  summary: string;
  sources: Array<{
    title: string;
    url: string;
    publisher?: string | undefined;
    publishedAt?: string | undefined;
    excerpt?: string | undefined;
    confidence: number;
    retrieval?: { status: "matched" | "mismatch" | "unavailable"; checkedAt: string; finalUrl?: string; sha256?: string; reason?: string };
    feedUrl?: string | undefined;
    stableId?: string | undefined;
    pageUrl?: string | undefined;
    snapshot?: { resourceFailures?: number; sha256: string; capturedAt: string; pageUrl: string; width: number; height: number } | undefined;
  }>;
  claims: Array<{
    text: string;
    status: "unverified" | "supported" | "disputed" | "rejected";
    sourceUrls: string[];
  }>;
  suggestions: Array<{
    title: string;
    summary: string;
    sourceUrls: string[];
  }>;
  toolsUsed: string[];
  usage?: Record<string, number> | undefined;
  raw: unknown;
}

export interface SourcingProvider {
  readonly id: string;
  health(): Promise<boolean>;
  research(request: SourcingRequest): Promise<SourcingResult>;
}

const researchPayloadSchema = z.object({
  summary: z.string().min(1).max(4000),
  sources: z.array(z.object({
    title: z.string().min(1).max(300),
    url: z.url(),
    publisher: z.string().max(160).nullish(),
    publishedAt: z.iso.datetime().nullish(),
    excerpt: z.string().max(1500).nullish(),
    confidence: z.number().min(0).max(100),
  })).min(1).max(20),
  claims: z.array(z.object({
    text: z.string().min(1).max(1000),
    status: z.enum(["unverified", "supported", "disputed", "rejected"]),
    sourceUrls: z.array(z.url()).max(20),
  })).max(50),
  stories: z.array(z.object({
    title: z.string().min(1).max(300),
    summary: z.string().min(1).max(2000),
    sourceUrls: z.array(z.url()).min(1).max(20),
  })).max(12).optional(),
});

type HermesResponsesPayload = {
  id?: string;
  model?: string;
  output?: Array<{
    type?: string;
    name?: string;
    call_id?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: Record<string, number>;
};

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(withoutFence);
}

export class HermesSourcingProvider implements SourcingProvider {
  readonly id: string = "hermes";

  constructor(private readonly config: {
    baseUrl: string;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
  }) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async research(request: SourcingRequest): Promise<SourcingResult> {
    const model = this.config.model ?? "hermes-agent";
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/responses`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        conversation: request.sessionKey,
        store: true,
        instructions: [
          "You are the OriginPost sourcing researcher.",
          "Use web_search and web_extract to find direct, current sources.",
          "Cross-check important claims with at least two independent sources when possible.",
          "Check publication dates and do not invent titles, URLs, publishers, quotes, dates, or facts.",
          "Prefer official and primary sources. Keep allegation and uncertainty language.",
          "Group links about the same event into one story. Do not group unrelated events together.",
          "Return only valid JSON with keys summary, sources, claims, and stories.",
          "Each source needs title, direct url, publisher or null, publishedAt as ISO timestamp or null, excerpt or null, and confidence from 0 to 100.",
          "Each claim needs text, status (supported, disputed, unverified, or rejected), and sourceUrls using only URLs from sources.",
          "Each story needs a clear title, short summary, and sourceUrls using only URLs from sources.",
        ].join(" "),
        input: [
          `Research query: ${request.query}`,
          request.context ? `Existing context: ${request.context}` : "",
          `Depth: ${request.depth}`,
          `Languages: ${request.languages.join(", ")}`,
          request.region ? `Region: ${request.region}` : "",
          `Return at most ${request.sourceLimit} strong sources.`,
          request.freshnessHours ? `Prefer sources published in the last ${request.freshnessHours} hours, while retaining older primary background sources when required.` : "",
        ].filter(Boolean).join("\n"),
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 240_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Hermes sourcing returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const raw = await response.json() as HermesResponsesPayload;
    const text = raw.output
      ?.filter((entry) => entry.type === "message")
      .flatMap((entry) => entry.content ?? [])
      .filter((entry) => entry.type === "output_text" && entry.text)
      .map((entry) => entry.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Hermes sourcing returned no final report.");
    const parsed = researchPayloadSchema.parse(parseJsonText(text));
    const selectedSources = parsed.sources.slice(0, request.sourceLimit);
    const sourceUrls = new Set(selectedSources.map((source) => source.url));
    const suggestions = (parsed.stories ?? []).map((story) => ({ ...story, sourceUrls: [...new Set(story.sourceUrls.filter((url) => sourceUrls.has(url)))] })).filter((story) => story.sourceUrls.length > 0);
    return {
      provider: this.id,
      model: raw.model ?? model,
      ...(raw.id ? { responseId: raw.id } : {}),
      summary: parsed.summary,
      sources: selectedSources.map((source) => ({
        title: source.title,
        url: source.url,
        confidence: source.confidence,
        ...(source.publisher ? { publisher: source.publisher } : {}),
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        ...(source.excerpt ? { excerpt: source.excerpt } : {}),
      })),
      claims: parsed.claims.map((claim) => ({
        text: claim.text,
        status: claim.status,
        sourceUrls: claim.sourceUrls.filter((url) => sourceUrls.has(url)),
      })),
      suggestions: suggestions.length ? suggestions : [{ title: selectedSources[0]!.title, summary: parsed.summary, sourceUrls: selectedSources.map((source) => source.url) }],
      toolsUsed: [...new Set(raw.output?.filter((entry) => entry.type === "function_call" && entry.name).map((entry) => entry.name!) ?? [])],
      ...(raw.usage ? { usage: raw.usage } : {}),
      raw,
    };
  }
}

export class MockSourcingProvider implements SourcingProvider {
  readonly id = "mock";

  async health(): Promise<boolean> {
    return true;
  }

  async research(request: SourcingRequest): Promise<SourcingResult> {
    const slug = encodeURIComponent(request.query.toLowerCase().replace(/\s+/g, "-").slice(0, 80));
    const url = `https://example.invalid/originpost-source/${slug}`;
    return {
      provider: this.id,
      model: "mock-sourcing-v1",
      responseId: `mock_${crypto.randomUUID()}`,
      summary: `Safe local research result for “${request.query}”. Replace this mock run with Hermes for live sourcing.`,
      sources: [{
        title: `Mock source for ${request.query}`,
        url,
        publisher: "OriginPost safe test",
        publishedAt: new Date().toISOString(),
        excerpt: "This source exists only to test the source-to-proof workflow.",
        confidence: 100,
      }],
      claims: [{
        text: "This is a local mock research result and is not a real-world factual claim.",
        status: "supported",
        sourceUrls: [url],
      }],
      suggestions: [{ title: `Mock finding for ${request.query}`, summary: `Safe local monitor suggestion for “${request.query}”.`, sourceUrls: [url] }],
      toolsUsed: ["mock_search", "mock_extract"],
      raw: { mock: true },
    };
  }
}
