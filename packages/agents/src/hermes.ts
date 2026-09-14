import type { AgentProvider, AgentRunRequest, AgentRunResult } from "./types.js";

type HermesCompletion = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: Record<string, number>;
};

export class HermesAgentProvider implements AgentProvider {
  readonly id = "hermes";

  constructor(private readonly config: {
    baseUrl: string;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
  }) {}

  private headers(sessionKey?: string): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
      ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
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

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.imageInputs) throw new Error("This Hermes transport has not established image-input support.");
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(request.sessionKey),
      body: JSON.stringify({
        model: this.config.model ?? "hermes-agent",
        messages: request.messages,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 2000,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Hermes returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const raw = await response.json() as HermesCompletion;
    const text = raw.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Hermes returned an empty response.");
    return {
      provider: this.id,
      model: raw.model ?? this.config.model ?? "hermes-agent",
      text,
      ...(raw.id ? { responseId: raw.id } : {}),
      ...(raw.usage ? { usage: raw.usage } : {}),
      raw,
    };
  }
}
