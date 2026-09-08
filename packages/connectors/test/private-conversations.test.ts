import { describe, expect, it } from "vitest";
import {
  ConnectorRegistry,
  createSafeConnectorRegistry,
  MockPrivateConversationConnector,
  PrivateConversationConnectorError,
  type PrivateConversationConnector,
  type SendPrivateTextRequest,
} from "../src/index.js";

const now = "2026-08-31T12:00:00.000Z";
const connector = new MockPrivateConversationConnector({ connectionMode: "instagram_login", now: () => now });
const scope = {
  workspaceId: "workspace-1",
  brandId: "brand-1",
  accountId: "account-1",
  platform: "instagram" as const,
  connectionMode: "instagram_login" as const,
};

describe("private-conversation connector seam", () => {
  it("keeps private messaging disabled by default and rejects production mock mode", () => {
    expect(createSafeConnectorRegistry().listPrivateConversations()).toEqual([]);
    expect(createSafeConnectorRegistry({ privateConversationMode: "official", nodeEnv: "development" }).listPrivateConversations()).toEqual([]);
    expect(() => createSafeConnectorRegistry({ privateConversationMode: "mock", nodeEnv: "production" })).toThrow("forbidden in production");
  });

  it("registers one safe mock adapter for each distinct connection mode", () => {
    const registry = createSafeConnectorRegistry({ privateConversationMode: "mock", nodeEnv: "test" });
    expect(registry.listPrivateConversations().map((entry) => entry.privateConversationManifest.connectionMode).sort()).toEqual([
      "facebook_page_messenger",
      "instagram_linked_page",
      "instagram_login",
    ]);
    expect(registry.getPrivateConversations("facebook_page_messenger").privateConversationManifest.platform).toBe("facebook");
    expect(registry.getPrivateConversations("instagram_linked_page").privateConversationManifest.platform).toBe("instagram");
    expect(registry.getPrivateConversations("instagram_login").privateConversationManifest.platform).toBe("instagram");
  });

  it("keeps private connectors separate from public-comment adapters", () => {
    const registry = createSafeConnectorRegistry({ privateConversationMode: "mock", nodeEnv: "test" });
    expect(registry.getEngagement("instagram")).not.toBe(registry.getPrivateConversations("instagram_login"));
    expect(registry.getEngagement("facebook")).not.toBe(registry.getPrivateConversations("facebook_page_messenger"));
  });

  it("rejects an invalid platform and connection-mode registration", () => {
    const registry = new ConnectorRegistry();
    const invalid = {
      ...connector,
      privateConversationManifest: { ...connector.privateConversationManifest, platform: "facebook" as const },
    } as PrivateConversationConnector;
    expect(() => registry.registerPrivateConversations(invalid)).toThrow("invalid platform/connection-mode pairing");
  });

  it("returns contract metadata and bounded provider observations without network access", async () => {
    await expect(connector.inspectCapability(scope)).resolves.toMatchObject({
      state: "available",
      contractVersion: "mock-private-messages-v1",
      text: { maxUtf8Bytes: 1_000, supportsReplyToMessage: true },
    });
    const page = await connector.sync(scope);
    expect(page).toMatchObject({ complete: true, conversations: [{ messages: [{ direction: "incoming", observationKind: "message", availability: "available" }] }] });
    expect(connector.privateConversationManifest.capabilities.observations).toEqual(["message", "echo", "deleted", "delivery", "read", "reaction"]);
  });

  it("computes standard eligibility from connector policy data rather than a domain constant", async () => {
    const shortWindow = new MockPrivateConversationConnector({ connectionMode: "instagram_login", standardWindowSeconds: 90, now: () => now });
    const eligible = await shortWindow.inspectReplyEligibility({ ...scope, externalConversationId: "conversation-1", qualifyingEventAt: "2026-08-31T11:59:00.000Z" });
    const closed = await shortWindow.inspectReplyEligibility({ ...scope, externalConversationId: "conversation-1", qualifyingEventAt: "2026-08-31T11:58:00.000Z" });
    expect(eligible).toMatchObject({ state: "eligible", evidence: { mode: "standard", durationSeconds: 90 } });
    expect(closed).toMatchObject({ state: "ineligible", reason: "window_closed", evidence: { durationSeconds: 90 } });
  });

  it("requires reviewed human-only evidence before exposing an extended Human Agent window", async () => {
    await expect(connector.inspectReplyEligibility({ ...scope, externalConversationId: "conversation-1", qualifyingEventAt: now, policyPreference: "human_agent" })).resolves.toMatchObject({ state: "ineligible", reason: "contract_unverified" });
    const reviewed = new MockPrivateConversationConnector({
      connectionMode: "instagram_login",
      now: () => now,
      humanAgentWindowSeconds: 604_800,
      humanAgentReview: { reviewedAt: now, referenceSha256: "a".repeat(64), humanOnly: true, contractVersion: "mock-review-v1" },
    });
    await expect(reviewed.inspectReplyEligibility({ ...scope, externalConversationId: "conversation-1", qualifyingEventAt: now, policyPreference: "human_agent" })).resolves.toMatchObject({
      state: "eligible",
      evidence: { mode: "human_agent", durationSeconds: 604_800, review: { humanOnly: true, contractVersion: "mock-review-v1" } },
    });
  });

  it("sends text idempotently, exposes exact echo evidence, and rejects key reuse with different content", async () => {
    const eligibility = await connector.inspectReplyEligibility({ ...scope, externalConversationId: "conversation-1", qualifyingEventAt: now });
    const request: SendPrivateTextRequest = {
      ...scope,
      externalConversationId: "conversation-1",
      externalRecipientId: "recipient-1",
      inReplyToExternalMessageId: "incoming-message-1",
      body: "Thanks for writing.",
      idempotencyKey: "private-send-1",
      eligibility,
    };
    const first = await connector.sendText(request);
    const second = await connector.sendText(request);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: "accepted", externalRecipientId: "recipient-1" });
    if (first.status !== "accepted") throw new Error("Mock send was not accepted.");
    await expect(connector.inspectMessage({ ...scope, externalConversationId: "conversation-1", externalMessageId: first.externalMessageId })).resolves.toMatchObject({
      state: "found",
      message: { isEcho: true, observationKind: "echo", deliveryState: "sent", body: "Thanks for writing." },
    });
    await expect(connector.sendText({ ...request, body: "Different text" })).rejects.toBeInstanceOf(PrivateConversationConnectorError);
  });

  it("enforces the text maximum supplied by the connector contract", async () => {
    const tiny = new MockPrivateConversationConnector({ connectionMode: "instagram_login", text: { maxUtf8Bytes: 4 }, now: () => now });
    const eligibility = await tiny.inspectReplyEligibility({ ...scope, externalConversationId: "conversation-1", qualifyingEventAt: now });
    await expect(tiny.sendText({ ...scope, externalConversationId: "conversation-1", externalRecipientId: "recipient-1", body: "12345", idempotencyKey: "too-long", eligibility })).resolves.toMatchObject({ status: "rejected", code: "message_too_long" });
  });
});
