import { createHash } from "node:crypto";
import {
  privateConversationPlatformForMode,
  type PrivateConversationConnectionMode,
  type PrivateConversationPlatform,
  type PrivateHumanAgentReviewEvidence,
  type PrivateMessageAvailability,
  type PrivateMessageDeliveryState,
  type PrivateMessageDirection,
  type PrivateMessageKind,
  type PrivateMessageObservationKind,
  type PrivateReplyEligibility,
  type PrivateTextContract,
} from "@originpost/domain";

export interface PrivateConversationRequestScope {
  workspaceId: string;
  brandId: string;
  accountId: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
}

export interface PrivateConversationConnectorManifest {
  id: string;
  name: string;
  platform: PrivateConversationPlatform;
  connectionMode: PrivateConversationConnectionMode;
  version: string;
  apiMode: "official" | "mock";
  contractVersion: string;
  capabilities: {
    read: boolean;
    sendText: boolean;
    readAttachments: boolean;
    observations: readonly PrivateMessageObservationKind[];
    webhookFields: readonly string[];
  };
  text: PrivateTextContract;
}

export interface PrivateCapabilityRequest extends PrivateConversationRequestScope {}

export type PrivateCapabilityResult =
  | {
      state: "available";
      checkedAt: string;
      contractVersion: string;
      text: PrivateTextContract;
      humanAgentReview?: PrivateHumanAgentReviewEvidence | undefined;
    }
  | {
      state: "unavailable";
      checkedAt: string;
      contractVersion: string;
      reason: "permission_missing" | "account_unsupported" | "setup_required" | "contract_unverified" | "provider_unavailable";
      missingRequirements: string[];
    };

export interface PrivateSubscriptionRequest extends PrivateConversationRequestScope {
  externalBusinessAccountId: string;
}

export interface PrivateSubscriptionResult {
  subscribed: true;
  fields: string[];
  subscribedAt: string;
  rawResponse: unknown;
}

export interface PrivateSyncRequest extends PrivateConversationRequestScope {
  cursor?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
}

export interface ProviderPrivateParticipant {
  externalParticipantId: string;
  role: "business" | "customer" | "unknown";
  displayName?: string | undefined;
  username?: string | undefined;
  avatarUrl?: string | undefined;
  avatarExpiresAt?: string | undefined;
}

export interface ProviderPrivateMessage {
  externalMessageId: string;
  externalSenderId?: string | undefined;
  direction: PrivateMessageDirection;
  kind: PrivateMessageKind;
  body?: string | undefined;
  attachments: ProviderPrivateAttachment[];
  replyToExternalMessageId?: string | undefined;
  isEcho: boolean;
  availability: PrivateMessageAvailability;
  deliveryState: PrivateMessageDeliveryState;
  deliveredAt?: string | undefined;
  readAt?: string | undefined;
  deletedAt?: string | undefined;
  providerCreatedAt?: string | undefined;
  observationKind: PrivateMessageObservationKind;
  reaction?: {
    action: "react" | "unreact";
    value?: string | undefined;
    externalActorId?: string | undefined;
  } | undefined;
}

export interface ProviderPrivateAttachment {
  externalAttachmentId?: string | undefined;
  kind: Exclude<PrivateMessageKind, "text">;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  url?: string | undefined;
  expiresAt?: string | undefined;
  cachePolicy: "reference_only" | "import_required" | "never_cache";
  availability: "available" | "expired" | "deleted" | "unsupported";
}

export interface ProviderPrivateConversation {
  externalConversationId: string;
  participants: ProviderPrivateParticipant[];
  messages: ProviderPrivateMessage[];
  updatedAt: string;
}

export interface ProviderPrivateConversationPage {
  conversations: ProviderPrivateConversation[];
  fetchedAt: string;
  nextCursor?: string | undefined;
  complete: boolean;
  rawResponse: unknown;
}

export interface PrivateReplyEligibilityRequest extends PrivateConversationRequestScope {
  externalConversationId: string;
  qualifyingEventAt?: string | undefined;
  policyPreference?: "standard" | "human_agent" | undefined;
}

export interface SendPrivateTextRequest extends PrivateConversationRequestScope {
  externalConversationId: string;
  externalRecipientId: string;
  inReplyToExternalMessageId?: string | undefined;
  body: string;
  idempotencyKey: string;
  eligibility: PrivateReplyEligibility;
}

export type PrivateSendResult =
  | {
      status: "accepted";
      externalMessageId: string;
      externalRecipientId: string;
      acceptedAt: string;
      rawResponse: unknown;
    }
  | {
      status: "rejected";
      code: string;
      retryable: boolean;
      message: string;
      rawResponse?: unknown;
    };

export interface InspectProviderMessageRequest extends PrivateConversationRequestScope {
  externalConversationId: string;
  externalMessageId: string;
}

export type ProviderMessageProbeResult =
  | { state: "found"; message: ProviderPrivateMessage; checkedAt: string; rawResponse: unknown }
  | { state: "not_found" | "unsupported"; checkedAt: string; rawResponse?: unknown };

export type PrivateConnectorFailureCertainty = "read_failed" | "definitely_not_sent" | "send_uncertain";

export class PrivateConversationConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly certainty: PrivateConnectorFailureCertainty,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PrivateConversationConnectorError";
  }
}

export interface PrivateConversationConnector {
  readonly privateConversationManifest: PrivateConversationConnectorManifest;
  inspectCapability(request: PrivateCapabilityRequest): Promise<PrivateCapabilityResult>;
  subscribe(request: PrivateSubscriptionRequest): Promise<PrivateSubscriptionResult>;
  sync(request: PrivateSyncRequest): Promise<ProviderPrivateConversationPage>;
  inspectReplyEligibility(request: PrivateReplyEligibilityRequest): Promise<PrivateReplyEligibility>;
  sendText(request: SendPrivateTextRequest): Promise<PrivateSendResult>;
  inspectMessage?(request: InspectProviderMessageRequest): Promise<ProviderMessageProbeResult>;
}

export interface MockPrivateConversationConnectorOptions {
  connectionMode: PrivateConversationConnectionMode;
  text?: Partial<Omit<PrivateTextContract, "contractVersion">> | undefined;
  standardWindowSeconds?: number | undefined;
  humanAgentWindowSeconds?: number | undefined;
  humanAgentReview?: PrivateHumanAgentReviewEvidence | undefined;
  now?: (() => string) | undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(value: string | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function assertScope(manifest: PrivateConversationConnectorManifest, scope: PrivateConversationRequestScope): void {
  if (scope.connectionMode !== manifest.connectionMode || scope.platform !== manifest.platform) {
    throw new PrivateConversationConnectorError("The private-message request does not match this connection mode.", "connection_mode_mismatch", "read_failed", false);
  }
}

export class MockPrivateConversationConnector implements PrivateConversationConnector {
  readonly privateConversationManifest: PrivateConversationConnectorManifest;
  private readonly standardWindowSeconds: number;
  private readonly humanAgentWindowSeconds: number;
  private readonly humanAgentReview?: PrivateHumanAgentReviewEvidence | undefined;
  private readonly now: () => string;
  private readonly sends = new Map<string, { fingerprint: string; result: Extract<PrivateSendResult, { status: "accepted" }>; message: ProviderPrivateMessage }>();

  constructor(options: MockPrivateConversationConnectorOptions) {
    const platform = privateConversationPlatformForMode(options.connectionMode);
    this.standardWindowSeconds = options.standardWindowSeconds ?? 86_400;
    this.humanAgentWindowSeconds = options.humanAgentWindowSeconds ?? 604_800;
    this.humanAgentReview = options.humanAgentReview;
    this.now = options.now ?? (() => new Date().toISOString());
    this.privateConversationManifest = {
      id: `originpost.${options.connectionMode}.private-messages.mock`,
      name: `${options.connectionMode.replaceAll("_", " ")} (safe test)`,
      platform,
      connectionMode: options.connectionMode,
      version: "0.1.0",
      apiMode: "mock",
      contractVersion: "mock-private-messages-v1",
      capabilities: {
        read: true,
        sendText: true,
        readAttachments: true,
        observations: ["message", "echo", "deleted", "delivery", "read", "reaction"],
        webhookFields: options.connectionMode === "facebook_page_messenger"
          ? ["messages", "message_echoes", "message_deliveries", "message_reads", "messaging_policy_enforcement"]
          : ["messages", "message_reactions", "messaging_seen", "messaging_postbacks", "messaging_referrals"],
      },
      text: {
        maxUtf8Bytes: options.text?.maxUtf8Bytes ?? 1_000,
        ...(options.text?.maxCharacters === undefined ? {} : { maxCharacters: options.text.maxCharacters }),
        supportsReplyToMessage: options.text?.supportsReplyToMessage ?? true,
        contractVersion: "mock-private-messages-v1",
      },
    };
  }

  async inspectCapability(request: PrivateCapabilityRequest): Promise<PrivateCapabilityResult> {
    assertScope(this.privateConversationManifest, request);
    return {
      state: "available",
      checkedAt: this.now(),
      contractVersion: this.privateConversationManifest.contractVersion,
      text: structuredClone(this.privateConversationManifest.text),
      ...(this.humanAgentReview ? { humanAgentReview: structuredClone(this.humanAgentReview) } : {}),
    };
  }

  async subscribe(request: PrivateSubscriptionRequest): Promise<PrivateSubscriptionResult> {
    assertScope(this.privateConversationManifest, request);
    if (!request.externalBusinessAccountId) {
      throw new PrivateConversationConnectorError("A business account ID is required.", "business_account_required", "read_failed", false);
    }
    return {
      subscribed: true,
      fields: [...this.privateConversationManifest.capabilities.webhookFields],
      subscribedAt: this.now(),
      rawResponse: { mock: true, connectionMode: request.connectionMode },
    };
  }

  async sync(request: PrivateSyncRequest): Promise<ProviderPrivateConversationPage> {
    assertScope(this.privateConversationManifest, request);
    const key = digest(`${request.connectionMode}:${request.accountId}`);
    const updatedAt = "2026-08-31T10:00:00.000Z";
    const conversation: ProviderPrivateConversation = {
      externalConversationId: `mock_conversation_${key.slice(0, 16)}`,
      participants: [
        { externalParticipantId: `mock_business_${key.slice(16, 24)}`, role: "business", displayName: "OriginPost test account" },
        { externalParticipantId: `mock_customer_${key.slice(24, 32)}`, role: "customer", displayName: "Test customer" },
      ],
      messages: [{
        externalMessageId: `mock_message_${key.slice(32, 48)}`,
        externalSenderId: `mock_customer_${key.slice(24, 32)}`,
        direction: "incoming",
        kind: "text",
        body: "Could you share more details?",
        attachments: [],
        isEcho: false,
        availability: "available",
        deliveryState: "delivered",
        deliveredAt: updatedAt,
        providerCreatedAt: updatedAt,
        observationKind: "message",
      }],
      updatedAt,
    };
    return {
      conversations: [conversation],
      fetchedAt: this.now(),
      complete: true,
      rawResponse: { mock: true, cursor: request.cursor ?? null, conversationCount: 1 },
    };
  }

  async inspectReplyEligibility(request: PrivateReplyEligibilityRequest): Promise<PrivateReplyEligibility> {
    assertScope(this.privateConversationManifest, request);
    const checkedAt = this.now();
    if (!validDate(request.qualifyingEventAt)) {
      return { state: "unknown", checkedAt, reason: "provider_unavailable", contractVersion: this.privateConversationManifest.contractVersion };
    }
    const humanAgent = request.policyPreference === "human_agent";
    if (humanAgent && !this.humanAgentReview) {
      return { state: "ineligible", checkedAt, reason: "contract_unverified", contractVersion: this.privateConversationManifest.contractVersion };
    }
    const durationSeconds = humanAgent ? this.humanAgentWindowSeconds : this.standardWindowSeconds;
    const expiresAt = new Date(Date.parse(request.qualifyingEventAt) + durationSeconds * 1_000).toISOString();
    const evidence = humanAgent
      ? { mode: "human_agent" as const, qualifyingEventAt: request.qualifyingEventAt, durationSeconds, review: structuredClone(this.humanAgentReview!) }
      : { mode: "standard" as const, qualifyingEventAt: request.qualifyingEventAt, durationSeconds };
    return Date.parse(expiresAt) > Date.parse(checkedAt)
      ? { state: "eligible", checkedAt, expiresAt, evidence, contractVersion: this.privateConversationManifest.contractVersion }
      : { state: "ineligible", checkedAt, expiresAt, reason: "window_closed", evidence, contractVersion: this.privateConversationManifest.contractVersion };
  }

  async sendText(request: SendPrivateTextRequest): Promise<PrivateSendResult> {
    assertScope(this.privateConversationManifest, request);
    if (request.eligibility.state !== "eligible" || (request.eligibility.expiresAt && Date.parse(request.eligibility.expiresAt) <= Date.parse(this.now()))) {
      return { status: "rejected", code: "window_closed", retryable: false, message: "The provider reply window is not open." };
    }
    const body = request.body.normalize("NFC").trim();
    if (!body) return { status: "rejected", code: "message_empty", retryable: false, message: "Message text is required." };
    const text = this.privateConversationManifest.text;
    if ((text.maxUtf8Bytes !== undefined && Buffer.byteLength(body, "utf8") > text.maxUtf8Bytes)
      || (text.maxCharacters !== undefined && [...body].length > text.maxCharacters)) {
      return { status: "rejected", code: "message_too_long", retryable: false, message: "Message text exceeds the verified provider contract." };
    }
    const fingerprint = digest(JSON.stringify({
      accountId: request.accountId,
      connectionMode: request.connectionMode,
      externalConversationId: request.externalConversationId,
      externalRecipientId: request.externalRecipientId,
      inReplyToExternalMessageId: request.inReplyToExternalMessageId ?? null,
      body,
    }));
    const existing = this.sends.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new PrivateConversationConnectorError("The idempotency key was reused for different private-message content.", "idempotency_conflict", "definitely_not_sent", false);
      }
      return structuredClone(existing.result);
    }
    const acceptedAt = this.now();
    const externalMessageId = `mock_private_message_${digest(request.idempotencyKey).slice(0, 20)}`;
    const result: Extract<PrivateSendResult, { status: "accepted" }> = {
      status: "accepted",
      externalMessageId,
      externalRecipientId: request.externalRecipientId,
      acceptedAt,
      rawResponse: { mock: true, externalMessageId, connectionMode: request.connectionMode },
    };
    const message: ProviderPrivateMessage = {
      externalMessageId,
      direction: "outgoing",
      kind: "text",
      body,
      attachments: [],
      ...(request.inReplyToExternalMessageId ? { replyToExternalMessageId: request.inReplyToExternalMessageId } : {}),
      isEcho: true,
      availability: "available",
      deliveryState: "sent",
      providerCreatedAt: acceptedAt,
      observationKind: "echo",
    };
    this.sends.set(request.idempotencyKey, { fingerprint, result: structuredClone(result), message });
    return structuredClone(result);
  }

  async inspectMessage(request: InspectProviderMessageRequest): Promise<ProviderMessageProbeResult> {
    assertScope(this.privateConversationManifest, request);
    const found = [...this.sends.values()].find((entry) => entry.message.externalMessageId === request.externalMessageId);
    return found
      ? { state: "found", message: structuredClone(found.message), checkedAt: this.now(), rawResponse: { mock: true, found: true } }
      : { state: "not_found", checkedAt: this.now(), rawResponse: { mock: true, found: false } };
  }
}
