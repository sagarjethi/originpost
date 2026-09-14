import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import type { Actor, AuditEvent } from "./types.js";

export const imageGenerationStatuses = ["generating", "ready", "failed", "uncertain"] as const;
export const imageGenerationSizes = ["1024x1024", "1024x1536", "1536x1024"] as const;
export const imageGenerationQualities = ["low", "medium", "high"] as const;
export const imageGenerationVisualIntents = ["editorial_graphic", "illustration", "product_visual", "abstract"] as const;

export type ImageGenerationStatus = (typeof imageGenerationStatuses)[number];
export type ImageGenerationSize = (typeof imageGenerationSizes)[number];
export type ImageGenerationQuality = (typeof imageGenerationQualities)[number];
export type ImageGenerationVisualIntent = (typeof imageGenerationVisualIntents)[number];

export interface ImageGenerationUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface ImageGenerationRecord {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  contentItemId?: string | undefined;
  status: ImageGenerationStatus;
  provider: "openai";
  model: string;
  prompt: string;
  promptSha256: string;
  visualIntent: ImageGenerationVisualIntent;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  outputFormat: "png";
  moderation: "auto";
  altText: string;
  sourceEvidenceIds: string[];
  referenceAssets?: { mediaId: string; sha256: string }[];
  disclosureRequired: true;
  requestFingerprintSha256: string;
  idempotencyKeySha256: string;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  outputMediaId?: string | undefined;
  outputSha256?: string | undefined;
  providerRequestId?: string | undefined;
  revisedPrompt?: string | undefined;
  revisedPromptSha256?: string | undefined;
  usage?: ImageGenerationUsage | undefined;
  errorCode?: string | undefined;
  errorSummary?: string | undefined;
  createdBy: string;
  createdAt: string;
  finishedAt?: string | undefined;
}

export interface ImageGenerationCreateResult {
  record: ImageGenerationRecord;
  created: boolean;
}

export interface CompleteImageGenerationInput {
  workspaceId: string;
  id: string;
  leaseOwner: string;
  outputMediaId: string;
  outputSha256: string;
  providerRequestId?: string | undefined;
  revisedPrompt?: string | undefined;
  usage?: ImageGenerationUsage | undefined;
  finishedAt: string;
  event: AuditEvent;
}

export interface FailImageGenerationInput {
  workspaceId: string;
  id: string;
  leaseOwner: string;
  status: "failed" | "uncertain";
  errorCode: string;
  errorSummary: string;
  providerRequestId?: string | undefined;
  finishedAt: string;
  event: AuditEvent;
}

export interface ImageGenerationRepository {
  create(record: ImageGenerationRecord, event: AuditEvent): Promise<ImageGenerationCreateResult>;
  get(workspaceId: string, id: string): Promise<ImageGenerationRecord | null>;
  list(workspaceId: string, brandId?: string, limit?: number): Promise<ImageGenerationRecord[]>;
  complete(input: CompleteImageGenerationInput): Promise<ImageGenerationRecord | null>;
  fail(input: FailImageGenerationInput): Promise<ImageGenerationRecord | null>;
}

const normalized = (value: string, maximum: number, label: string) => {
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum) throw new DomainError(`${label} must contain 1–${maximum} characters.`, "image_generation_invalid");
  return result;
};

export function imageGenerationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createImageGeneration(input: {
  id?: string;
  workspaceId: string;
  brandId: string;
  contentItemId?: string | undefined;
  provider: "openai";
  model: string;
  prompt: string;
  visualIntent: ImageGenerationVisualIntent;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  altText: string;
  sourceEvidenceIds?: readonly string[] | undefined;
  referenceAssets?: { mediaId: string; sha256: string }[] | undefined;
  idempotencyKey: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  actor: Actor;
  now?: string | undefined;
}): { record: ImageGenerationRecord; event: AuditEvent } {
  if (input.actor.actorType && input.actor.actorType !== "human") throw new DomainError("Only a human editor can request an image.", "permission_denied", 403);
  const now = input.now ?? new Date().toISOString();
  const prompt = normalized(input.prompt, 12_000, "Prompt");
  const altText = normalized(input.altText, 500, "Alt text");
  const model = normalized(input.model, 160, "Image model");
  const workspaceId = normalized(input.workspaceId, 100, "Workspace ID");
  const brandId = normalized(input.brandId, 100, "Brand ID");
  const contentItemId = input.contentItemId ? normalized(input.contentItemId, 200, "Content item ID") : undefined;
  const sourceEvidenceIds = [...new Set((input.sourceEvidenceIds ?? []).map((value) => normalized(value, 200, "Source evidence ID")))].sort();
  const idempotencyKey = normalized(input.idempotencyKey, 200, "Idempotency key");
  const request = {
    workspaceId,
    brandId,
    ...(contentItemId ? { contentItemId } : {}),
    provider: input.provider,
    model,
    prompt,
    visualIntent: input.visualIntent,
    size: input.size,
    quality: input.quality,
    outputFormat: "png" as const,
    moderation: "auto" as const,
    altText,
    sourceEvidenceIds,
    ...(input.referenceAssets?.length ? { referenceAssets: input.referenceAssets } : {}),
  };
  const record: ImageGenerationRecord = {
    id: input.id ?? `image_generation_${randomUUID()}`,
    version: 1,
    status: "generating",
    ...request,
    promptSha256: imageGenerationHash(prompt),
    disclosureRequired: true,
    requestFingerprintSha256: imageGenerationHash(request),
    idempotencyKeySha256: imageGenerationHash(idempotencyKey),
    leaseOwner: normalized(input.leaseOwner, 200, "Generation lease owner"),
    leaseExpiresAt: input.leaseExpiresAt,
    createdBy: input.actor.id,
    createdAt: now,
  };
  if (!Number.isFinite(Date.parse(input.leaseExpiresAt)) || Date.parse(input.leaseExpiresAt) <= Date.parse(now)) throw new DomainError("Image generation needs a future lease expiry.", "image_generation_lease_invalid");
  const event: AuditEvent = {
    id: `audit_${randomUUID()}`,
    workspaceId: record.workspaceId,
    ...(record.contentItemId ? { contentItemId: record.contentItemId } : {}),
    actorId: input.actor.id,
    actorType: input.actor.actorType ?? "human",
    action: "image-generation.requested",
    detail: {
      generationId: record.id,
      brandId: record.brandId,
      provider: record.provider,
      model: record.model,
      promptSha256: record.promptSha256,
      visualIntent: record.visualIntent,
      size: record.size,
      quality: record.quality,
      sourceEvidenceIds: record.sourceEvidenceIds,
      disclosureRequired: true,
    },
    createdAt: now,
  };
  return { record, event };
}

export class InMemoryImageGenerationRepository implements ImageGenerationRepository {
  private readonly records = new Map<string, ImageGenerationRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly events: AuditEvent[] = [];

  async create(record: ImageGenerationRecord, event: AuditEvent): Promise<ImageGenerationCreateResult> {
    const key = `${record.workspaceId}:${record.idempotencyKeySha256}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.records.get(existingId)!;
      if (existing.requestFingerprintSha256 !== record.requestFingerprintSha256) throw new DomainError("This idempotency key was already used for another image request.", "idempotency_conflict", 409);
      return { record: structuredClone(existing), created: false };
    }
    if (this.records.has(record.id)) throw new DomainError("Image generation already exists.", "image_generation_exists", 409);
    this.records.set(record.id, structuredClone(record));
    this.idempotency.set(key, record.id);
    this.events.push(structuredClone(event));
    return { record: structuredClone(record), created: true };
  }

  async get(workspaceId: string, id: string) {
    const record = this.records.get(id);
    return record?.workspaceId === workspaceId ? structuredClone(record) : null;
  }

  async list(workspaceId: string, brandId?: string, limit = 100) {
    return [...this.records.values()].filter((record) => record.workspaceId === workspaceId && (!brandId || record.brandId === brandId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(200, limit))).map((record) => structuredClone(record));
  }

  async complete(input: CompleteImageGenerationInput) {
    const current = this.records.get(input.id);
    if (!current || current.workspaceId !== input.workspaceId || current.status !== "generating" || current.leaseOwner !== input.leaseOwner) return null;
    const revisedPrompt = input.revisedPrompt?.normalize("NFC").trim();
    const next: ImageGenerationRecord = {
      ...current,
      version: current.version + 1,
      status: "ready",
      outputMediaId: input.outputMediaId,
      outputSha256: input.outputSha256,
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(revisedPrompt ? { revisedPrompt, revisedPromptSha256: imageGenerationHash(revisedPrompt) } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      finishedAt: input.finishedAt,
    };
    this.records.set(next.id, structuredClone(next));
    this.events.push(structuredClone(input.event));
    return structuredClone(next);
  }

  async fail(input: FailImageGenerationInput) {
    const current = this.records.get(input.id);
    if (!current || current.workspaceId !== input.workspaceId || current.status !== "generating" || current.leaseOwner !== input.leaseOwner) return null;
    const next: ImageGenerationRecord = {
      ...current,
      version: current.version + 1,
      status: input.status,
      errorCode: input.errorCode.slice(0, 100),
      errorSummary: input.errorSummary.slice(0, 500),
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      finishedAt: input.finishedAt,
    };
    this.records.set(next.id, structuredClone(next));
    this.events.push(structuredClone(input.event));
    return structuredClone(next);
  }
}
