import type { PrivateConversationRepository, ProviderLifecycleRepository } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { processProviderDataDeletion } from "../src/provider-data-deletion-worker.js";

const job = { workspaceId: "workspace-1", deletionRequestId: "deletion-1" };

describe("provider data deletion worker", () => {
  it("crypto-shreds private provider data before completing the durable scope", async () => {
    const order: string[] = [];
    const lifecycle = {
      getDataDeletionScope: vi.fn(async () => ({ status: "pending" as const, accountIds: ["account-1"], hasPrivateData: true })),
      processDataDeletionScope: vi.fn(async () => { order.push("complete"); return true; }),
    } as unknown as ProviderLifecycleRepository;
    const privateConversations = {
      eraseProviderData: vi.fn(async () => { order.push("erase"); return { conversations: 1, participants: 2, messages: 3, replyIntents: 1, receipts: 1 }; }),
    } as unknown as PrivateConversationRepository;
    await expect(processProviderDataDeletion(job, { lifecycle, privateConversations })).resolves.toEqual({ skipped: false, deletedPrivateData: 8 });
    expect(order).toEqual(["erase", "complete"]);
  });

  it("fails closed when private data exists but erasure keys are unavailable", async () => {
    const processDataDeletionScope = vi.fn();
    const lifecycle = { getDataDeletionScope: vi.fn(async () => ({ status: "pending" as const, accountIds: ["account-1"], hasPrivateData: true })), processDataDeletionScope } as unknown as ProviderLifecycleRepository;
    await expect(processProviderDataDeletion(job, { lifecycle, privateConversations: null })).rejects.toThrow("erasure keys are unavailable");
    expect(processDataDeletionScope).not.toHaveBeenCalled();
  });

  it("does not repeat a completed scope", async () => {
    const lifecycle = { getDataDeletionScope: vi.fn(async () => ({ status: "completed" as const, accountIds: [], hasPrivateData: false })) } as unknown as ProviderLifecycleRepository;
    await expect(processProviderDataDeletion(job, { lifecycle, privateConversations: null })).resolves.toEqual({ skipped: true });
  });
});
