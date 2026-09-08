import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ConnectedAccount, EngagementCommentVisibility, EngagementWebhookReceipt, PrivateMessageWebhookReceipt } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import { metaPrivateWebhookFingerprint, normalizeMetaPrivateWebhookEvent } from "../private-conversations/meta-private-webhook.js";

type FacebookFeedValue = {
  from?: { id?: unknown; name?: unknown };
  item?: unknown;
  verb?: unknown;
  post_id?: unknown;
  comment_id?: unknown;
  parent_id?: unknown;
  message?: unknown;
  created_time?: unknown;
  is_hidden?: unknown;
};

type FacebookChange = { field?: unknown; value?: FacebookFeedValue };
type FacebookEntry = { id?: unknown; time?: unknown; changes?: unknown; messaging?: unknown };

const commentVerbs = new Set(["add", "edit", "edited", "delete", "hide", "remove", "unhide"]);

function constantTimeText(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function visibilityFor(verb: string, isHidden: unknown): EngagementCommentVisibility {
  if (verb === "delete" || verb === "remove") return "deleted";
  if (verb === "hide" || isHidden === true) return "hidden";
  return "visible";
}

@Injectable()
export class FacebookWebhookService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly config: ConfigService,
  ) {}

  verify(mode: string | undefined, challenge: string | undefined, token: string | undefined): string {
    const expected = this.config.get<string>("META_FACEBOOK_WEBHOOK_VERIFY_TOKEN")?.trim() || this.config.get<string>("META_WEBHOOK_VERIFY_TOKEN")?.trim();
    if (!expected) throw new ServiceUnavailableException("Facebook Page webhooks are not configured.");
    if (mode !== "subscribe" || !challenge || !constantTimeText(token, expected)) throw new ForbiddenException("Facebook Page webhook verification failed.");
    return challenge;
  }

  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ accepted: true; receipts: number }> {
    const secret = this.config.get<string>("META_APP_SECRET")?.trim();
    if (!secret) throw new ServiceUnavailableException("Facebook Page webhooks are not configured.");
    if (!rawBody || rawBody.length === 0 || rawBody.length > 1_000_000) throw new ForbiddenException("Facebook Page webhook payload is invalid.");
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (!constantTimeText(signature, expected)) throw new ForbiddenException("Facebook Page webhook signature is invalid.");

    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString("utf8")); }
    catch { throw new ForbiddenException("Facebook Page webhook payload is invalid."); }
    const body = parsed as { object?: unknown; entry?: unknown };
    if (body.object !== "page" || !Array.isArray(body.entry) || body.entry.length > 1_000) return { accepted: true, receipts: 0 };

    let receipts = 0;
    for (const candidate of body.entry) {
      const entry = candidate as FacebookEntry;
      const externalAccountId = this.text(entry.id, 120);
      if (!externalAccountId) continue;
      const changes = Array.isArray(entry.changes) && entry.changes.length <= 1_000 ? entry.changes as FacebookChange[] : [];
      const messaging = Array.isArray(entry.messaging) && entry.messaging.length <= 1_000 ? entry.messaging : [];
      const account = await this.findUniqueAccount(externalAccountId);
      if (!account) continue;

      for (const candidateChange of changes) {
        const change = candidateChange;
        if (change.field !== "feed" || !change.value || change.value.item !== "comment") continue;
        const verb = this.text(change.value.verb, 20)?.toLowerCase();
        const externalMediaId = this.text(change.value.post_id, 160);
        const externalCommentId = this.text(change.value.comment_id, 160);
        if (!verb || !commentVerbs.has(verb) || !externalMediaId || !externalCommentId) continue;

        const providerCreatedAt = this.providerTime(change.value.created_time);
        const providerSentAt = this.providerTime(entry.time);
        const message = this.text(change.value.message, 63_206);
        const normalizedEvent: Record<string, unknown> = {
          type: "comment",
          verb,
          visibility: visibilityFor(verb, change.value.is_hidden),
          externalAccountId,
          externalMediaId,
          externalCommentId,
          ...(this.text(change.value.parent_id, 160) ? { parentExternalCommentId: this.text(change.value.parent_id, 160) } : {}),
          ...(this.text(change.value.from?.id, 160) ? { authorScopedId: this.text(change.value.from?.id, 160) } : {}),
          ...(this.text(change.value.from?.name, 200) ? { authorUsername: this.text(change.value.from?.name, 200) } : {}),
          ...(message ? { body: message } : {}),
          ...(providerCreatedAt ? { providerCreatedAt } : {}),
          ...(providerSentAt ? { providerSentAt } : {}),
        };
        const fingerprint = {
          accountId: account.id,
          externalAccountId,
          externalMediaId,
          externalCommentId,
          verb,
          parentExternalCommentId: normalizedEvent.parentExternalCommentId ?? null,
          authorScopedId: normalizedEvent.authorScopedId ?? null,
          bodySha256: message ? createHash("sha256").update(message).digest("hex") : null,
          providerCreatedAt: providerCreatedAt ?? null,
          providerSentAt: providerSentAt ?? null,
          visibility: normalizedEvent.visibility,
        };
        const now = new Date().toISOString();
        const receipt: EngagementWebhookReceipt = {
          id: `engagement_receipt_${crypto.randomUUID()}`,
          provider: "facebook",
          workspaceId: account.workspaceId,
          brandId: account.brandId,
          accountId: account.id,
          payloadSha256: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
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
          removeOnFail: 1_000,
        }).catch((error) => console.error("Facebook Page webhook receipt is durable but Redis dispatch failed:", error instanceof Error ? error.message : "Unknown error"));
      }
      if (this.infrastructure.privateConversationRepository
        && account.capabilities.includes("private_message_read")
        && account.capabilities.includes("private_message_send")) {
        for (const [eventIndex, event] of messaging.entries()) {
          const normalizedEvent = normalizeMetaPrivateWebhookEvent(event, externalAccountId);
          if (!normalizedEvent) continue;
          const now = new Date().toISOString();
          const receipt: PrivateMessageWebhookReceipt = {
            id: `private_receipt_${crypto.randomUUID()}`,
            provider: "facebook",
            connectionMode: "facebook_page_messenger",
            workspaceId: account.workspaceId,
            brandId: account.brandId,
            accountId: account.id,
            payloadSha256: metaPrivateWebhookFingerprint(normalizedEvent, account.id, `facebook:${eventIndex}`),
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
          }).catch((error) => console.error("Facebook Page private-message receipt is durable but Redis dispatch failed:", error instanceof Error ? error.message : "Unknown error"));
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
      matches.push(...accounts.filter((account) => account.platform === "facebook" && account.externalAccountId === externalAccountId && account.status !== "disconnected"));
      if (matches.length > 1) return null;
    }
    return matches.length === 1 ? matches[0]! : null;
  }

  private text(value: unknown, max: number): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const normalized = String(value).normalize("NFC").trim();
    return normalized ? normalized.slice(0, max) : undefined;
  }

  private providerTime(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value * 1_000).toISOString();
    if (typeof value !== "string") return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
}
