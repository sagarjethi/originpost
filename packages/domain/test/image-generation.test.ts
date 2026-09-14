import { describe, expect, it } from "vitest";
import { createImageGeneration, DomainError, imageGenerationHash, InMemoryImageGenerationRepository, type Actor, type AuditEvent } from "../src/index.js";

const actor: Actor = { id: "editor-1", name: "Editor", role: "creator", actorType: "human" };
const now = "2026-09-13T08:00:00.000Z";

function generation(overrides: Partial<Parameters<typeof createImageGeneration>[0]> = {}) {
  return createImageGeneration({
    id: "image-generation-1",
    workspaceId: "workspace-1",
    brandId: "brand-1",
    contentItemId: "content-1",
    provider: "openai",
    model: "gpt-image-2.5-sunburst",
    prompt: "Create a clearly illustrative editorial graphic of the Mumbai skyline at dusk. No words or logos.",
    visualIntent: "editorial_graphic",
    size: "1024x1536",
    quality: "medium",
    altText: "Illustrated Mumbai skyline at dusk",
    sourceEvidenceIds: ["source-b", "source-a", "source-a"],
    idempotencyKey: "request-1",
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-09-13T08:10:00.000Z",
    actor,
    now,
    ...overrides,
  });
}

describe("image generation domain", () => {
  it("creates immutable disclosure-bearing lineage without putting the prompt in the audit detail", () => {
    const result = generation();
    expect(result.record).toMatchObject({
      status: "generating",
      provider: "openai",
      model: "gpt-image-2.5-sunburst",
      sourceEvidenceIds: ["source-a", "source-b"],
      disclosureRequired: true,
      promptSha256: imageGenerationHash(result.record.prompt),
    });
    expect(result.event.detail).toMatchObject({ generationId: result.record.id, promptSha256: result.record.promptSha256, disclosureRequired: true });
    expect(JSON.stringify(result.event.detail)).not.toContain(result.record.prompt);
  });

  it("replays an identical idempotent request and rejects reuse for another request", async () => {
    const repository = new InMemoryImageGenerationRepository();
    const first = generation();
    await expect(repository.create(first.record, first.event)).resolves.toMatchObject({ created: true });
    await expect(repository.create(generation({ id: "image-generation-2" }).record, generation({ id: "image-generation-2" }).event)).resolves.toMatchObject({ created: false, record: { id: "image-generation-1" } });
    const conflict = generation({ id: "image-generation-3", prompt: "A different illustration", leaseOwner: "worker-3" });
    await expect(repository.create(conflict.record, conflict.event)).rejects.toMatchObject<Partial<DomainError>>({ code: "idempotency_conflict", statusCode: 409 });
  });

  it("only the active lease can complete or fail a paid generation", async () => {
    const repository = new InMemoryImageGenerationRepository();
    const created = generation();
    await repository.create(created.record, created.event);
    const event: AuditEvent = { id: "audit-complete", workspaceId: "workspace-1", contentItemId: "content-1", actorId: "image-generator", actorType: "system", action: "image-generation.completed", detail: {}, createdAt: now };
    await expect(repository.complete({ workspaceId: "workspace-1", id: created.record.id, leaseOwner: "wrong", outputMediaId: "media-1", outputSha256: "a".repeat(64), finishedAt: now, event })).resolves.toBeNull();
    await expect(repository.complete({ workspaceId: "workspace-1", id: created.record.id, leaseOwner: "worker-1", outputMediaId: "media-1", outputSha256: "a".repeat(64), providerRequestId: "req_1", revisedPrompt: "Revised prompt", usage: { totalTokens: 42 }, finishedAt: now, event })).resolves.toMatchObject({ status: "ready", outputMediaId: "media-1", revisedPromptSha256: expect.stringMatching(/^[a-f0-9]{64}$/), usage: { totalTokens: 42 } });
    await expect(repository.fail({ workspaceId: "workspace-1", id: created.record.id, leaseOwner: "worker-1", status: "failed", errorCode: "provider_failed", errorSummary: "late failure", finishedAt: now, event })).resolves.toBeNull();
  });
});
