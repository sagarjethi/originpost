import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ConnectedAccount, EngagementWebhookReceipt, PrivateMessageWebhookReceipt } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { metaPrivateWebhookFingerprint, normalizeMetaPrivateWebhookEvent } from "../private-conversations/meta-private-webhook.js";

type WebhookChange = {
  field?: unknown;
  value?: {
    id?: unknown;
    text?: unknown;
    from?: { id?: unknown; username?: unknown };
    media?: { id?: unknown; media_product_type?: unknown };
    parent_id?: unknown;
    created_time?: unknown;
  };
};

type WebhookEntry = { id?: unknown; time?: unknown; changes?: unknown; messaging?: unknown };

function constantTimeText(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class InstagramWebhookService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly config: ConfigService,
  ) {}

  verify(mode: string | undefined, challenge: string | undefined, token: string | undefined): string {
    const expected = this.config.get<string>("META_WEBHOOK_VERIFY_TOKEN")?.trim();
    if (!expected) throw new ServiceUnavailableException("Instagram webhooks are not configured.");
    if (mode !== "subscribe" || !challenge || !constantTimeText(token, expected)) throw new ForbiddenException("Instagram webhook verification failed.");
    return challenge;
  }

  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ accepted: true; receipts: number }> {
    const secret = this.config.get<string>("META_APP_SECRET")?.trim();
    if (!secret) throw new ServiceUnavailableException("Instagram webhooks are not configured.");
    if (!rawBody || rawBody.length === 0 || rawBody.length > 1_000_000) throw new ForbiddenException("Instagram webhook payload is invalid.");
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (!constantTimeText(signature, expected)) throw new ForbiddenException("Instagram webhook signature is invalid.");
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString("utf8")); }
    catch { throw new ForbiddenException("Instagram webhook payload is invalid."); }
    const body = parsed as { object?: unknown; entry?: unknown };
    if (body.object !== "instagram" || !Array.isArray(body.entry) || body.entry.length > 1_000) return { accepted: true, receipts: 0 };
    let receipts = 0;
    for (const [entryIndex, candidate] of body.entry.entries()) {
      const entry = candidate as WebhookEntry;
      const externalAccountId = typeof entry.id === "string" ? entry.id : typeof entry.id === "number" ? String(entry.id) : undefined;
      if (!externalAccountId) continue;
      const changes = Array.isArray(entry.changes) && entry.changes.length <= 1_000 ? entry.changes as WebhookChange[] : [];
      const account = await this.findUniqueAccount(externalAccountId);
      if (!account) continue;
      for (const [changeIndex, candidateChange] of changes.entries()) {
        const change = candidateChange;
        if (change.field !== "comments" || !change.value) continue;
        const commentId = this.text(change.value.id, 120);
        const externalMediaId = this.text(change.value.media?.id, 120);
        if (!commentId || !externalMediaId) continue;
        const normalizedEvent: Record<string, unknown> = {
          type: "comment",
          externalAccountId,
          externalMediaId,
          externalCommentId: commentId,
          ...(this.text(change.value.parent_id, 120) ? { parentExternalCommentId: this.text(change.value.parent_id, 120) } : {}),
          ...(this.text(change.value.from?.id, 120) ? { authorScopedId: this.text(change.value.from?.id, 120) } : {}),
          ...(this.text(change.value.from?.username, 160) ? { authorUsername: this.text(change.value.from?.username, 160) } : {}),
          ...(this.text(change.value.text, 2_200) ? { body: this.text(change.value.text, 2_200) } : {}),
          ...(this.text(change.value.created_time, 80) ? { providerCreatedAt: this.text(change.value.created_time, 80) } : {}),
          providerSentAt: typeof entry.time === "number" ? new Date(entry.time * 1_000).toISOString() : new Date().toISOString(),
        };
        const now = new Date().toISOString();
        const payloadSha256 = createHash("sha256").update(rawBody).update(`:${entryIndex}:${changeIndex}:${account.id}`).digest("hex");
        const receipt: EngagementWebhookReceipt = {
          id: `engagement_receipt_${crypto.randomUUID()}`,
          provider: "instagram",
          workspaceId: account.workspaceId,
          brandId: account.brandId,
          accountId: account.id,
          payloadSha256,
          normalizedEvent,
          status: "pending",
          attempts: 0,
          availableAt: now,
          createdAt: now,
        };
        const saved = await this.infrastructure.engagementRepository.recordWebhookReceipt(receipt);
        if (saved.created) receipts += 1;
        await this.infrastructure.engagementQueue?.add("process-webhook-receipt", { name: "process-webhook-receipt", receiptId: saved.receipt.id }, {
          jobId: `engagement-webhook-${saved.receipt.id}`,
          attempts: 1,
          removeOnComplete: 500,
          removeOnFail: 1000,
        }).catch((error) => console.error("Instagram webhook receipt is durable but Redis dispatch failed:", error instanceof Error ? error.message : "Unknown error"));
      }
      const messaging = Array.isArray(entry.messaging) && entry.messaging.length <= 1_000 ? entry.messaging : [];
      if (this.infrastructure.privateConversationRepository
        && account.capabilities.includes("private_message_read")
        && account.capabilities.includes("private_message_send")) {
        for (const [eventIndex, event] of messaging.entries()) {
          const normalizedEvent = normalizeMetaPrivateWebhookEvent(event, externalAccountId);
          if (!normalizedEvent) continue;
          const now = new Date().toISOString();
          const receipt: PrivateMessageWebhookReceipt = {
            id: `private_receipt_${crypto.randomUUID()}`,
            provider: "instagram",
            connectionMode: "instagram_linked_page",
            workspaceId: account.workspaceId,
            brandId: account.brandId,
            accountId: account.id,
            payloadSha256: metaPrivateWebhookFingerprint(normalizedEvent, account.id, `instagram:${eventIndex}`),
            normalizedEvent,
            status: "pending",
            attempts: 0,
            availableAt: now,
            createdAt: now,
          };
          const saved = await this.infrastructure.privateConversationRepository.recordWebhookReceipt(receipt);
          if (saved.created) receipts += 1;
          await this.infrastructure.privateConversationQueue?.add("process-webhook-receipt", { name: "process-webhook-receipt", receiptId: saved.receipt.id }, {
            jobId: `private-webhook-${saved.receipt.id}`,
            attempts: 1,
            removeOnComplete: 500,
            removeOnFail: 1_000,
          }).catch((error) => console.error("Instagram private-message receipt is durable but Redis dispatch failed:", error instanceof Error ? error.message : "Unknown error"));
        }
      }
    }
    return { accepted: true, receipts };
  }

  private async findUniqueAccount(externalAccountId: string): Promise<ConnectedAccount | null> {
    const workspaces = await this.infrastructure.organizationRepository.listWorkspaces();
    const matches: ConnectedAccount[] = [];
    for (const workspace of workspaces.slice(0, 1_000)) {
      const accounts = await this.infrastructure.connectedAccountRepository.list(workspace.id);
      matches.push(...accounts.filter((account) => account.platform === "instagram" && account.externalAccountId === externalAccountId && account.status !== "disconnected"));
      if (matches.length > 1) return null;
    }
    return matches.length === 1 ? matches[0]! : null;
  }

  private text(value: unknown, max: number): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const normalized = String(value).normalize("NFC").trim();
    return normalized ? normalized.slice(0, max) : undefined;
  }
}
