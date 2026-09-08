import { describe, expect, it } from "vitest";
import { addSource, createContentItem, createOutboxMessage, InMemoryContentItemRepository, InMemoryOutboxRepository, type Actor } from "../src/index.js";

const owner: Actor = { id: "owner", name: "Owner", role: "owner" };

describe("transactional outbox", () => {
  it("rejects a stale Content Item instead of overwriting a newer change", async () => {
    const repository = new InMemoryContentItemRepository();
    const created = createContentItem({ workspaceId: "ws-1", title: "Concurrent edit", actor: owner, now: "2026-08-29T10:00:00.000Z" });
    await repository.commit(created.item, created.event);
    const firstCopy = await repository.get("ws-1", created.item.id);
    const secondCopy = await repository.get("ws-1", created.item.id);
    const first = addSource(firstCopy!, { kind: "url", title: "First source", url: "https://example.com/first", rights: "reference-only", confidence: 90 }, owner);
    const stale = addSource(secondCopy!, { kind: "url", title: "Stale source", url: "https://example.com/stale", rights: "reference-only", confidence: 90 }, owner);

    await repository.commit(first.item, first.event);
    await expect(repository.commit(stale.item, stale.event)).rejects.toMatchObject({ code: "content_version_conflict", statusCode: 409 });

    const saved = await repository.get("ws-1", created.item.id);
    expect(saved).toMatchObject({ version: 2, sources: [expect.objectContaining({ title: "First source" })] });
    expect(await repository.listAudit("ws-1", created.item.id)).toHaveLength(2);
  });

  it("stores a command with the state change and dispatches it once", async () => {
    const outbox = new InMemoryOutboxRepository();
    const repository = new InMemoryContentItemRepository(outbox);
    const created = createContentItem({ workspaceId: "ws-1", title: "Scheduled story", actor: owner, now: "2026-08-28T10:00:00.000Z" });
    const message = createOutboxMessage({ workspaceId: "ws-1", topic: "publish.target.requested", dedupeKey: "publish-target:target-1", payload: { targetId: "target-1" }, now: "2026-08-28T10:00:00.000Z" });

    await repository.commit(created.item, created.event, [message, { ...message, id: "duplicate-id" }]);
    const claimed = await outbox.claimAvailable("worker-1", 10, 30);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ dedupeKey: "publish-target:target-1", status: "processing", attempts: 1 });
    await outbox.complete("ws-1", claimed[0]!.id);
    expect(await outbox.claimAvailable("worker-2")).toHaveLength(0);
    expect(await outbox.stats("ws-1")).toMatchObject({ processed: 1, pending: 0, failed: 0 });
  });

  it("reclaims an explicitly failed message after its retry time", async () => {
    const outbox = new InMemoryOutboxRepository();
    const message = createOutboxMessage({ workspaceId: "ws-1", topic: "publish.target.requested", dedupeKey: "publish-target:target-2", payload: {}, now: "2026-08-28T10:00:00.000Z" });
    outbox.append([message]);
    const [first] = await outbox.claimAvailable("worker-1");
    await outbox.fail("ws-1", first!.id, "Redis unavailable", "2026-08-28T10:00:01.000Z");
    const [retry] = await outbox.claimAvailable("worker-2");
    expect(retry).toMatchObject({ id: first!.id, attempts: 2, status: "processing" });
  });

  it("lets an operator retry a terminally failed message", async () => {
    const outbox = new InMemoryOutboxRepository();
    const message = createOutboxMessage({ workspaceId: "ws-1", topic: "publish.target.requested", dedupeKey: "publish-target:target-3", payload: {}, now: "2026-08-28T10:00:00.000Z" });
    outbox.append([message]);
    const [first] = await outbox.claimAvailable("worker-1");
    await outbox.fail("ws-1", first!.id, "Queue unavailable", "2026-08-28T10:00:01.000Z", 1);

    expect(await outbox.stats("ws-1")).toMatchObject({ failed: 1, pending: 0 });
    expect(await outbox.retry("ws-1", first!.id)).toBe(true);

    const [retried] = await outbox.claimAvailable("worker-2");
    expect(retried).toMatchObject({ id: first!.id, attempts: 1, status: "processing" });
  });
});
