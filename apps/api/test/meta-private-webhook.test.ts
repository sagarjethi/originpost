import { describe, expect, it } from "vitest";
import { normalizeMetaPrivateWebhookEvent } from "../src/private-conversations/meta-private-webhook.js";

describe("Meta private webhook normalization", () => {
  it("maps incoming, echo, delete, delivery, read, and reaction routing metadata", () => {
    const business = "business-1";
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: "person-1" }, recipient: { id: business }, timestamp: 1_787_997_590_000, message: { mid: "m-1", text: "secret" } }, business)).toMatchObject({ type: "message", direction: "incoming", externalParticipantId: "person-1", externalMessageId: "m-1" });
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: business }, recipient: { id: "person-1" }, timestamp: 1_787_997_590_000, message: { mid: "m-2", is_echo: true } }, business)).toMatchObject({ type: "message_echo", direction: "outgoing", isEcho: true });
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: "person-1" }, recipient: { id: business }, message: { mid: "m-1", is_deleted: true, text: "must not survive" } }, business)).toMatchObject({ type: "message_deleted", externalMessageId: "m-1" });
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: business }, recipient: { id: "person-1" }, delivery: { mids: ["m-2"], watermark: 1_787_997_590_000 } }, business)).toMatchObject({ type: "delivery", messageIds: ["m-2"] });
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: "person-1" }, recipient: { id: business }, read: { watermark: 1_787_997_590_000 } }, business)).toMatchObject({ type: "read" });
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: "person-1" }, recipient: { id: business }, reaction: { mid: "m-2", action: "react", emoji: "❤" } }, business)).toMatchObject({ type: "reaction", action: "react", reaction: "❤" });
  });

  it("rejects events whose sender and recipient are outside the bound business account", () => {
    expect(normalizeMetaPrivateWebhookEvent({ sender: { id: "person-1" }, recipient: { id: "another-business" }, message: { mid: "m-1" } }, "business-1")).toBeNull();
  });
});
