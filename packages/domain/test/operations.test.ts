import { describe, expect, it } from "vitest";
import { InMemoryOperationalIncidentRepository } from "../src/operations.js";

describe("operational incident lifecycle", () => {
  it("opens, changes, resolves, and safely reopens one workspace check", async () => {
    const repository = new InMemoryOperationalIncidentRepository();
    const base = { workspaceId: "workspace-one", checkId: "webhook_delivery" as const };
    const opened = await repository.observe({ ...base, status: "error", fingerprint: "a".repeat(64), observedAt: "2026-09-08T10:00:00.000Z" });
    expect(opened.transition).toBe("opened");
    await expect(repository.observe({ ...base, status: "error", fingerprint: "a".repeat(64), observedAt: "2026-09-08T10:05:00.000Z" })).resolves.toMatchObject({ transition: "unchanged" });
    await expect(repository.observe({ ...base, status: "warning", fingerprint: "b".repeat(64), observedAt: "2026-09-08T10:10:00.000Z" })).resolves.toMatchObject({ transition: "changed" });
    await expect(repository.observe({ ...base, observedAt: "2026-09-08T10:15:00.000Z" })).resolves.toMatchObject({ transition: "resolved", incident: { resolvedAt: "2026-09-08T10:15:00.000Z" } });
    const reopened = await repository.observe({ ...base, status: "error", fingerprint: "a".repeat(64), observedAt: "2026-09-08T11:00:00.000Z" });
    expect(reopened).toMatchObject({ transition: "opened", incident: { openedAt: "2026-09-08T11:00:00.000Z" } });
  });

  it("isolates equal check identifiers between workspaces", async () => {
    const repository = new InMemoryOperationalIncidentRepository();
    await repository.observe({ workspaceId: "one", checkId: "media_cleanup", status: "error", fingerprint: "c".repeat(64), observedAt: "2026-09-08T10:00:00.000Z" });
    await expect(repository.observe({ workspaceId: "two", checkId: "media_cleanup", observedAt: "2026-09-08T10:01:00.000Z" })).resolves.toEqual({ transition: "already_resolved", incident: null });
  });
});
