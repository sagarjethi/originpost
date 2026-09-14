import type {
  AgentProvider,
  AgentRunRequest,
  AgentRunResult,
} from "./types.js";

export class AgentProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unreachable"
      | "unauthorized"
      | "rate_limited"
      | "model_not_found"
      | "invalid_response"
      | "provider_failed",
  ) {
    super(message);
  }
}

type CompletionPayload = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

async function limitedJson(
  response: Response,
  maxBytes = 1_048_576,
): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes)
    throw new AgentProviderError(
      "Provider response is too large.",
      "invalid_response",
    );
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AgentProviderError(
        "Provider response is too large.",
        "invalid_response",
      );
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AgentProviderError(
      "Provider returned invalid JSON.",
      "invalid_response",
    );
  }
}

function providerError(status: number, body: unknown) {
  const message =
    typeof body === "object" && body && "error" in body
      ? String(
          (body as { error?: { message?: unknown } }).error?.message ??
            "Provider request failed.",
        )
      : "Provider request failed.";
  if (status === 401 || status === 403)
    return new AgentProviderError(
      "The provider rejected the API key.",
      "unauthorized",
    );
  if (status === 404)
    return new AgentProviderError(
      "The provider endpoint or model was not found.",
      "model_not_found",
    );
  if (status === 429)
    return new AgentProviderError(
      "The provider rate limit was reached.",
      "rate_limited",
    );
  return new AgentProviderError(message.slice(0, 300), "provider_failed");
}

export class OpenAICompatibleAgentProvider implements AgentProvider {
  readonly id = "openai-compatible";
  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey?: string;
      textModel: string;
      timeoutMs?: number;
    },
  ) {}
  private headers() {
    return {
      "content-type": "application/json",
      ...(this.config.apiKey
        ? { authorization: `Bearer ${this.config.apiKey}` }
        : {}),
    };
  }
  private url(path: string) {
    return `${this.config.baseUrl.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
  }
  async inspect(): Promise<{
    ok: true;
    model: string;
    availableModels: string[];
  }> {
    let response: Response;
    try {
      response = await fetch(this.url("models"), {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch {
      throw new AgentProviderError(
        "The provider could not be reached.",
        "unreachable",
      );
    }
    const body = await limitedJson(response);
    if (!response.ok) throw providerError(response.status, body);
    const data =
      typeof body === "object" &&
      body &&
      "data" in body &&
      (body as { data?: unknown }).data;
    const models = Array.isArray(data)
      ? data
          .map((entry) =>
            typeof entry === "object" && entry && "id" in entry
              ? String((entry as { id: unknown }).id)
              : "",
          )
          .filter(Boolean)
          .slice(0, 500)
      : [];
    if (models.length && !models.includes(this.config.textModel))
      throw new AgentProviderError(
        "The chosen text model was not found on this provider.",
        "model_not_found",
      );
    return { ok: true, model: this.config.textModel, availableModels: models };
  }
  async health() {
    try {
      await this.inspect();
      return true;
    } catch {
      return false;
    }
  }
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    let messages: unknown = request.messages;
    if (request.imageInputs) {
      if (
        !request.imageInputs.length ||
        request.imageInputs.length > 4 ||
        request.imageInputs.some(
          (image) =>
            image.detail !== "high" ||
            !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(
              image.dataUrl,
            ),
        ) ||
        request.imageInputs.reduce(
          (sum, image) => sum + image.dataUrl.length,
          0,
        ) >
          28 * 1024 * 1024
      )
        throw new AgentProviderError(
          "Image inputs must be bounded PNG/JPEG data URLs.",
          "invalid_response",
        );
      const userIndex = request.messages.findLastIndex(
        (message) => message.role === "user",
      );
      if (userIndex < 0)
        throw new AgentProviderError(
          "An image review needs a user message.",
          "invalid_response",
        );
      messages = request.messages.map((message, index) =>
        index === userIndex
          ? {
              ...message,
              content: [
                { type: "text", text: message.content },
                ...request.imageInputs!.map((image) => ({
                  type: "image_url",
                  image_url: { url: image.dataUrl, detail: image.detail },
                })),
              ],
            }
          : message,
      );
    }
    let response: Response;
    try {
      response = await fetch(this.url("chat/completions"), {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        body: JSON.stringify({
          model: this.config.textModel,
          messages,
          temperature: request.temperature ?? 0.2,
          ...(new URL(this.config.baseUrl).hostname === "api.openai.com"
            ? { max_completion_tokens: request.maxTokens ?? 2000 }
            : { max_tokens: request.maxTokens ?? 2000 }),
          stream: false,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
      });
    } catch (error) {
      if (error instanceof AgentProviderError) throw error;
      throw new AgentProviderError(
        "The provider could not be reached.",
        "unreachable",
      );
    }
    const raw = (await limitedJson(response)) as CompletionPayload;
    if (!response.ok) throw providerError(response.status, raw);
    const text = raw.choices?.[0]?.message?.content?.trim();
    if (!text)
      throw new AgentProviderError(
        "Provider returned no finished text.",
        "invalid_response",
      );
    return {
      provider: this.id,
      model: raw.model ?? this.config.textModel,
      text,
      ...(raw.id ? { responseId: raw.id } : {}),
      ...(raw.usage
        ? {
            usage: {
              inputTokens: raw.usage.prompt_tokens ?? 0,
              outputTokens: raw.usage.completion_tokens ?? 0,
              totalTokens: raw.usage.total_tokens ?? 0,
            },
          }
        : {}),
      raw,
    };
  }
}
