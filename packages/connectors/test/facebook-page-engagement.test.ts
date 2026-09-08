import { describe, expect, it, vi } from "vitest";
import { ConnectorRegistry, FacebookPageOfficialConnector, MockFacebookConnector, type ReadCommentsRequest, type ReplyToCommentRequest, type SubscribeCommentsRequest } from "../src/index.js";

const scope = { workspaceId: "workspace-1", brandId: "brand-1", accountId: "account-1", platform: "facebook" as const };
const readRequest: ReadCommentsRequest = { ...scope, externalMediaId: "page-1_900" };
const replyRequest: ReplyToCommentRequest = { ...scope, externalCommentId: "comment-1", body: "Thanks for asking.", idempotencyKey: "engagement:action-1:v1" };
const subscribeRequest: SubscribeCommentsRequest = { ...scope, externalAccountId: "page-1" };

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const makeConnector = (transport: typeof fetch, options: { maxCommentPages?: number; probe?: boolean } = {}) => new FacebookPageOfficialConnector({
  apiVersion: "v26.0",
  appSecret: "app-secret",
  baseUrl: "https://graph.facebook.test",
  fetch: transport,
  resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "server-only-page-token" }),
  ...(options.maxCommentPages !== undefined ? { maxCommentPages: options.maxCommentPages } : {}),
  ...(options.probe ? { commentReplyContractProbe: { apiVersion: "v26.0", verifiedAt: "2026-08-29T12:00:00.000Z" } } : {}),
});

describe("Facebook Page engagement connector", () => {
  it("reads top-level comments and reply pages without carrying provider credentials in next URLs or raw results", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/page-1_900/comments") && !url.includes("after=top-2")) {
        return response({ data: [], paging: { next: "https://graph.facebook.test/v26.0/page-1_900/comments?after=top-2&access_token=leaked-token&appsecret_proof=stale-proof&appsecret_time=1" } });
      }
      if (url.includes("/page-1_900/comments") && url.includes("after=top-2")) {
        return response({ data: [{ id: "comment-1", message: "First", is_hidden: false, created_time: "2026-08-29T10:00:00Z", from: { id: "author-1", name: "Reader One" } }], paging: {} });
      }
      if (url.includes("/comment-1/comments") && !url.includes("after=reply-2")) {
        return response({ data: [{ id: "reply-1", message: "Reply one", is_hidden: false, created_time: "2026-08-29T10:01:00Z", from: { id: "page-1", name: "News Page" }, parent: { id: "comment-1" } }], paging: { next: "https://graph.facebook.test/v26.0/comment-1/comments?after=reply-2&access_token=leaked-token" } });
      }
      if (url.includes("/comment-1/comments") && url.includes("after=reply-2")) {
        return response({ data: [{ id: "reply-2", message: "Reply two", is_hidden: true, created_time: "2026-08-29T10:02:00Z", from: { id: "author-2", name: "Reader Two" } }] });
      }
      return response({ error: { code: 100 } }, 400);
    };

    const result = await makeConnector(transport as typeof fetch).readComments(readRequest);

    expect(result.comments).toEqual([
      expect.objectContaining({ externalCommentId: "comment-1", authorScopedId: "author-1", authorUsername: "Reader One", visibility: "visible" }),
      expect.objectContaining({ externalCommentId: "reply-1", parentExternalCommentId: "comment-1", visibility: "visible" }),
      expect.objectContaining({ externalCommentId: "reply-2", parentExternalCommentId: "comment-1", visibility: "hidden" }),
    ]);
    expect(result.complete).toBe(true);
    expect(calls).toHaveLength(4);
    expect(new URL(calls[0]!.url).searchParams.get("filter")).toBe("toplevel");
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.searchParams.has("access_token")).toBe(false);
      expect(url.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
      expect(url.searchParams.get("appsecret_proof")).not.toBe("stale-proof");
      expect(url.searchParams.get("appsecret_time")).toMatch(/^\d{10}$/);
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer server-only-page-token");
    }
    expect(JSON.stringify(result.rawResponse)).not.toContain("server-only-page-token");
    expect(JSON.stringify(result.rawResponse)).not.toContain("leaked-token");
  });

  it("rejects a pagination URL outside the configured Graph origin", async () => {
    const connector = makeConnector((async () => response({ data: [], paging: { next: "https://attacker.invalid/v26.0/comments?access_token=server-only-page-token" } })) as typeof fetch);
    await expect(connector.readComments(readRequest)).rejects.toMatchObject({ name: "ProviderEngagementError", code: "provider_failed" });
  });

  it("fails closed when a comment collection exceeds the bounded reconciliation limit", async () => {
    const connector = makeConnector((async () => response({ data: [], paging: { next: "https://graph.facebook.test/v26.0/page-1_900/comments?after=more" } })) as typeof fetch, { maxCommentPages: 1 });
    await expect(connector.readComments(readRequest)).rejects.toMatchObject({ code: "provider_failed" });
  });

  it("subscribes the exact connected Page to the feed webhook field", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ success: true }));
    const result = await makeConnector(transport).subscribeToComments(subscribeRequest);

    expect(result).toEqual({ subscribed: true, fields: ["feed"], rawResponse: { success: true } });
    const url = new URL(String(transport.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v26.0/page-1/subscribed_apps");
    expect(url.searchParams.get("subscribed_fields")).toBe("feed");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(transport.mock.calls[0]![1]?.method).toBe("POST");
    expect(new Headers(transport.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer server-only-page-token");
  });

  it("fails public replies closed by default without making a provider request", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(makeConnector(transport).replyToComment(replyRequest)).rejects.toMatchObject({ code: "unsupported" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("exposes the generic Object Comments reply route only to an explicit version-matched contract probe", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "reply-900" }));
    const result = await makeConnector(transport, { probe: true }).replyToComment(replyRequest);

    expect(result).toMatchObject({ externalReplyId: "reply-900", rawResponse: { id: "reply-900" } });
    const url = new URL(String(transport.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v26.0/comment-1/comments");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(String(transport.mock.calls[0]![1]?.body)).toBe("message=Thanks+for+asking.");
  });

  it("marks a lost reply-probe response uncertain instead of retry-safe", async () => {
    const connector = makeConnector((async () => { throw new DOMException("Timed out", "AbortError"); }) as typeof fetch, { probe: true });
    await expect(connector.replyToComment(replyRequest)).rejects.toMatchObject({ code: "uncertain" });
  });

  it.each([
    [401, { error: { code: 190, error_subcode: 463, fbtrace_id: "trace-expired" } }, "expired"],
    [403, { error: { code: 200 } }, "permission_missing"],
    [403, { error: { code: 492 } }, "permission_missing"],
    [429, { error: { code: 80001 } }, "rate_limited"],
    [404, { error: { code: 210 } }, "not_found"],
    [400, { error: { code: 100 } }, "unsupported"],
    [503, { error: { code: 2 } }, "provider_failed"],
  ] as const)("maps provider response %s to %s", async (status, body, code) => {
    const connector = makeConnector((async () => response(body, status, { "retry-after": "12" })) as typeof fetch);
    await expect(connector.readComments(readRequest)).rejects.toMatchObject({ name: "ProviderEngagementError", code, detail: expect.objectContaining({ providerCode: body.error.code }) });
  });

  it("rejects malformed successful pages instead of turning missing data into an empty inbox", async () => {
    const connector = makeConnector((async () => response({ paging: {} })) as typeof fetch);
    await expect(connector.readComments(readRequest)).rejects.toMatchObject({ code: "provider_failed" });
  });

  it("registers a deterministic Facebook safe-test engagement connector", async () => {
    const registry = new ConnectorRegistry();
    const connector = new MockFacebookConnector();
    registry.register(connector);

    expect(registry.getEngagement("facebook")).toBe(connector);
    const first = await connector.replyToComment(replyRequest);
    const second = await connector.replyToComment(replyRequest);
    expect(second).toEqual(first);
    await expect(connector.readComments(readRequest)).resolves.toMatchObject({ complete: true, comments: expect.any(Array) });
    await expect(connector.subscribeToComments(subscribeRequest)).resolves.toMatchObject({ fields: ["feed"] });
  });
});
