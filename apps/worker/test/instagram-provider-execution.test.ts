import { describe, expect, it } from "vitest";
import { InMemoryProviderPublishOperationRepository, type ProviderPublishOperation } from "@originpost/domain";
import { beginInstagramProviderOperation, instagramProviderClaimRetry } from "../src/instagram-provider-execution.js";

function seed(at: string): ProviderPublishOperation & { platform: "instagram"; status: "creating" } {
  return {
    id: "provider-op-1", workspaceId: "workspace-1", contentItemId: "content-1", targetId: "target-1", attemptId: "attempt-1",
    platform: "instagram", status: "creating", containerId: "", childContainerIds: [], createdAt: at, updatedAt: at,
  };
}

describe("Instagram provider execution recovery", () => {
  it("serializes concurrent recovered jobs before the first provider write", async () => {
    const at = "2026-09-01T10:00:00.000Z";
    const repository = new InMemoryProviderPublishOperationRepository(() => new Date(at));
    let createCalls = 0;
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const createOperation = async () => { createCalls += 1; await gate; return { containerId: "container-1", childContainerIds: [] }; };

    const first = beginInstagramProviderOperation({ repository, seed: seed(at), owner: "worker-a", createOperation });
    await Promise.resolve();
    const second = await beginInstagramProviderOperation({ repository, seed: seed(at), owner: "worker-b", createOperation });
    expect(second.kind).toBe("busy");
    expect(createCalls).toBe(1);
    releaseCreate();
    await expect(first).resolves.toMatchObject({ kind: "claimed", created: true, operation: { status: "processing", containerId: "container-1" } });
  });

  it("turns a stale pre-write crash into manual reconciliation without another create", async () => {
    let now = new Date("2026-09-01T10:00:00.000Z");
    const repository = new InMemoryProviderPublishOperationRepository(() => now);
    await repository.claimExecution(seed(now.toISOString()), "crashed-worker", 60);
    now = new Date("2026-09-01T10:01:01.000Z");
    let createCalls = 0;
    const recovered = await beginInstagramProviderOperation({
      repository,
      seed: seed(now.toISOString()),
      owner: "recovery-worker",
      createOperation: async () => { createCalls += 1; return { containerId: "must-not-exist", childContainerIds: [] }; },
    });

    expect(recovered).toMatchObject({ kind: "manual-reconcile", operation: { status: "uncertain", containerId: "" } });
    expect(createCalls).toBe(0);
    await expect(repository.get("workspace-1", "target-1")).resolves.toMatchObject({ status: "uncertain" });
  });

  it("keeps an immediate restart write-free and schedules a deterministic retry after lease expiry", async () => {
    let now = new Date("2026-09-01T10:00:00.000Z");
    const repository = new InMemoryProviderPublishOperationRepository(() => now);
    await repository.claimExecution(seed(now.toISOString()), "crashed-worker", 60);
    let createCalls = 0;
    const createOperation = async () => { createCalls += 1; return { containerId: "must-not-exist", childContainerIds: [] }; };

    now = new Date("2026-09-01T10:00:10.000Z");
    const immediate = await beginInstagramProviderOperation({ repository, seed: seed(now.toISOString()), owner: "restart-worker", createOperation });
    expect(immediate.kind).toBe("busy");
    expect(createCalls).toBe(0);
    const retry = instagramProviderClaimRetry(immediate.operation, now.getTime());
    expect(retry).toEqual({
      jobId: "target-1-provider-claim-1788256861000-59608560",
      delayMs: 51_000,
      retryAt: "2026-09-01T10:01:01.000Z",
    });
    expect(instagramProviderClaimRetry(immediate.operation, now.getTime())).toEqual(retry);

    now = new Date(retry.retryAt);
    const recovered = await beginInstagramProviderOperation({ repository, seed: seed(now.toISOString()), owner: "retry-worker", createOperation });
    expect(recovered).toMatchObject({ kind: "manual-reconcile", operation: { status: "uncertain" } });
    expect(createCalls).toBe(0);
  });

  it("does not replay a create whose transport result was ambiguous", async () => {
    let now = new Date("2026-09-01T10:00:00.000Z");
    const repository = new InMemoryProviderPublishOperationRepository(() => now);
    let createCalls = 0;
    const first = await beginInstagramProviderOperation({
      repository,
      seed: seed(now.toISOString()),
      owner: "worker-a",
      createOperation: async () => { createCalls += 1; throw new Error("timeout after request write"); },
    });
    expect(first).toMatchObject({ kind: "manual-reconcile", operation: { status: "uncertain" } });

    now = new Date("2026-09-01T10:16:00.000Z");
    const recovered = await beginInstagramProviderOperation({
      repository,
      seed: seed(now.toISOString()),
      owner: "worker-b",
      createOperation: async () => { createCalls += 1; return { containerId: "duplicate", childContainerIds: [] }; },
    });
    expect(recovered).toMatchObject({ kind: "claimed", created: false, operation: { status: "uncertain" } });
    expect(createCalls).toBe(1);
  });
});
