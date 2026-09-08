import { describe, expect, it, vi } from "vitest";
import { FacebookPageOfficialConnector, InstagramOfficialConnector, MockFacebookConnector, MockInstagramConnector } from "../src/index.js";

const request = { workspaceId: "workspace-1", accountId: "account-1", platform: "instagram" as const, externalPostId: "media-1", body: "Full story: https://example.com", bodySha256: "a".repeat(64), idempotencyKey: "first-comment-1", publishedAt: "2026-09-01T10:00:00.000Z" };

describe("first-comment connector seam", () => {
  it("keeps mock creation idempotent and reconciles the exact comment", async () => {
    for (const connector of [new MockInstagramConnector(), new MockFacebookConnector()]) {
      const platform = connector.manifest.platform as "instagram" | "facebook";
      const input = { ...request, platform };
      const first = await connector.createFirstComment(input);
      const second = await connector.createFirstComment(input);
      expect(second).toEqual(first);
      await expect(connector.inspectFirstComment({ ...input, providerCommentId: first.providerCommentId, earliestCreatedAt: request.publishedAt })).resolves.toMatchObject({ state: "matched", providerCommentId: first.providerCommentId });
    }
  });

  it("uses the Instagram Login comment edge with bearer auth and rejects redirects", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "comment-1" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "comment-1", text: request.body, hidden: false, timestamp: "2026-09-01T10:00:02.000Z", from: { id: "ig-1", username: "brand" } }] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = new InstagramOfficialConnector({ apiVersion: "v26.0", fetch: transport, resolveCredential: async () => ({ externalAccountId: "ig-1", accessToken: "secret", connectionMode: "instagram_login", scope: "instagram_business_manage_comments" }) });
    const created = await connector.createFirstComment(request);
    expect(created.providerCommentId).toBe("comment-1");
    expect(String(transport.mock.calls[0]![0])).toBe("https://graph.instagram.com/v26.0/media-1/comments");
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error", headers: expect.objectContaining({ authorization: "Bearer secret" }) });
    await expect(connector.inspectFirstComment({ ...request, providerCommentId: "comment-1", earliestCreatedAt: request.publishedAt })).resolves.toMatchObject({ state: "matched", providerCommentId: "comment-1" });
  });

  it("requires Facebook comment permission and MODERATE, then posts only to the exact Page post edge", async () => {
    const denied = new FacebookPageOfficialConnector({ apiVersion: "v26.0", appSecret: "app-secret", resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "secret", scope: "pages_read_engagement", pageTasks: ["CREATE_CONTENT"] }) });
    await expect(denied.firstCommentCapability({ workspaceId: "workspace-1", accountId: "account-1", platform: "facebook" })).resolves.toMatchObject({ state: "permission_missing" });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "fb-comment-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = new FacebookPageOfficialConnector({ apiVersion: "v26.0", appSecret: "app-secret", fetch: transport, resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "secret", scope: "pages_manage_engagement", pageTasks: ["MODERATE"] }) });
    const input = { ...request, platform: "facebook" as const, externalPostId: "page-1_99" };
    await expect(connector.createFirstComment(input)).resolves.toMatchObject({ providerCommentId: "fb-comment-1" });
    const url = new URL(String(transport.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v26.0/page-1_99/comments");
    expect(url.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("access_token")).toBeNull();
  });

  it("classifies a lost create response as uncertain so callers cannot blind retry", async () => {
    const connector = new InstagramOfficialConnector({ apiVersion: "v26.0", fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("socket reset")), resolveCredential: async () => ({ externalAccountId: "ig-1", accessToken: "secret", connectionMode: "instagram_login", scope: "instagram_business_manage_comments" }) });
    await expect(connector.createFirstComment(request)).rejects.toMatchObject({ code: "uncertain" });
  });
});
