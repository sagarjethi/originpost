export type PrivatePlatform = "instagram" | "facebook";
export type PrivateConnectionMode = "facebook_page_messenger" | "instagram_linked_page" | "instagram_login";
export type PrivateAttentionFilter = "all" | "unread" | "needs_reply" | "mine" | "resolved";
export type PrivatePlatformFilter = "all" | PrivatePlatform;
export type PrivateReplyStatus = "draft" | "pending_approval" | "queued" | "processing" | "succeeded" | "failed" | "uncertain" | "cancelled" | "expired";
export type PrivateEligibilityReason = "window_closed" | "permission_missing" | "account_disconnected" | "conversation_closed" | "provider_restricted" | "contract_unverified" | "provider_unavailable";

export type PrivateEligibility = {
  state: "eligible" | "ineligible" | "unknown";
  checkedAt: string;
  expiresAt?: string;
  reason?: PrivateEligibilityReason;
  contractVersion?: string;
};

export type PrivateAttachment = {
  id?: string;
  kind?: "image" | "video" | "audio" | "file" | "share" | "sticker" | "unsupported" | string;
  type?: string;
  mimeType?: string;
  sizeBytes?: number;
  byteSize?: number;
  availability?: "available" | "expired" | "deleted" | "unsupported" | "not_imported" | "removed" | string;
};

export type PrivateMessage = {
  id: string;
  direction: "incoming" | "outgoing";
  kind: "text" | "image" | "video" | "audio" | "file" | "share" | "sticker" | "unsupported" | string;
  body?: string;
  attachments?: PrivateAttachment[];
  availability?: "available" | "deleted" | "expired" | "removed" | "unsent" | string;
  providerCreatedAt?: string;
  firstSeenAt: string;
  source?: "webhook" | "reconcile" | "action" | string;
};

export type PrivateParticipant = {
  id?: string;
  displayName?: string;
  username?: string;
  role?: "business" | "customer" | "unknown" | string;
};

export type PrivateConversation = {
  id: string;
  accountId: string;
  accountName?: string;
  platform: PrivatePlatform;
  connectionMode: PrivateConnectionMode;
  state: "open" | "resolved";
  assignedTo?: string;
  lastActivityAt: string;
  lastSyncedAt?: string;
  version: number;
};

export type PrivateReplyIntent = {
  id: string;
  inReplyToMessageId: string;
  body: string;
  status: PrivateReplyStatus;
  requestedBy: string;
  approvedBy?: string;
  providerAcceptedAt?: string;
  providerEvidenceAvailable?: boolean;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type PrivateConversationSummary = {
  conversation: PrivateConversation;
  participants?: PrivateParticipant[];
  participant?: PrivateParticipant;
  latestMessage?: PrivateMessage;
  unreadCount: number;
  needsReply: boolean;
  replyEligibility: PrivateEligibility;
  eligibility?: PrivateEligibility;
};

export type PrivateConversationView = {
  conversation: PrivateConversation;
  participants?: PrivateParticipant[];
  participant?: PrivateParticipant;
  messages: PrivateMessage[];
  replyIntents: PrivateReplyIntent[];
  replyEligibility: PrivateEligibility;
  eligibility?: PrivateEligibility;
};

export type PrivateInboxAvailability = {
  state: "ready" | "no_account" | "permission_missing" | "account_disconnected" | "contract_unverified" | "provider_unavailable" | "rate_limited" | "forbidden";
  detail?: string;
  nextCheckAt?: string;
};

export type PrivateInboxResponse = {
  items: PrivateConversationSummary[];
  nextCursor?: string;
  availability?: PrivateInboxAvailability;
};

export type PrivateEligibilityPresentation = {
  canReply: boolean;
  tone: "ready" | "attention" | "blocked";
  label: string;
  detail: string;
  remainingMs?: number;
};

const reasonCopy: Record<PrivateEligibilityReason, { label: string; detail: string }> = {
  window_closed: { label: "Reply window closed", detail: "The provider no longer allows a reply to this conversation." },
  permission_missing: { label: "Permission missing", detail: "Reconnect this account in Channels with private messaging access." },
  account_disconnected: { label: "Account disconnected", detail: "Reconnect this account in Channels before preparing a reply." },
  conversation_closed: { label: "Conversation closed", detail: "Reopen the conversation before preparing another reply." },
  provider_restricted: { label: "Provider restricted", detail: "The provider is not allowing a reply to this conversation." },
  contract_unverified: { label: "Messaging contract not verified", detail: "Sending stays off until the current provider contract is verified." },
  provider_unavailable: { label: "Provider unavailable", detail: "Sending is paused until the provider can confirm reply eligibility." },
};

export function privateEligibilityPresentation(eligibility: PrivateEligibility | undefined, now = Date.now()): PrivateEligibilityPresentation {
  if (!eligibility || eligibility.state === "unknown") {
    const copy = eligibility?.reason ? reasonCopy[eligibility.reason] : { label: "Eligibility unknown", detail: "Refresh the conversation before preparing a reply." };
    return { canReply: false, tone: "blocked", ...copy };
  }
  if (eligibility.state === "ineligible") {
    const copy = eligibility.reason ? reasonCopy[eligibility.reason] : { label: "Reply unavailable", detail: "The provider is not allowing a reply right now." };
    return { canReply: false, tone: "blocked", ...copy };
  }
  if (!eligibility.expiresAt) return { canReply: false, tone: "blocked", label: "Eligibility needs refresh", detail: "A verified expiry time is required before preparing a reply." };
  const remainingMs = new Date(eligibility.expiresAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { canReply: false, tone: "blocked", label: "Reply window closed", detail: "Refresh before preparing another reply.", remainingMs: 0 };
  const expiring = remainingMs <= 5 * 60_000;
  return {
    canReply: true,
    tone: expiring ? "attention" : "ready",
    label: expiring ? "Reply window closing" : "Reply available",
    detail: `${formatEligibilityDuration(remainingMs)} left. Eligibility is checked again before sending.`,
    remainingMs,
  };
}

export function formatEligibilityDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function privateNeedsTerminalPoll(intents: Array<{ status: string }>): boolean {
  return intents.some((intent) => intent.status === "queued" || intent.status === "processing");
}

export function privateCanCancelIntent(role: string, userId: string, intent: Pick<PrivateReplyIntent, "requestedBy" | "status">): boolean {
  if (["processing", "succeeded", "uncertain", "cancelled", "expired"].includes(intent.status)) return false;
  if (role === "creator") return intent.requestedBy === userId && (intent.status === "draft" || intent.status === "pending_approval");
  return role === "owner" || role === "manager";
}

export function privateMessageCopy(message: PrivateMessage): string {
  if (message.availability === "deleted" || message.availability === "removed" || message.availability === "unsent") return "This message was removed on the provider.";
  if (message.availability === "expired") return "This message is no longer available.";
  if (typeof message.body === "string" && message.body.trim()) return message.body.trim();
  if (message.kind === "unsupported") return "Unsupported message — open the provider conversation to review it.";
  if (message.kind !== "text") return `${capitalize(message.kind)} message`;
  return "Message content is unavailable.";
}

export function privateAttachmentLabel(attachment: PrivateAttachment): string {
  const kind = capitalize(attachment.kind ?? attachment.type ?? "attachment");
  if (attachment.availability === "expired") return `${kind} expired`;
  if (attachment.availability === "deleted" || attachment.availability === "removed") return `${kind} removed`;
  if (attachment.availability === "unsupported") return `${kind} is not supported`;
  return `${kind} not imported`;
}

export function privateParticipantLabel(participant: PrivateParticipant | undefined): string {
  return participant?.displayName?.trim() || (participant?.username?.trim() ? `@${participant.username.trim().replace(/^@/, "")}` : "Private customer");
}

export function privateReplyEligibility(input: { replyEligibility?: PrivateEligibility; eligibility?: PrivateEligibility } | null | undefined): PrivateEligibility | undefined {
  return input?.replyEligibility ?? input?.eligibility;
}

export function privateConnectionModeLabel(mode: PrivateConnectionMode | string | undefined): string {
  if (mode === "facebook_page_messenger") return "Facebook Page Messenger";
  if (mode === "instagram_linked_page") return "Instagram linked Page";
  if (mode === "instagram_login") return "Instagram Login";
  return "Connection mode unavailable";
}

export function privatePreview(message: PrivateMessage | undefined): string {
  if (!message) return "Private conversation";
  const copy = privateMessageCopy(message).replace(/\s+/g, " ");
  return copy.length > 90 ? `${copy.slice(0, 87)}…` : copy;
}

export function privateAvailabilityFromResponse(status: number, body: unknown): PrivateInboxAvailability {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const raw = [record.reason, record.code, record.status, record.message].find((value) => typeof value === "string") as string | undefined;
  const value = raw?.toLowerCase().replace(/[ -]+/g, "_") ?? "";
  if (status === 401 || status === 403) return { state: "forbidden", detail: "You do not have permission to read private messages for this workspace." };
  if (value.includes("permission")) return { state: "permission_missing", detail: "Reconnect the channel with private messaging permission." };
  if (value.includes("disconnect")) return { state: "account_disconnected", detail: "Reconnect the account in Channels." };
  if (value.includes("contract") || status === 404) return { state: "contract_unverified", detail: "Private messaging is not enabled until the provider contract is verified." };
  if (status === 429 || value.includes("rate_limit")) return { state: "rate_limited", detail: "The provider is limiting checks. OriginPost will wait before checking again." };
  return { state: "provider_unavailable", detail: "Private messages could not be loaded. Public comments remain available." };
}

export function privateAvailabilityCopy(availability: PrivateInboxAvailability): { title: string; detail: string; action?: string } {
  const fallback = availability.detail;
  switch (availability.state) {
    case "no_account": return { title: "No messaging account", detail: fallback ?? "Connect an Instagram or Facebook Page messaging account in Channels.", action: "Open Channels" };
    case "permission_missing": return { title: "Messaging permission missing", detail: fallback ?? "Reconnect the account with private messaging permission.", action: "Reconnect in Channels" };
    case "account_disconnected": return { title: "Account disconnected", detail: fallback ?? "Reconnect this account before reading or replying.", action: "Reconnect in Channels" };
    case "contract_unverified": return { title: "Messaging contract not verified", detail: fallback ?? "Private messaging stays off until the provider contract is verified." };
    case "provider_unavailable": return { title: "Messages are temporarily unavailable", detail: fallback ?? "OriginPost could not reach the private messaging service." };
    case "rate_limited": return { title: "Provider check paused", detail: fallback ?? "OriginPost will wait before checking again." };
    case "forbidden": return { title: "Private messages are restricted", detail: fallback ?? "Your role cannot read private messages in this workspace." };
    default: return { title: "Private messages ready", detail: fallback ?? "Connected messaging accounts are available." };
  }
}

export function privateInboxResponse(body: unknown): PrivateInboxResponse {
  if (!body || typeof body !== "object") return { items: [] };
  const record = body as Record<string, unknown>;
  return {
    items: Array.isArray(record.items) ? record.items as PrivateConversationSummary[] : [],
    ...(typeof record.nextCursor === "string" ? { nextCursor: record.nextCursor } : {}),
    ...(record.availability && typeof record.availability === "object" ? { availability: record.availability as PrivateInboxAvailability } : {}),
  };
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("_", " ")}` : "Attachment";
}
