import { createHash, createHmac } from "node:crypto";
import {
  privateConversationPlatformForMode,
  type PrivateConversationConnectionMode,
  type PrivateReplyEligibility,
} from "@originpost/domain";
import {
  PrivateConversationConnectorError,
  type InspectProviderMessageRequest,
  type PrivateCapabilityRequest,
  type PrivateCapabilityResult,
  type PrivateConversationConnector,
  type PrivateConversationConnectorManifest,
  type PrivateConversationRequestScope,
  type PrivateReplyEligibilityRequest,
  type PrivateSendResult,
  type PrivateSubscriptionRequest,
  type PrivateSubscriptionResult,
  type PrivateSyncRequest,
  type ProviderMessageProbeResult,
  type ProviderPrivateAttachment,
  type ProviderPrivateConversation,
  type ProviderPrivateConversationPage,
  type ProviderPrivateMessage,
  type ProviderPrivateParticipant,
  type SendPrivateTextRequest,
} from "./private-conversations.js";

export type MetaPagePrivateConversationMode = Extract<
  PrivateConversationConnectionMode,
  "facebook_page_messenger" | "instagram_linked_page"
>;

export interface MetaPrivateMessagingGrant {
  task: "meta_private_messaging";
  connectionMode: MetaPagePrivateConversationMode;
  apiVersion: string;
  environment: "production" | "development" | "test";
  appId: string;
  accountId: string;
  externalBusinessAccountId: string;
  endpointPageId: string;
  credentialVersion: string;
  accountVersion: string;
  scopesSha256: string;
  pageTasksSha256: string;
  appReviewReferenceSha256: string;
  verifiedAt: string;
  expiresAt: string;
}

export interface MetaPagePrivateConversationCredential {
  /** Facebook Page ID for Messenger; Instagram professional account ID for linked Instagram. */
  externalBusinessAccountId: string;
  /** Facebook Page ID used as the Messenger Platform Graph endpoint in both modes. */
  endpointPageId: string;
  accessToken: string;
  scopes: readonly string[];
  pageTasks: readonly string[];
  credentialVersion: string;
  accountVersion: string;
  messagingGrant?: MetaPrivateMessagingGrant | undefined;
}

export function parseMetaPrivateMessagingGrant(value: unknown): MetaPrivateMessagingGrant | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const connectionMode = candidate.connectionMode;
  const environment = candidate.environment;
  if (candidate.task !== "meta_private_messaging"
    || (connectionMode !== "facebook_page_messenger" && connectionMode !== "instagram_linked_page")
    || (environment !== "production" && environment !== "development" && environment !== "test")) return undefined;
  const required = ["apiVersion", "appId", "accountId", "externalBusinessAccountId", "endpointPageId", "credentialVersion", "accountVersion", "scopesSha256", "pageTasksSha256", "appReviewReferenceSha256", "verifiedAt", "expiresAt"] as const;
  if (required.some((key) => typeof candidate[key] !== "string" || !candidate[key])) return undefined;
  return candidate as unknown as MetaPrivateMessagingGrant;
}

export interface MetaPagePrivateConversationConnectorOptions {
  connectionMode: MetaPagePrivateConversationMode;
  apiVersion: string;
  appId: string;
  appSecret: string;
  environment: "production" | "development" | "test";
  resolveCredential(request: Pick<PrivateConversationRequestScope, "workspaceId" | "accountId">): Promise<MetaPagePrivateConversationCredential>;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: (() => string) | undefined;
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  maxResponseBytes?: number;
}

type GraphError = { message?: unknown; code?: unknown; error_subcode?: unknown; type?: unknown };
type GraphPaging = { cursors?: { after?: unknown } };
type GraphConversation = { id?: unknown; updated_time?: unknown };
type GraphConversationPage = { data?: unknown; paging?: GraphPaging; error?: GraphError };
type GraphConversationDetail = { id?: unknown; messages?: { data?: unknown; paging?: GraphPaging }; error?: GraphError };
type GraphIdentity = { id?: unknown; name?: unknown; username?: unknown };
type GraphAttachment = {
  id?: unknown;
  mime_type?: unknown;
  size?: unknown;
  type?: unknown;
  url?: unknown;
  file_url?: unknown;
  image_data?: { url?: unknown };
  video_data?: { url?: unknown };
};
type GraphMessageDetail = {
  id?: unknown;
  created_time?: unknown;
  to?: { data?: unknown };
  from?: GraphIdentity;
  message?: unknown;
  attachments?: { data?: unknown };
  error?: GraphError;
};
type GraphMutation = { success?: unknown; message_id?: unknown; recipient_id?: unknown; error?: GraphError };

const STANDARD_REPLY_SECONDS = 24 * 60 * 60;
const MAX_PROBE_AGE_MS = 30 * 24 * 60 * 60_000;

export function metaPrivateGrantSetSha256(values: readonly string[]): string {
  const normalized = [...new Set(values.map((value) => value.normalize("NFC").trim()).filter(Boolean))].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).normalize("NFC").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeAttachmentUrl(value: unknown): string | undefined {
  const candidate = text(value, 4_096);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function graphCode(error: GraphError | undefined, fallback: string): string {
  const code = typeof error?.code === "number" ? String(error.code) : fallback;
  const subcode = typeof error?.error_subcode === "number" ? `_${error.error_subcode}` : "";
  return `meta_${code}${subcode}`.slice(0, 100);
}

function graphMessage(error: GraphError | undefined, fallback: string): string {
  return text(error?.message, 300) ?? fallback;
}

function messageKind(type: unknown): Exclude<ProviderPrivateMessage["kind"], "text"> {
  const normalized = typeof type === "string" ? type.toLowerCase() : "";
  if (normalized === "image" || normalized === "video" || normalized === "audio" || normalized === "file" || normalized === "share" || normalized === "sticker") return normalized;
  return "unsupported";
}

function requiredScopes(mode: MetaPagePrivateConversationMode): readonly string[] {
  return mode === "facebook_page_messenger"
    ? ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "pages_messaging"]
    : ["instagram_basic", "instagram_manage_messages", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "business_management"];
}

function webhookFields(mode: MetaPagePrivateConversationMode): readonly string[] {
  return mode === "facebook_page_messenger"
    ? ["messages", "message_echoes", "message_deliveries", "message_reads", "messaging_policy_enforcement"]
    : ["messages", "message_reactions", "messaging_seen", "messaging_postbacks", "messaging_referrals", "messaging_policy_enforcement"];
}

export class MetaPagePrivateConversationConnector implements PrivateConversationConnector {
  readonly privateConversationManifest: PrivateConversationConnectorManifest;
  private readonly transport: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => string;
  private readonly maxConversations: number;
  private readonly maxMessagesPerConversation: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: MetaPagePrivateConversationConnectorOptions) {
    if (!/^v\d+\.\d+$/.test(options.apiVersion)) throw new Error("Meta private messaging apiVersion must look like v26.0.");
    if (!options.appId || !options.appSecret) throw new Error("Meta private messaging requires an app ID and app secret.");
    const origin = new URL(options.baseUrl ?? "https://graph.facebook.com");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      throw new Error("Meta private messaging requires an exact HTTPS Graph origin.");
    }
    this.baseUrl = origin.origin;
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxConversations = Math.max(1, Math.min(options.maxConversations ?? 25, 100));
    this.maxMessagesPerConversation = Math.max(1, Math.min(options.maxMessagesPerConversation ?? 20, 20));
    this.maxResponseBytes = Math.max(16_384, Math.min(options.maxResponseBytes ?? 1_000_000, 4_000_000));
    const contractVersion = `${options.apiVersion}:messenger-platform-private-v1`;
    this.privateConversationManifest = {
      id: `originpost.${options.connectionMode}.private-messages.official`,
      name: options.connectionMode === "facebook_page_messenger" ? "Facebook Page Messenger" : "Instagram Messaging (linked Page)",
      platform: privateConversationPlatformForMode(options.connectionMode),
      connectionMode: options.connectionMode,
      version: "0.1.0",
      apiMode: "official",
      contractVersion,
      capabilities: {
        read: true,
        sendText: true,
        readAttachments: true,
        observations: ["message", "echo", "deleted", "delivery", "read", "reaction"],
        webhookFields: webhookFields(options.connectionMode),
      },
      text: { maxUtf8Bytes: 1_000, supportsReplyToMessage: false, contractVersion },
    };
  }

  async inspectCapability(request: PrivateCapabilityRequest): Promise<PrivateCapabilityResult> {
    this.assertScope(request);
    const checkedAt = this.now();
    let credential: MetaPagePrivateConversationCredential;
    try {
      credential = await this.options.resolveCredential(request);
    } catch {
      return { state: "unavailable", checkedAt, contractVersion: this.privateConversationManifest.contractVersion, reason: "setup_required", missingRequirements: ["encrypted messaging credential"] };
    }
    const missingRequirements = this.missingRequirements(request, credential, checkedAt);
    return missingRequirements.length
      ? { state: "unavailable", checkedAt, contractVersion: this.privateConversationManifest.contractVersion, reason: missingRequirements.some((entry) => entry.startsWith("scope:")) ? "permission_missing" : "contract_unverified", missingRequirements }
      : { state: "available", checkedAt, contractVersion: this.privateConversationManifest.contractVersion, text: structuredClone(this.privateConversationManifest.text) };
  }

  async subscribe(request: PrivateSubscriptionRequest): Promise<PrivateSubscriptionResult> {
    const credential = await this.credential(request);
    if (request.externalBusinessAccountId !== credential.externalBusinessAccountId) {
      throw new PrivateConversationConnectorError("The subscription business account does not match the connected credential.", "business_account_mismatch", "read_failed", false);
    }
    const fields = [...this.privateConversationManifest.capabilities.webhookFields];
    const body = new URLSearchParams({ subscribed_fields: fields.join(",") });
    const value = await this.requestGraph<GraphMutation>(`/${encodeURIComponent(credential.endpointPageId)}/subscribed_apps`, credential, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }, "read");
    if (value.success !== true) throw new PrivateConversationConnectorError("Meta did not confirm the private-message webhook subscription.", "subscription_unconfirmed", "read_failed", true);
    return { subscribed: true, fields, subscribedAt: this.now(), rawResponse: { success: true } };
  }

  async sync(request: PrivateSyncRequest): Promise<ProviderPrivateConversationPage> {
    const credential = await this.credential(request);
    const limit = Math.max(1, Math.min(request.limit ?? this.maxConversations, this.maxConversations));
    const query = new URLSearchParams({ platform: this.options.connectionMode === "facebook_page_messenger" ? "messenger" : "instagram", limit: String(limit) });
    if (request.cursor) query.set("after", request.cursor.slice(0, 2_048));
    const page = await this.requestGraph<GraphConversationPage>(`/${encodeURIComponent(credential.endpointPageId)}/conversations`, credential, { method: "GET", query }, "read");
    const entries = Array.isArray(page.data) ? page.data.slice(0, limit) as GraphConversation[] : [];
    const conversations: ProviderPrivateConversation[] = [];
    for (const candidate of entries) {
      const conversationId = text(candidate.id, 200);
      if (!conversationId) throw this.malformed("Meta returned a conversation without an ID.");
      conversations.push(await this.readConversation(conversationId, candidate, credential));
    }
    const after = text(page.paging?.cursors?.after, 2_048);
    return {
      conversations,
      fetchedAt: this.now(),
      ...(after ? { nextCursor: after } : {}),
      complete: !after,
      rawResponse: { conversationCount: conversations.length, hasNextPage: Boolean(after) },
    };
  }

  async inspectReplyEligibility(request: PrivateReplyEligibilityRequest): Promise<PrivateReplyEligibility> {
    this.assertScope(request);
    const checkedAt = this.now();
    const capability = await this.inspectCapability(request);
    if (capability.state !== "available") return { state: "unknown", checkedAt, reason: capability.reason === "permission_missing" ? "permission_missing" : "contract_unverified", contractVersion: this.privateConversationManifest.contractVersion };
    if (request.policyPreference === "human_agent") return { state: "ineligible", checkedAt, reason: "contract_unverified", contractVersion: this.privateConversationManifest.contractVersion };
    if (!request.qualifyingEventAt || !Number.isFinite(Date.parse(request.qualifyingEventAt))) {
      return { state: "unknown", checkedAt, reason: "provider_unavailable", contractVersion: this.privateConversationManifest.contractVersion };
    }
    const expiresAt = new Date(Date.parse(request.qualifyingEventAt) + STANDARD_REPLY_SECONDS * 1_000).toISOString();
    const evidence = { mode: "standard" as const, qualifyingEventAt: request.qualifyingEventAt, durationSeconds: STANDARD_REPLY_SECONDS };
    return Date.parse(expiresAt) > Date.parse(checkedAt)
      ? { state: "eligible", checkedAt, expiresAt, evidence, contractVersion: this.privateConversationManifest.contractVersion }
      : { state: "ineligible", checkedAt, expiresAt, reason: "window_closed", evidence, contractVersion: this.privateConversationManifest.contractVersion };
  }

  async sendText(request: SendPrivateTextRequest): Promise<PrivateSendResult> {
    const credential = await this.credential(request);
    if (request.eligibility.state !== "eligible" || !request.eligibility.expiresAt || Date.parse(request.eligibility.expiresAt) <= Date.parse(this.now())) {
      return { status: "rejected", code: "window_closed", retryable: false, message: "The standard private-message reply window is closed." };
    }
    const bodyText = request.body.normalize("NFC").trim();
    if (!bodyText) return { status: "rejected", code: "message_empty", retryable: false, message: "Message text is required." };
    if (Buffer.byteLength(bodyText, "utf8") > 1_000) return { status: "rejected", code: "message_too_long", retryable: false, message: "Message text exceeds the verified 1,000-byte Meta contract." };
    const body = new URLSearchParams({
      recipient: JSON.stringify({ id: request.externalRecipientId }),
      messaging_type: "RESPONSE",
      message: JSON.stringify({ text: bodyText }),
    });
    const value = await this.requestGraph<GraphMutation>(`/${encodeURIComponent(credential.endpointPageId)}/messages`, credential, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }, "send");
    const externalMessageId = text(value.message_id, 240);
    const externalRecipientId = text(value.recipient_id, 240);
    if (!externalMessageId || !externalRecipientId) {
      throw new PrivateConversationConnectorError("Meta accepted the private-message request without complete send evidence. Reconcile before any retry.", "send_evidence_missing", "send_uncertain", false);
    }
    if (externalRecipientId !== request.externalRecipientId) {
      throw new PrivateConversationConnectorError("Meta returned send evidence for an unexpected recipient. Reconcile before any retry.", "recipient_mismatch", "send_uncertain", false);
    }
    const acceptedAt = this.now();
    return { status: "accepted", externalMessageId, externalRecipientId, acceptedAt, rawResponse: { message_id: externalMessageId, recipient_id: externalRecipientId } };
  }

  async inspectMessage(request: InspectProviderMessageRequest): Promise<ProviderMessageProbeResult> {
    const credential = await this.credential(request);
    let detail: GraphMessageDetail;
    try {
      detail = await this.messageDetail(request.externalMessageId, credential);
    } catch (error) {
      if (error instanceof PrivateConversationConnectorError && error.code === "meta_100") return { state: "not_found", checkedAt: this.now() };
      throw error;
    }
    return { state: "found", message: this.mapMessage(detail, credential), checkedAt: this.now(), rawResponse: { id: request.externalMessageId } };
  }

  private assertScope(scope: PrivateConversationRequestScope): void {
    if (scope.connectionMode !== this.options.connectionMode || scope.platform !== this.privateConversationManifest.platform) {
      throw new PrivateConversationConnectorError("The private-message request does not match this Meta connection mode.", "connection_mode_mismatch", "read_failed", false);
    }
  }

  private async credential(scope: PrivateConversationRequestScope): Promise<MetaPagePrivateConversationCredential> {
    this.assertScope(scope);
    let credential: MetaPagePrivateConversationCredential;
    try {
      credential = await this.options.resolveCredential(scope);
    } catch {
      throw new PrivateConversationConnectorError("The Meta private-message credential is unavailable. Reconnect this account.", "credential_unavailable", "read_failed", false);
    }
    const missing = this.missingRequirements(scope, credential, this.now());
    if (missing.length) throw new PrivateConversationConnectorError(`Meta private messaging is not enabled for this account (${missing.join(", ")}).`, "contract_unverified", "read_failed", false);
    return credential;
  }

  private missingRequirements(scope: PrivateConversationRequestScope, credential: MetaPagePrivateConversationCredential, checkedAt: string): string[] {
    const missing: string[] = [];
    if (!credential.externalBusinessAccountId || !credential.endpointPageId || !credential.accessToken) missing.push("credential binding");
    if (this.options.connectionMode === "facebook_page_messenger" && credential.externalBusinessAccountId !== credential.endpointPageId) missing.push("Page endpoint binding");
    const scopes = new Set(credential.scopes);
    for (const required of requiredScopes(this.options.connectionMode)) if (!scopes.has(required)) missing.push(`scope:${required}`);
    if (!credential.pageTasks.some((task) => task === "MESSAGING" || task === "MODERATE")) missing.push("Page task:MESSAGING-or-MODERATE");
    const grant = credential.messagingGrant;
    if (!grant) return [...missing, "live messaging contract probe"];
    const verifiedAt = Date.parse(grant.verifiedAt);
    const expiresAt = Date.parse(grant.expiresAt);
    const checked = Date.parse(checkedAt);
    const exact = grant.task === "meta_private_messaging"
      && grant.connectionMode === this.options.connectionMode
      && grant.apiVersion === this.options.apiVersion
      && grant.environment === this.options.environment
      && grant.appId === this.options.appId
      && grant.accountId === scope.accountId
      && grant.externalBusinessAccountId === credential.externalBusinessAccountId
      && grant.endpointPageId === credential.endpointPageId
      && grant.credentialVersion === credential.credentialVersion
      && grant.accountVersion === credential.accountVersion
      && grant.scopesSha256 === metaPrivateGrantSetSha256(credential.scopes)
      && grant.pageTasksSha256 === metaPrivateGrantSetSha256(credential.pageTasks)
      && /^[a-f0-9]{64}$/.test(grant.appReviewReferenceSha256)
      && Number.isFinite(verifiedAt)
      && Number.isFinite(expiresAt)
      && verifiedAt <= checked
      && expiresAt > checked
      && expiresAt > verifiedAt
      && expiresAt - verifiedAt <= MAX_PROBE_AGE_MS;
    if (!exact) missing.push("current live messaging contract probe");
    return [...new Set(missing)];
  }

  private async readConversation(conversationId: string, summary: GraphConversation, credential: MetaPagePrivateConversationCredential): Promise<ProviderPrivateConversation> {
    const query = new URLSearchParams({ fields: "id,messages" });
    const detail = await this.requestGraph<GraphConversationDetail>(`/${encodeURIComponent(conversationId)}`, credential, { method: "GET", query }, "read");
    if (text(detail.id, 200) !== conversationId) throw this.malformed("Meta returned a mismatched conversation ID.");
    const refs = Array.isArray(detail.messages?.data) ? (detail.messages!.data as Array<{ id?: unknown; created_time?: unknown }>).slice(0, this.maxMessagesPerConversation) : [];
    const messages: ProviderPrivateMessage[] = [];
    const participants = new Map<string, ProviderPrivateParticipant>();
    participants.set(credential.externalBusinessAccountId, { externalParticipantId: credential.externalBusinessAccountId, role: "business" });
    for (const reference of refs) {
      const messageId = text(reference.id, 240);
      if (!messageId) throw this.malformed("Meta returned a message reference without an ID.");
      const message = this.mapMessage(await this.messageDetail(messageId, credential), credential);
      messages.push(message);
      const sender = message.externalSenderId;
      if (sender && !participants.has(sender)) participants.set(sender, { externalParticipantId: sender, role: sender === credential.externalBusinessAccountId ? "business" : "customer" });
    }
    messages.sort((a, b) => (a.providerCreatedAt ?? "").localeCompare(b.providerCreatedAt ?? "") || a.externalMessageId.localeCompare(b.externalMessageId));
    const updatedAt = messages.at(-1)?.providerCreatedAt ?? iso(summary.updated_time) ?? this.now();
    return { externalConversationId: conversationId, participants: [...participants.values()], messages, updatedAt };
  }

  private async messageDetail(messageId: string, credential: MetaPagePrivateConversationCredential): Promise<GraphMessageDetail> {
    const query = new URLSearchParams({ fields: "id,to,from,message,created_time,attachments" });
    const detail = await this.requestGraph<GraphMessageDetail>(`/${encodeURIComponent(messageId)}`, credential, { method: "GET", query }, "read");
    if (text(detail.id, 240) !== messageId) throw this.malformed("Meta returned a mismatched message ID.");
    return detail;
  }

  private mapMessage(detail: GraphMessageDetail, credential: MetaPagePrivateConversationCredential): ProviderPrivateMessage {
    const externalMessageId = text(detail.id, 240);
    const senderId = text(detail.from?.id, 240);
    const recipients = Array.isArray(detail.to?.data) ? (detail.to!.data as GraphIdentity[]).map((entry) => text(entry.id, 240)).filter((value): value is string => Boolean(value)) : [];
    if (!externalMessageId || !senderId || (senderId !== credential.externalBusinessAccountId && !recipients.includes(credential.externalBusinessAccountId))) {
      throw this.malformed("Meta returned a message outside the connected business account.");
    }
    const body = text(detail.message, 32_768);
    const rawAttachments = Array.isArray(detail.attachments?.data) ? (detail.attachments!.data as GraphAttachment[]).slice(0, 10) : [];
    const attachments: ProviderPrivateAttachment[] = rawAttachments.map((attachment) => {
      const kind = messageKind(attachment.type);
      const url = safeAttachmentUrl(attachment.url ?? attachment.file_url ?? attachment.image_data?.url ?? attachment.video_data?.url);
      return {
        ...(text(attachment.id, 240) ? { externalAttachmentId: text(attachment.id, 240) } : {}),
        kind,
        ...(text(attachment.mime_type, 120) ? { mimeType: text(attachment.mime_type, 120) } : {}),
        ...(typeof attachment.size === "number" && Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? { sizeBytes: attachment.size } : {}),
        ...(url ? { url } : {}),
        cachePolicy: "reference_only" as const,
        availability: url || kind !== "unsupported" ? "available" as const : "unsupported" as const,
      };
    });
    const direction = senderId === credential.externalBusinessAccountId ? "outgoing" as const : "incoming" as const;
    return {
      externalMessageId,
      externalSenderId: senderId,
      direction,
      kind: body ? "text" : attachments[0]?.kind ?? "unsupported",
      ...(body ? { body } : {}),
      attachments,
      isEcho: direction === "outgoing",
      availability: "available",
      deliveryState: direction === "outgoing" ? "sent" : "delivered",
      ...(iso(detail.created_time) ? { providerCreatedAt: iso(detail.created_time) } : {}),
      observationKind: direction === "outgoing" ? "echo" : "message",
    };
  }

  private graphUrl(path: string, credential: MetaPagePrivateConversationCredential, query = new URLSearchParams()): URL {
    const url = new URL(`${this.baseUrl}/${this.options.apiVersion}${path}`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const appsecretTime = String(Math.floor(Date.parse(this.now()) / 1_000));
    url.searchParams.set("appsecret_time", appsecretTime);
    url.searchParams.set("appsecret_proof", createHmac("sha256", this.options.appSecret).update(credential.accessToken).digest("hex"));
    return url;
  }

  private async requestGraph<T extends { error?: GraphError }>(
    path: string,
    credential: MetaPagePrivateConversationCredential,
    init: { method: "GET" | "POST"; query?: URLSearchParams; body?: URLSearchParams; headers?: Record<string, string> },
    operation: "read" | "send",
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(this.graphUrl(path, credential, init.query), {
        method: init.method,
        headers: { authorization: `Bearer ${credential.accessToken}`, accept: "application/json", ...(init.headers ?? {}) },
        ...(init.body ? { body: init.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PrivateConversationConnectorError(
        operation === "send" ? "Meta may have received this private reply. Reconcile before any retry." : "Meta private-message data could not be read.",
        operation === "send" ? "send_transport_uncertain" : "provider_unavailable",
        operation === "send" ? "send_uncertain" : "read_failed",
        operation !== "send",
      );
    }
    const raw = await response.text().catch(() => "");
    if (Buffer.byteLength(raw, "utf8") > this.maxResponseBytes) {
      throw new PrivateConversationConnectorError("Meta returned an oversized private-message response.", "response_too_large", operation === "send" ? "send_uncertain" : "read_failed", false);
    }
    let value: T;
    try { value = JSON.parse(raw) as T; }
    catch {
      throw new PrivateConversationConnectorError("Meta returned an invalid private-message response.", "response_invalid", operation === "send" ? "send_uncertain" : "read_failed", false);
    }
    if (!response.ok || value.error) {
      const code = graphCode(value.error, `http_${response.status}`);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (operation === "send") {
        if (!value.error) throw new PrivateConversationConnectorError("Meta returned an ambiguous private-message send response. Reconcile before any retry.", code, "send_uncertain", false);
        return Promise.reject(new PrivateConversationConnectorError(graphMessage(value.error, "Meta rejected the private reply."), code, "definitely_not_sent", retryable));
      }
      throw new PrivateConversationConnectorError(graphMessage(value.error, "Meta private-message request failed."), code, "read_failed", retryable);
    }
    return value;
  }

  private malformed(message: string): PrivateConversationConnectorError {
    return new PrivateConversationConnectorError(message, "provider_response_invalid", "read_failed", false);
  }
}
