import { describe, expect, it } from "vitest";
import {
  applyPrivateMessageObservation,
  can,
  canTransitionPrivateReplyIntent,
  claimPrivateReplyIntent,
  privateConversationBodyIntegrityKey,
  privateConversationConnectionModes,
  privateConversationPlatformForMode,
  revisePrivateReplyIntent,
  transitionPrivateReplyIntent,
  type ChannelCapability,
  type NotificationKind,
  type PrivateMessage,
  type PrivateReplyEligibility,
  type PrivateReplyIntent,
} from "../src/index.js";

const now = "2026-08-31T12:00:00.000Z";
const body = "Thanks for your message.";
const digestKey = new Uint8Array(32).fill(7);
const intent: PrivateReplyIntent = {
  id: "private-intent-1",
  workspaceId: "workspace-1",
  brandId: "brand-1",
  conversationId: "conversation-1",
  inReplyToMessageId: "message-1",
  body,
  bodyIntegrityKey: privateConversationBodyIntegrityKey(body, digestKey),
  status: "pending_approval",
  idempotencyKey: "private-message:reply:private-intent-1:v1",
  requestedBy: "creator-1",
  attemptCount: 0,
  createdAt: now,
  updatedAt: now,
  version: 1,
};

const standardEligibility: PrivateReplyEligibility = {
  state: "eligible",
  checkedAt: now,
  expiresAt: "2026-09-01T12:00:00.000Z",
  evidence: { mode: "standard", qualifyingEventAt: now, durationSeconds: 86_400 },
  contractVersion: "test-v1",
};

const message: PrivateMessage = {
  id: "message-1",
  workspaceId: "workspace-1",
  brandId: "brand-1",
  conversationId: "conversation-1",
  accountId: "account-1",
  platform: "instagram",
  connectionMode: "instagram_login",
  providerMessageKey: "provider-key-1",
  direction: "incoming",
  kind: "text",
  body: "Please delete this",
  bodyIntegrityKey: privateConversationBodyIntegrityKey("Please delete this", digestKey),
  attachments: [{ id: "attachment-1", kind: "image", providerAttachmentKey: "provider-attachment-1", url: "https://example.test/private.jpg", cachePolicy: "reference_only", availability: "available" }],
  isEcho: false,
  availability: "available",
  deliveryState: "delivered",
  providerCreatedAt: now,
  firstSeenAt: now,
  lastSeenAt: now,
  source: "webhook",
  observationKind: "message",
};

describe("private conversations domain", () => {
  it("keeps all three Meta connection modes distinct", () => {
    expect(privateConversationConnectionModes).toEqual(["facebook_page_messenger", "instagram_linked_page", "instagram_login"]);
    expect(privateConversationPlatformForMode("facebook_page_messenger")).toBe("facebook");
    expect(privateConversationPlatformForMode("instagram_linked_page")).toBe("instagram");
    expect(privateConversationPlatformForMode("instagram_login")).toBe("instagram");
  });

  it("adds private-message account and notification types without widening automated send permissions", () => {
    const capabilities: ChannelCapability[] = ["private_message_read", "private_message_send"];
    const notifications: NotificationKind[] = ["private_message_new_activity", "private_message_reply_failed", "private_message_permission_missing"];
    expect(capabilities).toHaveLength(2);
    expect(notifications).toHaveLength(3);
    expect(can("creator", "engagement:draft")).toBe(true);
    expect(can("creator", "engagement:send")).toBe(false);
    expect(can("manager", "engagement:send")).toBe(true);
    expect(can("viewer", "engagement:read")).toBe(true);
  });

  it("invalidates approval and provider evidence when exact reply text changes", () => {
    const revised = revisePrivateReplyIntent({
      ...intent,
      status: "failed",
      approvedBy: "manager-1",
      eligibilityAtApproval: standardEligibility,
      providerMessageKey: "stale-key",
      errorCode: "provider_rejected",
      completedAt: now,
    }, "  A changed reply.  ", "creator-2", "2026-08-31T12:01:00.000Z", digestKey);
    expect(revised).toMatchObject({ body: "A changed reply.", status: "pending_approval", requestedBy: "creator-2", version: 2 });
    expect(revised.idempotencyKey).toContain(revised.bodyIntegrityKey);
    expect(revised.approvedBy).toBeUndefined();
    expect(revised.providerMessageKey).toBeUndefined();
    expect(revised.eligibilityAtApproval).toBeUndefined();
  });

  it("requires a current eligible provider snapshot and exact human approval before queueing", () => {
    expect(() => transitionPrivateReplyIntent(intent, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: "manager-1", approvedBy: "manager-1", at: now })).toThrow("eligibility");
    expect(() => transitionPrivateReplyIntent(intent, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: "manager-1", approvedBy: "manager-2", eligibilityAtApproval: standardEligibility, at: now })).toThrow("must approve");
    expect(transitionPrivateReplyIntent(intent, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: "manager-1", approvedBy: "manager-1", eligibilityAtApproval: standardEligibility, at: now })).toMatchObject({
      status: "queued",
      approvedBy: "manager-1",
      eligibilityAtApproval: standardEligibility,
      version: 2,
    });
  });

  it("accepts a reviewed Human Agent window only with explicit human-only evidence", () => {
    const humanEligibility: PrivateReplyEligibility = {
      state: "eligible",
      checkedAt: now,
      expiresAt: "2026-09-07T12:00:00.000Z",
      evidence: {
        mode: "human_agent",
        qualifyingEventAt: now,
        durationSeconds: 604_800,
        review: { reviewedAt: now, referenceSha256: "a".repeat(64), humanOnly: true, contractVersion: "review-v1" },
      },
      contractVersion: "test-v1",
    };
    expect(transitionPrivateReplyIntent(intent, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: "manager-1", approvedBy: "manager-1", eligibilityAtApproval: humanEligibility, at: now })).toMatchObject({ status: "queued", eligibilityAtApproval: humanEligibility });
  });

  it("requires exact provider evidence before success and preserves uncertain as non-retryable", () => {
    const processing = { ...intent, status: "processing" as const, approvedBy: "manager-1", eligibilityAtApproval: standardEligibility, attemptCount: 1, leaseOwner: "worker-1", leaseExpiresAt: "2026-08-31T12:05:00.000Z" };
    expect(() => transitionPrivateReplyIntent(processing, { intentId: intent.id, expectedVersion: 1, to: "succeeded", actorId: "system", leaseOwner: "worker-1", at: now })).toThrow("provider send evidence");
    expect(transitionPrivateReplyIntent(processing, { intentId: intent.id, expectedVersion: 1, to: "uncertain", actorId: "system", leaseOwner: "worker-1", at: now, errorCode: "transport_ambiguous" })).toMatchObject({ status: "uncertain", errorCode: "transport_ambiguous", leaseOwner: undefined });
    expect(canTransitionPrivateReplyIntent("uncertain", "queued")).toBe(false);
    expect(transitionPrivateReplyIntent({ ...processing, status: "uncertain", leaseOwner: undefined, leaseExpiresAt: undefined }, { intentId: intent.id, expectedVersion: 1, to: "succeeded", actorId: "manager-1", at: now, providerMessageKey: "provider-message-key", providerAcceptedAt: now })).toMatchObject({ status: "succeeded", providerMessageKey: "provider-message-key" });
  });

  it("uses a bounded atomic execution lease instead of a generic queued-to-processing transition", () => {
    const queued = transitionPrivateReplyIntent(intent, { intentId: intent.id, expectedVersion: 1, to: "queued", actorId: "manager-1", approvedBy: "manager-1", eligibilityAtApproval: standardEligibility, at: now });
    expect(canTransitionPrivateReplyIntent("queued", "processing")).toBe(false);
    const claimed = claimPrivateReplyIntent(queued, { intentId: queued.id, expectedVersion: queued.version, owner: "worker-1", at: now, leaseSeconds: 300 });
    expect(claimed).toMatchObject({ status: "processing", attemptCount: 1, leaseOwner: "worker-1", leaseExpiresAt: "2026-08-31T12:05:00.000Z", version: 3 });
    expect(() => claimPrivateReplyIntent(claimed, { intentId: claimed.id, expectedVersion: claimed.version, owner: "worker-2", at: now, leaseSeconds: 300 })).toThrow("Only a queued");
    expect(() => transitionPrivateReplyIntent(claimed, { intentId: claimed.id, expectedVersion: claimed.version, to: "uncertain", actorId: "system", leaseOwner: "worker-2", at: now })).toThrow("leased by another worker");
  });

  it("scrubs content and attachment references on a deleted or unsent observation", () => {
    const deleted = applyPrivateMessageObservation(message, { kind: "deleted", observedAt: "2026-08-31T12:05:00.000Z" });
    expect(deleted).toMatchObject({ availability: "deleted", body: undefined, bodyIntegrityKey: undefined, deletedAt: "2026-08-31T12:05:00.000Z", observationKind: "deleted" });
    expect(deleted.attachments[0]).toMatchObject({ providerAttachmentKey: undefined, url: undefined, availability: "deleted" });
  });

  it("applies delivery and read observations monotonically", () => {
    const read = applyPrivateMessageObservation(message, { kind: "read", observedAt: "2026-08-31T12:06:00.000Z" });
    const lateDelivery = applyPrivateMessageObservation(read, { kind: "delivery", deliveryState: "delivered", observedAt: "2026-08-31T12:07:00.000Z" });
    expect(read).toMatchObject({ deliveryState: "read", readAt: "2026-08-31T12:06:00.000Z" });
    expect(lateDelivery.deliveryState).toBe("read");
  });
});
