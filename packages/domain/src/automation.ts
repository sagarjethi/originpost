import type { AuditEvent } from "./types.js";

export const automationScopes = ["content:read", "content:write", "content:schedule", "proof:read", "imports:write", "events:read", "events:manage"] as const;
export type AutomationScope = (typeof automationScopes)[number];

export const automationTopics = ["system.test", "content.created", "draft.revised", "approval.needed", "approval.decided", "target.scheduled", "target.rescheduled", "target.cancelled", "publish.succeeded", "publish.failed", "publish.action_required", "proof.created"] as const;
export type AutomationTopic = (typeof automationTopics)[number];

export interface AutomationApiKey {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  secretHash: string;
  scopes: AutomationScope[];
  brandIds: string[];
  accountIds: string[];
  createdBy: string;
  createdAt: string;
  expiresAt?: string | undefined;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface AutomationSecretEnvelope {
  keyVersion: "v1";
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface AutomationWebhookSubscription {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  topics: AutomationTopic[];
  brandIds: string[];
  secret: AutomationSecretEnvelope;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | undefined;
}

export interface AutomationEvent {
  id: string;
  workspaceId: string;
  brandId?: string | undefined;
  topic: AutomationTopic;
  contentItemId?: string | undefined;
  aggregateVersion?: number | undefined;
  occurredAt: string;
  actorType: AuditEvent["actorType"];
  payload: Record<string, unknown>;
}

export type AutomationDeliveryStatus = "pending" | "processing" | "delivered" | "failed" | "dead_letter";

export interface AutomationWebhookDelivery {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  eventId: string;
  status: AutomationDeliveryStatus;
  attempts: number;
  availableAt: string;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  responseStatus?: number | undefined;
  responseSha256?: string | undefined;
  lastError?: string | undefined;
  deliveredAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type AutomationImportFormat = "csv" | "json";
export type AutomationImportStatus = "staged" | "processing" | "committed" | "failed";
export type AutomationImportRowStatus = "valid" | "invalid" | "created" | "existing" | "failed";

export interface AutomationImportRow {
  rowNumber: number;
  externalRef: string;
  title: string;
  summary: string;
  researchDepth: "quick" | "standard" | "deep";
  riskLevel: "low" | "medium" | "high" | "sensitive";
  status: AutomationImportRowStatus;
  errors: string[];
  contentItemId?: string | undefined;
}

export interface AutomationImportSession {
  id: string;
  workspaceId: string;
  apiKeyId: string;
  brandId: string;
  format: AutomationImportFormat;
  sourceSha256: string;
  status: AutomationImportStatus;
  rows: AutomationImportRow[];
  createdAt: string;
  updatedAt: string;
  committedAt?: string | undefined;
  failureReason?: string | undefined;
}

export function automationTopicFromAudit(event: AuditEvent): AutomationTopic | null {
  if (event.action === "content.created") return "content.created";
  if (event.action === "draft.added") return "draft.revised";
  if (event.action === "content.transitioned" && event.detail.to === "review") return "approval.needed";
  if (event.action === "approval.recorded") return "approval.decided";
  if (event.action === "publish.scheduled") return "target.scheduled";
  if (event.action === "publish.rescheduled") return "target.rescheduled";
  if (event.action === "publish.cancelled") return "target.cancelled";
  if (event.action === "publish.target_status" && event.detail.status === "failed") return "publish.failed";
  if (event.action === "publish.target_status" && event.detail.status === "action_required") return "publish.action_required";
  if (event.action === "publish.proof_recorded" || event.action === "publish.manual_confirmed" || event.action === "publish.provider_reconciled") return "proof.created";
  if (event.action === "publish.attempt_succeeded") return "publish.succeeded";
  return null;
}

export interface AutomationRepository {
  saveApiKey(key: AutomationApiKey, event: AuditEvent): Promise<void>;
  listApiKeys(workspaceId: string): Promise<AutomationApiKey[]>;
  getApiKey(workspaceId: string, id: string): Promise<AutomationApiKey | null>;
  authenticateApiKey(secretHash: string, now: string): Promise<AutomationApiKey | null>;
  touchApiKey(id: string, lastUsedAt: string): Promise<void>;
  revokeApiKey(workspaceId: string, id: string, revokedAt: string, event: AuditEvent): Promise<AutomationApiKey | null>;
  saveSubscription(subscription: AutomationWebhookSubscription, event: AuditEvent): Promise<void>;
  listSubscriptions(workspaceId: string): Promise<AutomationWebhookSubscription[]>;
  getSubscription(workspaceId: string, id: string): Promise<AutomationWebhookSubscription | null>;
  disableSubscription(workspaceId: string, id: string, disabledAt: string, event: AuditEvent): Promise<AutomationWebhookSubscription | null>;
  recordEvent(event: AutomationEvent): Promise<void>;
  recordTestEvent(event: AutomationEvent, subscriptionId: string): Promise<void>;
  recordEventFromAudit(event: AuditEvent, brandId?: string): Promise<void>;
  listEvents(workspaceId: string, limit?: number): Promise<AutomationEvent[]>;
  listDeliveries(workspaceId: string, limit?: number): Promise<AutomationWebhookDelivery[]>;
  deliveryStatusSummary(workspaceId: string): Promise<{ counts: Partial<Record<AutomationDeliveryStatus, number>>; latestDeadLetterId?: string | undefined; latestDeadLetterAt?: string | undefined }>;
  getDelivery(id: string): Promise<{ delivery: AutomationWebhookDelivery; event: AutomationEvent; subscription: AutomationWebhookSubscription } | null>;
  claimDeliveries(owner: string, now: string, limit?: number, leaseSeconds?: number): Promise<AutomationWebhookDelivery[]>;
  completeDelivery(id: string, owner: string, responseStatus: number, responseSha256: string, completedAt: string): Promise<void>;
  failDelivery(id: string, owner: string, error: string, retryAt: string, failedAt: string, maxAttempts?: number): Promise<void>;
  retryDelivery(workspaceId: string, id: string, retryAt: string): Promise<boolean>;
  saveImportSession(session: AutomationImportSession): Promise<void>;
  getImportSession(workspaceId: string, id: string): Promise<AutomationImportSession | null>;
  claimImportSession(workspaceId: string, id: string, apiKeyId: string, claimedAt: string, staleBefore: string): Promise<AutomationImportSession | null>;
  completeImportSession(workspaceId: string, id: string, rows: AutomationImportRow[], completedAt: string): Promise<AutomationImportSession | null>;
  failImportSession(workspaceId: string, id: string, reason: string, failedAt: string): Promise<void>;
}

export class InMemoryAutomationRepository implements AutomationRepository {
  private readonly keys = new Map<string, AutomationApiKey>();
  private readonly subscriptions = new Map<string, AutomationWebhookSubscription>();
  private readonly events = new Map<string, AutomationEvent>();
  private readonly deliveries = new Map<string, AutomationWebhookDelivery>();
  private readonly imports = new Map<string, AutomationImportSession>();

  async saveApiKey(key: AutomationApiKey): Promise<void> { this.keys.set(key.id, structuredClone(key)) }
  async listApiKeys(workspaceId: string): Promise<AutomationApiKey[]> { return [...this.keys.values()].filter((key) => key.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((key) => structuredClone(key)) }
  async getApiKey(workspaceId: string, id: string): Promise<AutomationApiKey | null> { const key = this.keys.get(id); return key?.workspaceId === workspaceId ? structuredClone(key) : null }
  async authenticateApiKey(secretHash: string, now: string): Promise<AutomationApiKey | null> { const key = [...this.keys.values()].find((entry) => entry.secretHash === secretHash && !entry.revokedAt && (!entry.expiresAt || entry.expiresAt > now)); return key ? structuredClone(key) : null }
  async touchApiKey(id: string, lastUsedAt: string): Promise<void> { const key = this.keys.get(id); if (key) this.keys.set(id, { ...key, lastUsedAt }) }
  async revokeApiKey(workspaceId: string, id: string, revokedAt: string): Promise<AutomationApiKey | null> { const key = this.keys.get(id); if (!key || key.workspaceId !== workspaceId) return null; const next = { ...key, revokedAt }; this.keys.set(id, next); return structuredClone(next) }
  async saveSubscription(subscription: AutomationWebhookSubscription): Promise<void> { this.subscriptions.set(subscription.id, structuredClone(subscription)) }
  async listSubscriptions(workspaceId: string): Promise<AutomationWebhookSubscription[]> { return [...this.subscriptions.values()].filter((entry) => entry.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((entry) => structuredClone(entry)) }
  async getSubscription(workspaceId: string, id: string): Promise<AutomationWebhookSubscription | null> { const entry = this.subscriptions.get(id); return entry?.workspaceId === workspaceId ? structuredClone(entry) : null }
  async disableSubscription(workspaceId: string, id: string, disabledAt: string): Promise<AutomationWebhookSubscription | null> { const entry = this.subscriptions.get(id); if (!entry || entry.workspaceId !== workspaceId) return null; const next = { ...entry, active: false, disabledAt, updatedAt: disabledAt }; this.subscriptions.set(id, next); for (const delivery of this.deliveries.values()) if (delivery.subscriptionId === id && ["pending", "processing", "failed"].includes(delivery.status)) this.deliveries.set(delivery.id, { ...delivery, status: "dead_letter", lastError: "Webhook subscription disabled.", leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: disabledAt }); return structuredClone(next) }
  async recordEvent(event: AutomationEvent): Promise<void> {
    if (this.events.has(event.id)) return;
    this.events.set(event.id, structuredClone(event));
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active || subscription.workspaceId !== event.workspaceId || !subscription.topics.includes(event.topic) || (subscription.brandIds.length && (!event.brandId || !subscription.brandIds.includes(event.brandId)))) continue;
      const id = `delivery_${subscription.id}_${event.id}`;
      this.deliveries.set(id, { id, workspaceId: event.workspaceId, subscriptionId: subscription.id, eventId: event.id, status: "pending", attempts: 0, availableAt: event.occurredAt, createdAt: event.occurredAt, updatedAt: event.occurredAt });
    }
  }
  async recordTestEvent(event: AutomationEvent, subscriptionId: string): Promise<void> { if (this.events.has(event.id)) return; const subscription = this.subscriptions.get(subscriptionId); if (!subscription?.active || subscription.workspaceId !== event.workspaceId) return; this.events.set(event.id, structuredClone(event)); const id = `delivery_${subscription.id}_${event.id}`; this.deliveries.set(id, { id, workspaceId: event.workspaceId, subscriptionId: subscription.id, eventId: event.id, status: "pending", attempts: 0, availableAt: event.occurredAt, createdAt: event.occurredAt, updatedAt: event.occurredAt }) }
  async recordEventFromAudit(event: AuditEvent, brandId?: string): Promise<void> {
    const topic = automationTopicFromAudit(event); if (!topic) return;
    await this.recordEvent({ id: `automation_${event.id}`, workspaceId: event.workspaceId, ...(brandId ? { brandId } : {}), topic, ...(event.contentItemId ? { contentItemId: event.contentItemId } : {}), aggregateVersion: typeof event.detail.contentVersion === "number" ? event.detail.contentVersion : undefined, occurredAt: event.createdAt, actorType: event.actorType, payload: { action: event.action, ...event.detail } });
  }
  async listEvents(workspaceId: string, limit = 100): Promise<AutomationEvent[]> { return [...this.events.values()].filter((entry) => entry.workspaceId === workspaceId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit).map((entry) => structuredClone(entry)) }
  async listDeliveries(workspaceId: string, limit = 100): Promise<AutomationWebhookDelivery[]> { return [...this.deliveries.values()].filter((entry) => entry.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((entry) => structuredClone(entry)) }
  async deliveryStatusSummary(workspaceId: string) {
    const deliveries = [...this.deliveries.values()].filter((entry) => entry.workspaceId === workspaceId);
    const counts: Partial<Record<AutomationDeliveryStatus, number>> = {};
    for (const entry of deliveries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    const latest = deliveries.filter((entry) => entry.status === "dead_letter").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return { counts, ...(latest ? { latestDeadLetterId: latest.id, latestDeadLetterAt: latest.updatedAt } : {}) };
  }
  async getDelivery(id: string) { const delivery = this.deliveries.get(id); const event = delivery ? this.events.get(delivery.eventId) : undefined; const subscription = delivery ? this.subscriptions.get(delivery.subscriptionId) : undefined; return delivery && event && subscription ? { delivery: structuredClone(delivery), event: structuredClone(event), subscription: structuredClone(subscription) } : null }
  async claimDeliveries(owner: string, now: string, limit = 20, leaseSeconds = 60): Promise<AutomationWebhookDelivery[]> {
    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString(); const claimed: AutomationWebhookDelivery[] = [];
    for (const delivery of [...this.deliveries.values()].sort((a, b) => a.availableAt.localeCompare(b.availableAt))) {
      if (claimed.length >= limit || delivery.availableAt > now || !(delivery.status === "pending" || delivery.status === "failed" || (delivery.status === "processing" && (delivery.leaseExpiresAt ?? "") <= now))) continue;
      const next = { ...delivery, status: "processing" as const, attempts: delivery.attempts + 1, leaseOwner: owner, leaseExpiresAt, updatedAt: now }; this.deliveries.set(delivery.id, next); claimed.push(structuredClone(next));
    }
    return claimed;
  }
  async completeDelivery(id: string, owner: string, responseStatus: number, responseSha256: string, completedAt: string): Promise<void> { const entry = this.deliveries.get(id); if (entry?.status === "processing" && entry.leaseOwner === owner) this.deliveries.set(id, { ...entry, status: "delivered", responseStatus, responseSha256, deliveredAt: completedAt, updatedAt: completedAt, leaseOwner: undefined, leaseExpiresAt: undefined, lastError: undefined }) }
  async failDelivery(id: string, owner: string, error: string, retryAt: string, failedAt: string, maxAttempts = 8): Promise<void> { const entry = this.deliveries.get(id); if (entry?.status === "processing" && entry.leaseOwner === owner) this.deliveries.set(id, { ...entry, status: entry.attempts >= maxAttempts ? "dead_letter" : "failed", lastError: error.slice(0, 500), availableAt: retryAt, updatedAt: failedAt, leaseOwner: undefined, leaseExpiresAt: undefined }) }
  async retryDelivery(workspaceId: string, id: string, retryAt: string): Promise<boolean> { const entry = this.deliveries.get(id); if (!entry || entry.workspaceId !== workspaceId || !["failed", "dead_letter"].includes(entry.status)) return false; this.deliveries.set(id, { ...entry, status: "pending", availableAt: retryAt, updatedAt: retryAt, lastError: undefined }); return true }
  async saveImportSession(session: AutomationImportSession): Promise<void> { if (!this.imports.has(session.id)) this.imports.set(session.id, structuredClone(session)) }
  async getImportSession(workspaceId: string, id: string): Promise<AutomationImportSession | null> { const session = this.imports.get(id); return session?.workspaceId === workspaceId ? structuredClone(session) : null }
  async claimImportSession(workspaceId: string, id: string, apiKeyId: string, claimedAt: string, staleBefore: string): Promise<AutomationImportSession | null> { const session = this.imports.get(id); if (!session || session.workspaceId !== workspaceId || session.apiKeyId !== apiKeyId || session.status === "committed" || !(session.status === "staged" || (session.status === "processing" && session.updatedAt <= staleBefore))) return null; const next = { ...session, status: "processing" as const, updatedAt: claimedAt, failureReason: undefined }; this.imports.set(id, next); return structuredClone(next) }
  async completeImportSession(workspaceId: string, id: string, rows: AutomationImportRow[], completedAt: string): Promise<AutomationImportSession | null> { const session = this.imports.get(id); if (!session || session.workspaceId !== workspaceId || session.status !== "processing") return null; const next = { ...session, status: "committed" as const, rows: structuredClone(rows), committedAt: completedAt, updatedAt: completedAt }; this.imports.set(id, next); return structuredClone(next) }
  async failImportSession(workspaceId: string, id: string, reason: string, failedAt: string): Promise<void> { const session = this.imports.get(id); if (session?.workspaceId === workspaceId && session.status === "processing") this.imports.set(id, { ...session, status: "failed", failureReason: reason.slice(0, 500), updatedAt: failedAt }) }
}
