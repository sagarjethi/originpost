import { describe, expect, it } from "vitest";
import { InMemoryProviderPublishOperationRepository, type ProviderPublishOperation } from "../src/index.js";

describe("provider publish operation repository", () => {
  it("keeps one target operation workspace-scoped and durable across state changes", async () => {
    const repository = new InMemoryProviderPublishOperationRepository();
    const operation: ProviderPublishOperation = { id: "provider-op-1", workspaceId: "workspace-a", contentItemId: "content-1", targetId: "target-1", attemptId: "attempt-1", platform: "instagram", status: "processing", containerId: "container-1", childContainerIds: ["child-1"], createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" };
    await repository.save(operation);
    await expect(repository.get("workspace-b", "target-1")).resolves.toBeNull();
    await repository.save({ ...operation, status: "finalizing", updatedAt: "2026-08-29T00:01:00.000Z" });
    await expect(repository.get("workspace-a", "target-1")).resolves.toMatchObject({ status: "finalizing", containerId: "container-1", childContainerIds: ["child-1"] });
  });

  it("allows only one execution claim and fences a worker after its lease expires", async () => {
    let now = new Date("2026-09-01T10:00:00.000Z");
    const repository = new InMemoryProviderPublishOperationRepository(() => now);
    const seed: ProviderPublishOperation = { id: "provider-op-claim", workspaceId: "workspace-a", contentItemId: "content-1", targetId: "target-claim", attemptId: "attempt-1", platform: "instagram", status: "creating", containerId: "", childContainerIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() };

    const [first, second] = await Promise.all([
      repository.claimExecution(seed, "worker-a", 60),
      repository.claimExecution(seed, "worker-b", 60),
    ]);
    expect([first, second].filter((claim) => claim.claimed)).toHaveLength(1);
    expect([first, second].filter((claim) => claim.created)).toHaveLength(1);

    now = new Date("2026-09-01T10:01:01.000Z");
    const replacement = await repository.claimExecution(seed, "worker-b", 60);
    expect(replacement).toMatchObject({ claimed: true, created: false, operation: { status: "creating", claimOwner: "worker-b" } });
    await expect(repository.saveClaimed({ ...replacement.operation, status: "processing", containerId: "container-b" }, "worker-a", 60)).resolves.toBe(false);
    await expect(repository.saveClaimed({ ...replacement.operation, status: "uncertain" }, "worker-b", 60)).resolves.toBe(true);
  });
});
