import { createHash } from "node:crypto";

type MetaIdentity = { id?: unknown };
type MetaMessagingEvent = {
  sender?: MetaIdentity;
  recipient?: MetaIdentity;
  timestamp?: unknown;
  message?: {
    mid?: unknown;
    text?: unknown;
    is_echo?: unknown;
    is_deleted?: unknown;
    attachments?: unknown;
  };
  delivery?: { mids?: unknown; watermark?: unknown };
  read?: { watermark?: unknown };
  reaction?: { mid?: unknown; action?: unknown; reaction?: unknown; emoji?: unknown };
  policy_enforcement?: { action?: unknown; reason?: unknown };
};

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).normalize("NFC").trim();
  return result ? result.slice(0, max) : undefined;
}

function time(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  const result = new Date(milliseconds);
  return Number.isFinite(result.getTime()) ? result.toISOString() : undefined;
}

/**
 * Reduces a signed Meta webhook event to routing/reconciliation metadata.
 * Message bodies, attachment URLs, and the raw payload deliberately stay out
 * of the durable receipt; the worker retrieves current data through Graph.
 */
export function normalizeMetaPrivateWebhookEvent(value: unknown, externalBusinessAccountId: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as MetaMessagingEvent;
  const senderId = text(event.sender?.id, 240);
  const recipientId = text(event.recipient?.id, 240);
  if (!senderId || !recipientId) return null;
  const outgoing = senderId === externalBusinessAccountId;
  const incoming = recipientId === externalBusinessAccountId;
  if (!outgoing && !incoming) return null;
  const participantId = outgoing ? recipientId : senderId;
  const providerSentAt = time(event.timestamp);
  const common = {
    externalBusinessAccountId,
    externalParticipantId: participantId,
    direction: outgoing ? "outgoing" : "incoming",
    ...(providerSentAt ? { providerSentAt } : {}),
  };

  if (event.message && typeof event.message === "object") {
    const externalMessageId = text(event.message.mid, 240);
    if (!externalMessageId) return null;
    const deleted = event.message.is_deleted === true;
    const isEcho = event.message.is_echo === true || outgoing;
    const hasText = typeof event.message.text === "string" && event.message.text.length > 0;
    const attachmentCount = Array.isArray(event.message.attachments) ? Math.min(event.message.attachments.length, 10) : 0;
    return { type: deleted ? "message_deleted" : isEcho ? "message_echo" : "message", ...common, externalMessageId, isEcho, hasText, attachmentCount };
  }
  if (event.delivery && typeof event.delivery === "object") {
    const messageIds = Array.isArray(event.delivery.mids) ? event.delivery.mids.map((id) => text(id, 240)).filter((id): id is string => Boolean(id)).slice(0, 100) : [];
    const watermark = time(event.delivery.watermark);
    if (!messageIds.length && !watermark) return null;
    return { type: "delivery", ...common, messageIds, ...(watermark ? { watermark } : {}) };
  }
  if (event.read && typeof event.read === "object") {
    const watermark = time(event.read.watermark);
    if (!watermark) return null;
    return { type: "read", ...common, watermark };
  }
  if (event.reaction && typeof event.reaction === "object") {
    const externalMessageId = text(event.reaction.mid, 240);
    const action = text(event.reaction.action, 40)?.toLowerCase();
    if (!externalMessageId || (action !== "react" && action !== "unreact")) return null;
    const reaction = text(event.reaction.reaction ?? event.reaction.emoji, 32);
    return { type: "reaction", ...common, externalMessageId, action, ...(reaction ? { reaction } : {}) };
  }
  if (event.policy_enforcement && typeof event.policy_enforcement === "object") {
    return {
      type: "policy_enforcement",
      ...common,
      ...(text(event.policy_enforcement.action, 80) ? { action: text(event.policy_enforcement.action, 80) } : {}),
      ...(text(event.policy_enforcement.reason, 200) ? { reason: text(event.policy_enforcement.reason, 200) } : {}),
    };
  }
  return null;
}

export function metaPrivateWebhookFingerprint(event: Record<string, unknown>, accountId: string, deliveryIndex: string): string {
  return createHash("sha256").update(JSON.stringify({ accountId, deliveryIndex, event })).digest("hex");
}
