import { describe, expect, it } from "vitest";
import { createNotification, InMemoryNotificationRepository } from "../src/index.js";

describe("workspace notifications", () => {
  it("deduplicates notifications and keeps read state workspace-scoped", async () => {
    const repository = new InMemoryNotificationRepository();
    const first = createNotification({ workspaceId: "one", kind: "publish_failed", severity: "error", title: "Publish failed", body: "Open the post and retry.", dedupeKey: "target:1:failed", now: "2026-08-29T10:00:00.000Z" });
    const duplicate = createNotification({ workspaceId: "one", kind: "publish_failed", severity: "error", title: "Another title", body: "Duplicate", dedupeKey: "target:1:failed", now: "2026-08-29T10:01:00.000Z" });
    await repository.create(first);
    await expect(repository.create(duplicate)).resolves.toMatchObject({ id: first.id, title: first.title });
    await repository.create(createNotification({ workspaceId: "two", kind: "system", severity: "info", title: "Other", body: "Another workspace", dedupeKey: "target:1:failed" }));

    await expect(repository.countUnread("one")).resolves.toBe(1);
    await expect(repository.markRead("two", first.id, "actor", "2026-08-29T10:02:00.000Z")).resolves.toBeNull();
    await expect(repository.markRead("one", first.id, "actor", "2026-08-29T10:02:00.000Z")).resolves.toMatchObject({ readBy: "actor" });
    await expect(repository.list("one", { unreadOnly: true })).resolves.toEqual([]);
  });
});
