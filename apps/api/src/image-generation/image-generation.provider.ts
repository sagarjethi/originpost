import type { ImageGenerationQuality, ImageGenerationSize, ImageGenerationUsage } from "@originpost/domain";

export const IMAGE_GENERATION_PROVIDER = Symbol("IMAGE_GENERATION_PROVIDER");

export type ImageGenerationProviderCapability = {
  enabled: boolean;
  provider: "openai";
  model: string;
  reason?: "disabled" | "credential_missing" | undefined;
};

export type ImageGenerationProviderResult = {
  bytes: Uint8Array;
  contentType: "image/png";
  providerRequestId?: string | undefined;
  revisedPrompt?: string | undefined;
  usage?: ImageGenerationUsage | undefined;
};

export class ImageGenerationProviderError extends Error {
  constructor(
    public readonly code: "unauthorized" | "rate_limited" | "request_rejected" | "provider_unavailable" | "invalid_response" | "timeout" | "disabled",
    message: string,
    public readonly providerRequestId?: string | undefined,
  ) {
    super(message);
    this.name = "ImageGenerationProviderError";
  }
}

export interface ImageGenerationProvider {
  capability(): ImageGenerationProviderCapability;
  generate(input: { requestId: string; prompt: string; size: ImageGenerationSize; quality: ImageGenerationQuality; referenceImages?: Uint8Array[] }): Promise<ImageGenerationProviderResult>;
}

export class DisabledImageGenerationProvider implements ImageGenerationProvider {
  constructor(private readonly model = "gpt-image-2.5-sunburst", private readonly reason: "disabled" | "credential_missing" = "disabled") {}
  capability(): ImageGenerationProviderCapability { return { enabled: false, provider: "openai", model: this.model, reason: this.reason }; }
  async generate(): Promise<never> { throw new ImageGenerationProviderError("disabled", "Image generation is not configured."); }
}

type Fetch = typeof globalThis.fetch;

function safeRequestId(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._:-]{1,200}$/u.test(normalized) ? normalized : undefined;
}

function numericUsage(value: unknown): ImageGenerationUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usage: ImageGenerationUsage = {};
  if (Number.isFinite(raw.input_tokens) && Number(raw.input_tokens) >= 0) usage.inputTokens = Number(raw.input_tokens);
  if (Number.isFinite(raw.output_tokens) && Number(raw.output_tokens) >= 0) usage.outputTokens = Number(raw.output_tokens);
  if (Number.isFinite(raw.total_tokens) && Number(raw.total_tokens) >= 0) usage.totalTokens = Number(raw.total_tokens);
  return Object.keys(usage).length ? usage : undefined;
}

export class OpenAIImageGenerationProvider implements ImageGenerationProvider {
  private readonly endpoint = "https://api.openai.com/v1/images/generations";
  constructor(private readonly options: { apiKey: string; model: string; timeoutMs: number; fetch?: Fetch | undefined }) {}

  capability(): ImageGenerationProviderCapability {
    return { enabled: Boolean(this.options.apiKey.trim()), provider: "openai", model: this.options.model };
  }

  async generate(input: { requestId: string; prompt: string; size: ImageGenerationSize; quality: ImageGenerationQuality; referenceImages?: Uint8Array[] }): Promise<ImageGenerationProviderResult> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const fields = { model: this.options.model, prompt: input.prompt, size: input.size, quality: input.quality, output_format: "png", background: "opaque", moderation: "auto", n: 1 };
    let body: string | FormData = JSON.stringify(fields);
    const references = input.referenceImages ?? [];
    if (references.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
      for (const [index, bytes] of references.entries()) form.append("image[]", new Blob([new Uint8Array(bytes)], { type: "image/png" }), `reference-${index}.png`);
      body = form;
    }
    let response: Response;
    try {
      response = await fetcher(references.length ? "https://api.openai.com/v1/images/edits" : this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(references.length ? {} : { "content-type": "application/json" }),
          "idempotency-key": input.requestId,
        },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw new ImageGenerationProviderError("timeout", "Image generation timed out. The result is uncertain and was not retried automatically.");
      throw new ImageGenerationProviderError("provider_unavailable", "OpenAI image generation could not be reached.");
    }
    const providerRequestId = safeRequestId(response.headers.get("x-request-id"));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ImageGenerationProviderError("unauthorized", "OpenAI rejected the image-generation credential.", providerRequestId);
      if (response.status === 429) throw new ImageGenerationProviderError("rate_limited", "OpenAI image generation is rate-limited. Start a new request later.", providerRequestId);
      if (response.status >= 400 && response.status < 500) throw new ImageGenerationProviderError("request_rejected", "OpenAI could not generate this visual. Review the brief and start a new request.", providerRequestId);
      throw new ImageGenerationProviderError("provider_unavailable", "OpenAI image generation is temporarily unavailable.", providerRequestId);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 90 * 1024 * 1024) throw new ImageGenerationProviderError("invalid_response", "OpenAI returned an image response above the safe size limit.", providerRequestId);
    const text = await response.text();
    if (text.length > 90 * 1024 * 1024) throw new ImageGenerationProviderError("invalid_response", "OpenAI returned an image response above the safe size limit.", providerRequestId);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new ImageGenerationProviderError("invalid_response", "OpenAI returned an unreadable image response.", providerRequestId); }
    const first = Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined;
    const encoded = typeof first?.b64_json === "string" ? first.b64_json : "";
    if (!encoded || encoded.length > 88 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new ImageGenerationProviderError("invalid_response", "OpenAI returned no valid image bytes.", providerRequestId);
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024) throw new ImageGenerationProviderError("invalid_response", "OpenAI returned image bytes outside the safe size limit.", providerRequestId);
    return {
      bytes,
      contentType: "image/png",
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(typeof first?.revised_prompt === "string" && first.revised_prompt.trim() ? { revisedPrompt: first.revised_prompt.trim().slice(0, 12_000) } : {}),
      ...(numericUsage(payload.usage) ? { usage: numericUsage(payload.usage) } : {}),
    };
  }
}
