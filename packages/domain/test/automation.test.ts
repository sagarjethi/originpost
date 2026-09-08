import { describe, expect, it } from "vitest";
import { InMemoryAutomationRepository, type AutomationApiKey, type AutomationWebhookSubscription } from "../src/index.js";

const now = "2026-08-29T10:00:00.000Z";

describe("automation gateway contracts", () => {
  it("authenticates only active keys and revokes immediately", async () => {
    const repository = new InMemoryAutomationRepository();
    const key: AutomationApiKey = { id: "api_key_1", workspaceId: "workspace-a", name: "n8n", keyPrefix: "op_live_test", secretHash: "a".repeat(64), scopes: ["content:write"], brandIds: ["brand-a"], accountIds: [], createdBy: "owner", createdAt: now };
    await repository.saveApiKey(key, { id: "audit-1", workspaceId: "workspace-a", actorId: "owner", actorType: "human", action: "automation.api-key-created", detail: {}, createdAt: now });
    expect(await repository.authenticateApiKey(key.secretHash, now)).toMatchObject({ id: key.id });
    await repository.revokeApiKey("workspace-a", key.id, "2026-08-29T10:01:00.000Z", { id: "audit-2", workspaceId: "workspace-a", actorId: "owner", actorType: "human", action: "automation.api-key-revoked", detail: {}, createdAt: now });
    expect(await repository.authenticateApiKey(key.secretHash, "2026-08-29T10:02:00.000Z")).toBeNull();
  });

  it("creates one scoped delivery per immutable lifecycle event and fences the lease", async () => {
    const repository = new InMemoryAutomationRepository();
    const subscription: AutomationWebhookSubscription = { id: "webhook-1", workspaceId: "workspace-a", name: "n8n", url: "https://example.com/hook", topics: ["content.created"], brandIds: ["brand-a"], secret: { keyVersion: "v1", algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" }, active: true, createdBy: "owner", createdAt: now, updatedAt: now };
    await repository.saveSubscription(subscription, { id: "audit-1", workspaceId: "workspace-a", actorId: "owner", actorType: "human", action: "automation.webhook-created", detail: {}, createdAt: now });
    const audit = { id: "evt-content", workspaceId: "workspace-a", contentItemId: "content-1", actorId: "api_key:key-1", actorType: "api_key" as const, action: "content.created", detail: { brandId: "brand-a", contentVersion: 1 }, createdAt: now };
    await repository.recordEventFromAudit(audit, "brand-a"); await repository.recordEventFromAudit(audit, "brand-a");
    expect(await repository.listEvents("workspace-a")).toHaveLength(1); expect(await repository.listDeliveries("workspace-a")).toHaveLength(1);
    const claimed = await repository.claimDeliveries("worker-a", now, 10, 60); expect(claimed).toHaveLength(1); expect(claimed[0]).toMatchObject({ status: "processing", attempts: 1, leaseOwner: "worker-a" });
    await repository.completeDelivery(claimed[0]!.id, "stale-worker", 200, "hash", now); expect((await repository.listDeliveries("workspace-a"))[0]?.status).toBe("processing");
    await repository.completeDelivery(claimed[0]!.id, "worker-a", 200, "hash", now); expect((await repository.listDeliveries("workspace-a"))[0]).toMatchObject({ status: "delivered", responseStatus: 200 });
  });

  it("dead-letters outstanding deliveries when a webhook is disabled", async () => {
    const repository = new InMemoryAutomationRepository();
    const subscription: AutomationWebhookSubscription = { id: "webhook-disable", workspaceId: "workspace-a", name: "n8n", url: "https://example.com/hook", topics: ["system.test"], brandIds: [], secret: { keyVersion: "v1", algorithm: "aes-256-gcm", iv: "iv", authTag: "tag", ciphertext: "cipher" }, active: true, createdBy: "owner", createdAt: now, updatedAt: now };
    await repository.saveSubscription(subscription, { id: "audit-create", workspaceId: "workspace-a", actorId: "owner", actorType: "human", action: "automation.webhook-created", detail: {}, createdAt: now });
    await repository.recordEvent({ id: "test-event", workspaceId: "workspace-a", topic: "system.test", occurredAt: now, actorType: "human", payload: {} });
    await repository.disableSubscription("workspace-a", subscription.id, "2026-08-29T10:01:00.000Z", { id: "audit-disable", workspaceId: "workspace-a", actorId: "owner", actorType: "human", action: "automation.webhook-disabled", detail: {}, createdAt: now });
    expect((await repository.listDeliveries("workspace-a"))[0]).toMatchObject({ status: "dead_letter", lastError: "Webhook subscription disabled." });
    expect(await repository.claimDeliveries("worker", "2026-08-29T10:02:00.000Z")).toHaveLength(0);
  });
});
