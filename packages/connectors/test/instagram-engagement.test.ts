import { describe, expect, it } from "vitest";
import { ConnectorRegistry, InstagramOfficialConnector, MockInstagramConnector, type ReadCommentsRequest, type ReplyToCommentRequest, type SubscribeCommentsRequest } from "../src/index.js";

const scope = { workspaceId: "workspace-1", brandId: "brand-1", accountId: "account-1", platform: "instagram" as const };
const readRequest: ReadCommentsRequest = { ...scope, externalMediaId: "media-900" };
const replyRequest: ReplyToCommentRequest = { ...scope, externalCommentId: "comment-1", body: "Thanks for asking.", idempotencyKey: "engagement:action-1:v1" };
const subscribeRequest: SubscribeCommentsRequest = { ...scope, externalAccountId: "ig-123" };

const makeConnector = (transport: typeof fetch) => new InstagramOfficialConnector({
  apiVersion: "v25.0",
  baseUrl: "https://graph.test",
  fetch: transport,
  resolveCredential: async () => ({ externalAccountId: "ig-123", accessToken: "server-only-token" }),
});

describe("Instagram engagement connector", () => {
  it("follows top-level and reply pagination, including an empty page that still has next", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes("/media-900/comments") && !url.includes("after=page-2")) return new Response(JSON.stringify({ data: [], paging: { next: "https://graph.test/v25.0/media-900/comments?after=page-2&access_token=server-only-token" } }), { status: 200 });
      if (url.includes("/media-900/comments") && url.includes("after=page-2")) return new Response(JSON.stringify({ data: [{ id: "comment-1", text: "First", hidden: false, timestamp: "2026-08-29T10:00:00Z", from: { id: "author-1", username: "reader_one" } }], paging: {} }), { status: 200 });
      if (url.includes("/comment-1/replies") && !url.includes("after=reply-2")) return new Response(JSON.stringify({ data: [{ id: "reply-1", text: "Reply one", hidden: false, timestamp: "2026-08-29T10:01:00Z", username: "originpost" }], paging: { next: "https://graph.test/v25.0/comment-1/replies?after=reply-2&access_token=server-only-token" } }), { status: 200 });
      if (url.includes("/comment-1/replies") && url.includes("after=reply-2")) return new Response(JSON.stringify({ data: [{ id: "reply-2", text: "Reply two", hidden: true, timestamp: "2026-08-29T10:02:00Z" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 });
    };
    const result = await makeConnector(transport as typeof fetch).readComments(readRequest);
    expect(result.comments).toEqual([
      expect.objectContaining({ externalCommentId: "comment-1", authorScopedId: "author-1", body: "First", visibility: "visible" }),
      expect.objectContaining({ externalCommentId: "reply-1", parentExternalCommentId: "comment-1", visibility: "visible" }),
      expect.objectContaining({ externalCommentId: "reply-2", parentExternalCommentId: "comment-1", visibility: "hidden" }),
    ]);
    expect(result.complete).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => !call.url.includes("server-only-token"))).toBe(true);
    expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer server-only-token")).toBe(true);
    expect(JSON.stringify(result.rawResponse)).not.toContain("server-only-token");
  });

  it("posts an exact public reply without exposing the token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify({ id: "reply-900" }), { status: 200 }); };
    const result = await makeConnector(transport as typeof fetch).replyToComment(replyRequest);
    expect(result).toMatchObject({ externalReplyId: "reply-900" });
    expect(calls[0]?.url).toBe("https://graph.test/v25.0/comment-1/replies");
    expect(String(calls[0]?.init?.body)).toBe("message=Thanks+for+asking.");
    expect(calls[0]?.url).not.toContain("server-only-token");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer server-only-token");
  });

  it("marks a transport failure after reply POST as uncertain and never hides it as retryable", async () => {
    const connector = makeConnector((async () => { throw new DOMException("Timed out", "AbortError"); }) as typeof fetch);
    await expect(connector.replyToComment(replyRequest)).rejects.toMatchObject({ name: "ProviderEngagementError", code: "uncertain" });
  });

  it("subscribes the professional account to comments", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify({ success: true }), { status: 200 }); };
    await expect(makeConnector(transport as typeof fetch).subscribeToComments(subscribeRequest)).resolves.toEqual({ subscribed: true, fields: ["comments"], rawResponse: { success: true } });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new URL(calls[0]!.url).searchParams.get("subscribed_fields")).toBe("comments");
    expect(calls[0]?.url).not.toContain("server-only-token");
  });

  it.each([
    [401, { error: { code: 190, error_subcode: 463, fbtrace_id: "trace-expired" } }, "expired"],
    [403, { error: { code: 10 } }, "permission_missing"],
    [429, { error: { code: 80002 } }, "rate_limited"],
    [404, { error: { code: 803 } }, "not_found"],
    [400, { error: { code: 100 } }, "unsupported"],
    [503, { error: { code: 2 } }, "provider_failed"],
  ] as const)("maps provider response %s to %s", async (status, body, code) => {
    const connector = makeConnector((async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
    await expect(connector.readComments(readRequest)).rejects.toMatchObject({ name: "ProviderEngagementError", code });
  });

  it("rejects malformed successful pages instead of turning missing data into an empty inbox", async () => {
    const connector = makeConnector((async () => new Response(JSON.stringify({ paging: {} }), { status: 200 })) as typeof fetch);
    await expect(connector.readComments(readRequest)).rejects.toMatchObject({ code: "provider_failed" });
  });

  it("registers a deterministic, idempotent safe-test engagement connector", async () => {
    const registry = new ConnectorRegistry();
    const connector = new MockInstagramConnector();
    registry.register(connector);
    expect(registry.getEngagement("instagram")).toBe(connector);
    const first = await connector.replyToComment(replyRequest);
    const second = await connector.replyToComment(replyRequest);
    expect(second).toEqual(first);
    await expect(connector.readComments(readRequest)).resolves.toMatchObject({ complete: true, comments: expect.any(Array) });
  });
});
