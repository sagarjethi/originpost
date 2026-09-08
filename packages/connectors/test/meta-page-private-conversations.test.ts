import { describe, expect, it, vi } from "vitest";
import {
  MetaPagePrivateConversationConnector,
  PrivateConversationConnectorError,
  metaPrivateGrantSetSha256,
  type MetaPagePrivateConversationCredential,
  type MetaPagePrivateConversationMode,
} from "../src/index.js";

const now = "2026-09-07T10:00:00.000Z";
const accountId = "account-1";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function credential(mode: MetaPagePrivateConversationMode = "facebook_page_messenger"): MetaPagePrivateConversationCredential {
  const scopes = mode === "facebook_page_messenger"
    ? ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "pages_messaging"]
    : ["instagram_basic", "instagram_manage_messages", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "business_management"];
  const externalBusinessAccountId = mode === "facebook_page_messenger" ? "page-1" : "ig-1";
  const endpointPageId = "page-1";
  const pageTasks = ["MESSAGING"];
  const credentialVersion = "credential-v1";
  const accountVersion = "account-v1";
  return {
    externalBusinessAccountId,
    endpointPageId,
    accessToken: "server-only-token",
    scopes,
    pageTasks,
    credentialVersion,
    accountVersion,
    messagingGrant: {
      task: "meta_private_messaging",
      connectionMode: mode,
      apiVersion: "v26.0",
      environment: "test",
      appId: "app-1",
      accountId,
      externalBusinessAccountId,
      endpointPageId,
      credentialVersion,
      accountVersion,
      scopesSha256: metaPrivateGrantSetSha256(scopes),
      pageTasksSha256: metaPrivateGrantSetSha256(pageTasks),
      appReviewReferenceSha256: "c".repeat(64),
      verifiedAt: "2026-09-06T10:00:00.000Z",
      expiresAt: "2026-09-20T10:00:00.000Z",
    },
  };
}

function scope(mode: MetaPagePrivateConversationMode = "facebook_page_messenger") {
  return {
    workspaceId: "workspace-1",
    brandId: "brand-1",
    accountId,
    platform: mode === "facebook_page_messenger" ? "facebook" as const : "instagram" as const,
    connectionMode: mode,
  };
}

function connector(
  mode: MetaPagePrivateConversationMode,
  transport: typeof fetch,
  value = credential(mode),
) {
  return new MetaPagePrivateConversationConnector({
    connectionMode: mode,
    apiVersion: "v26.0",
    appId: "app-1",
    appSecret: "app-secret",
    environment: "test",
    baseUrl: "https://graph.facebook.test",
    fetch: transport,
    now: () => now,
    resolveCredential: async () => value,
  });
}

describe("official Meta Page private-conversation connector", () => {
  it("fails closed until scopes, Page tasks, and the exact expiring live-probe grant match", async () => {
    const incomplete = credential();
    incomplete.scopes = ["pages_messaging"];
    incomplete.pageTasks = [];
    incomplete.messagingGrant = undefined;
    const value = connector("facebook_page_messenger", vi.fn(), incomplete);

    await expect(value.inspectCapability(scope())).resolves.toMatchObject({
      state: "unavailable",
      reason: "permission_missing",
      missingRequirements: expect.arrayContaining([
        "scope:pages_show_list",
        "scope:pages_read_engagement",
        "scope:pages_manage_metadata",
        "Page task:MESSAGING-or-MODERATE",
        "live messaging contract probe",
      ]),
    });
    await expect(value.sync(scope())).rejects.toMatchObject({ code: "contract_unverified", certainty: "read_failed" });
  });

  it("uses the official Page conversations contract and maps recent message details without leaking the token", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: "conversation-1", updated_time: "2026-09-07T09:55:00Z" }], paging: { cursors: { after: "cursor-2" } } }))
      .mockResolvedValueOnce(response({ id: "conversation-1", messages: { data: [{ id: "message-in" }, { id: "message-out" }] } }))
      .mockResolvedValueOnce(response({ id: "message-in", created_time: "2026-09-07T09:50:00Z", from: { id: "customer-1", name: "Customer" }, to: { data: [{ id: "ig-1" }] }, message: "Need help" }))
      .mockResolvedValueOnce(response({ id: "message-out", created_time: "2026-09-07T09:55:00Z", from: { id: "ig-1", username: "publisher" }, to: { data: [{ id: "customer-1" }] }, message: "We can help" }));
    const value = connector("instagram_linked_page", transport);

    const page = await value.sync({ ...scope("instagram_linked_page"), cursor: "cursor-1", limit: 25 });

    expect(page).toMatchObject({
      complete: false,
      nextCursor: "cursor-2",
      conversations: [{
        externalConversationId: "conversation-1",
        messages: [
          { externalMessageId: "message-in", direction: "incoming", observationKind: "message", deliveryState: "delivered" },
          { externalMessageId: "message-out", direction: "outgoing", observationKind: "echo", deliveryState: "sent" },
        ],
      }],
    });
    const firstUrl = new URL(String(transport.mock.calls[0]![0]));
    expect(firstUrl.pathname).toBe("/v26.0/page-1/conversations");
    expect(firstUrl.searchParams.get("platform")).toBe("instagram");
    expect(firstUrl.searchParams.get("after")).toBe("cursor-1");
    expect(firstUrl.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    expect(firstUrl.searchParams.has("access_token")).toBe(false);
    expect(transport.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer server-only-token" });
    expect(JSON.stringify(page)).not.toContain("server-only-token");
  });

  it("subscribes the exact mode fields through the bound Page endpoint", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ success: true }));
    const value = connector("facebook_page_messenger", transport);
    const result = await value.subscribe({ ...scope(), externalBusinessAccountId: "page-1" });

    expect(result.fields).toEqual(["messages", "message_echoes", "message_deliveries", "message_reads", "messaging_policy_enforcement"]);
    expect(new URL(String(transport.mock.calls[0]![0])).pathname).toBe("/v26.0/page-1/subscribed_apps");
    expect(String(transport.mock.calls[0]![1]?.body)).toContain("subscribed_fields=messages%2Cmessage_echoes");
  });

  it("enforces the standard 24-hour reply window and keeps Human Agent disabled without separate review evidence", async () => {
    const value = connector("facebook_page_messenger", vi.fn());
    await expect(value.inspectReplyEligibility({ ...scope(), externalConversationId: "conversation-1", qualifyingEventAt: "2026-09-06T10:00:01.000Z" })).resolves.toMatchObject({
      state: "eligible",
      expiresAt: "2026-09-07T10:00:01.000Z",
      evidence: { mode: "standard", durationSeconds: 86_400 },
    });
    await expect(value.inspectReplyEligibility({ ...scope(), externalConversationId: "conversation-1", qualifyingEventAt: "2026-09-06T10:00:00.000Z" })).resolves.toMatchObject({ state: "ineligible", reason: "window_closed" });
    await expect(value.inspectReplyEligibility({ ...scope(), externalConversationId: "conversation-1", qualifyingEventAt: now, policyPreference: "human_agent" })).resolves.toMatchObject({ state: "ineligible", reason: "contract_unverified" });
  });

  it("sends a bounded RESPONSE message once and requires exact provider evidence", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ recipient_id: "customer-1", message_id: "sent-1" }));
    const value = connector("facebook_page_messenger", transport);
    const result = await value.sendText({
      ...scope(),
      externalConversationId: "conversation-1",
      externalRecipientId: "customer-1",
      body: "Thanks for writing.",
      idempotencyKey: "intent-1",
      eligibility: { state: "eligible", checkedAt: now, expiresAt: "2026-09-07T10:05:00.000Z", contractVersion: "v26.0:messenger-platform-private-v1" },
    });

    expect(result).toMatchObject({ status: "accepted", externalMessageId: "sent-1", externalRecipientId: "customer-1" });
    const sent = new URLSearchParams(String(transport.mock.calls[0]![1]?.body));
    expect(JSON.parse(sent.get("recipient")!)).toEqual({ id: "customer-1" });
    expect(sent.get("messaging_type")).toBe("RESPONSE");
    expect(JSON.parse(sent.get("message")!)).toEqual({ text: "Thanks for writing." });
  });

  it("distinguishes a provider rejection from an ambiguous or lost send result", async () => {
    const request = {
      ...scope(),
      externalConversationId: "conversation-1",
      externalRecipientId: "customer-1",
      body: "Thanks",
      idempotencyKey: "intent-1",
      eligibility: { state: "eligible" as const, checkedAt: now, expiresAt: "2026-09-07T10:05:00.000Z", contractVersion: "v26.0:messenger-platform-private-v1" },
    };
    const rejected = connector("facebook_page_messenger", vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code: 10, message: "Permission denied" } }, 403)));
    await expect(rejected.sendText(request)).rejects.toMatchObject({ code: "meta_10", certainty: "definitely_not_sent" });

    const missingEvidence = connector("facebook_page_messenger", vi.fn<typeof fetch>().mockResolvedValue(response({ success: true })));
    await expect(missingEvidence.sendText(request)).rejects.toMatchObject({ code: "send_evidence_missing", certainty: "send_uncertain" });

    const lost = connector("facebook_page_messenger", vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")));
    await expect(lost.sendText(request)).rejects.toMatchObject({ code: "send_transport_uncertain", certainty: "send_uncertain" });
  });

  it("rejects malformed origins and cross-account probe reuse", async () => {
    expect(() => new MetaPagePrivateConversationConnector({
      connectionMode: "facebook_page_messenger",
      apiVersion: "v26.0",
      appId: "app-1",
      appSecret: "secret",
      environment: "test",
      baseUrl: "https://graph.facebook.com/v26.0",
      resolveCredential: async () => credential(),
    })).toThrow("exact HTTPS Graph origin");

    const rebound = credential();
    rebound.messagingGrant = { ...rebound.messagingGrant!, accountId: "another-account" };
    const value = connector("facebook_page_messenger", vi.fn(), rebound);
    const capability = await value.inspectCapability(scope());
    expect(capability).toMatchObject({ state: "unavailable", reason: "contract_unverified" });
    expect(capability.state === "unavailable" && capability.missingRequirements).toContain("current live messaging contract probe");
    expect(PrivateConversationConnectorError).toBeDefined();
  });
});
