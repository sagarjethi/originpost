import "reflect-metadata";
import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import type { ConnectedAccount, EngagementWebhookReceipt, PrivateMessageWebhookReceipt } from "@originpost/domain";
import { describe, expect, it, vi } from "vitest";
import { FacebookWebhookService } from "../src/engagement/facebook-webhook.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

function fixture(facebookToken = "facebook-token", privateMessaging = false) {
  const account: ConnectedAccount = {
    id: "facebook-account-1",
    workspaceId: "workspace-1",
    brandId: "brand-1",
    platform: "facebook",
    displayName: "News Page",
    externalAccountId: "page-123",
    capabilities: ["profile_read", "comment_read", "comment_reply", ...(privateMessaging ? ["private_message_read", "private_message_send"] as const : [])],
    status: "healthy",
    createdBy: "owner-1",
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
  };
  const stored = new Map<string, EngagementWebhookReceipt>();
  const privateStored = new Map<string, PrivateMessageWebhookReceipt>();
  const add = vi.fn(async () => ({ id: "queued" }));
  const privateAdd = vi.fn(async () => ({ id: "queued" }));
  const infrastructure = {
    organizationRepository: { listWorkspaces: vi.fn(async () => [{ id: "workspace-1" }]) },
    connectedAccountRepository: { list: vi.fn(async () => [account]) },
    engagementRepository: {
      recordWebhookReceipt: vi.fn(async (receipt: EngagementWebhookReceipt) => {
        const existing = stored.get(receipt.payloadSha256);
        if (existing) return { receipt: existing, created: false };
        stored.set(receipt.payloadSha256, receipt);
        return { receipt, created: true };
      }),
    },
    engagementQueue: { add },
    privateConversationRepository: privateMessaging ? {
      recordWebhookReceipt: vi.fn(async (receipt: PrivateMessageWebhookReceipt) => {
        const existing = privateStored.get(receipt.payloadSha256);
        if (existing) return { receipt: existing, created: false };
        privateStored.set(receipt.payloadSha256, receipt);
        return { receipt, created: true };
      }),
    } : null,
    privateConversationQueue: privateMessaging ? { add: privateAdd } : null,
  } as unknown as OriginPostInfrastructure;
  const service = new FacebookWebhookService(infrastructure, new ConfigService({
    META_APP_SECRET: "facebook-test-secret",
    META_WEBHOOK_VERIFY_TOKEN: "common-token",
    META_FACEBOOK_WEBHOOK_VERIFY_TOKEN: facebookToken,
  }));
  return { service, stored, privateStored, add, privateAdd };
}

describe("Facebook Page engagement webhook", () => {
  it("uses the Facebook challenge token and rejects a bad signature", async () => {
    const { service } = fixture();
    expect(service.verify("subscribe", "challenge-1", "facebook-token")).toBe("challenge-1");
    expect(() => service.verify("subscribe", "challenge-1", "common-token")).toThrow("verification failed");
    expect(fixture("").service.verify("subscribe", "challenge-2", "common-token")).toBe("challenge-2");
    await expect(service.receive(Buffer.from("{}"), "sha256=bad")).rejects.toMatchObject({ status: 403 });
  });

  it("persists and queues one deduplicated Page feed comment receipt", async () => {
    const { service, stored, add } = fixture();
    const payload = JSON.stringify({
      object: "page",
      entry: [{
        id: "page-123",
        time: 1787997600,
        changes: [{
          field: "feed",
          value: {
            item: "comment",
            verb: "add",
            post_id: "page-123_post-456",
            comment_id: "comment-789",
            parent_id: "parent-1",
            from: { id: "reader-1", name: "Reader One" },
            message: "Please share the source.",
            created_time: 1787997590,
            is_hidden: false,
          },
        }],
      }],
    });
    const raw = Buffer.from(payload);
    const signature = `sha256=${createHmac("sha256", "facebook-test-secret").update(raw).digest("hex")}`;

    await expect(service.receive(raw, signature)).resolves.toEqual({ accepted: true, receipts: 1 });
    await expect(service.receive(raw, signature)).resolves.toEqual({ accepted: true, receipts: 0 });

    expect(stored.size).toBe(1);
    expect([...stored.values()][0]).toMatchObject({
      provider: "facebook",
      accountId: "facebook-account-1",
      normalizedEvent: {
        type: "comment",
        verb: "add",
        visibility: "visible",
        externalMediaId: "page-123_post-456",
        externalCommentId: "comment-789",
        parentExternalCommentId: "parent-1",
        authorUsername: "Reader One",
      },
    });
    // A duplicate delivery also nudges durable pending work in case the first Redis dispatch was lost.
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith("process-webhook-receipt", expect.objectContaining({ receiptId: expect.stringContaining("engagement_receipt_") }), expect.objectContaining({ attempts: 1 }));
  });

  it("maps Facebook hide and delete verbs without treating unrelated feed events as comments", async () => {
    const { service, stored } = fixture();
    const payload = JSON.stringify({ object: "page", entry: [{ id: "page-123", time: 1787997600, changes: [
      { field: "feed", value: { item: "comment", verb: "hide", post_id: "post-1", comment_id: "comment-1", is_hidden: true } },
      { field: "feed", value: { item: "comment", verb: "delete", post_id: "post-1", comment_id: "comment-2" } },
      { field: "feed", value: { item: "post", verb: "add", post_id: "post-2" } },
    ] }] });
    const raw = Buffer.from(payload);
    const signature = `sha256=${createHmac("sha256", "facebook-test-secret").update(raw).digest("hex")}`;

    await expect(service.receive(raw, signature)).resolves.toEqual({ accepted: true, receipts: 2 });
    expect([...stored.values()].map((receipt) => receipt.normalizedEvent.visibility)).toEqual(["hidden", "deleted"]);
  });

  it("durably routes Messenger events without storing private body or attachment URLs", async () => {
    const { service, privateStored, privateAdd } = fixture("facebook-token", true);
    const payload = JSON.stringify({ object: "page", entry: [{ id: "page-123", time: 1787997600, messaging: [{
      sender: { id: "reader-1" }, recipient: { id: "page-123" }, timestamp: 1787997590000,
      message: { mid: "message-1", text: "private secret", attachments: [{ type: "image", payload: { url: "https://secret.example/image.jpg" } }] },
    }] }] });
    const raw = Buffer.from(payload);
    const signature = `sha256=${createHmac("sha256", "facebook-test-secret").update(raw).digest("hex")}`;

    await expect(service.receive(raw, signature)).resolves.toEqual({ accepted: true, receipts: 1 });
    await expect(service.receive(raw, signature)).resolves.toEqual({ accepted: true, receipts: 0 });
    const receipt = [...privateStored.values()][0]!;
    expect(receipt).toMatchObject({ provider: "facebook", connectionMode: "facebook_page_messenger", accountId: "facebook-account-1", normalizedEvent: { type: "message", externalMessageId: "message-1", externalParticipantId: "reader-1", hasText: true, attachmentCount: 1 } });
    expect(JSON.stringify(receipt)).not.toContain("private secret");
    expect(JSON.stringify(receipt)).not.toContain("secret.example");
    expect(privateAdd).toHaveBeenCalledTimes(2);
  });
});
