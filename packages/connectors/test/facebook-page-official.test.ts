import { describe, expect, it, vi } from "vitest";
import { FacebookPageOfficialConnector } from "../src/index.js";

const base = {
  workspaceId: "workspace-1",
  contentItemId: "content-1",
  targetId: "target-1",
  accountId: "account-1",
  platform: "facebook" as const,
  format: "text" as const,
  caption: "A verified update.",
  media: [],
  idempotencyKey: "publish:target-1:v1",
  settings: {},
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("FacebookPageOfficialConnector", () => {
  it("creates a Page text post and verifies the provider permalink", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "page-1_42" }))
      .mockResolvedValueOnce(response({ id: "page-1_42", from: { id: "page-1" }, is_published: true, permalink_url: "https://www.facebook.com/page-1/posts/42", created_time: "2026-08-29T11:00:00Z" }));
    const connector = new FacebookPageOfficialConnector({
      apiVersion: "v26.0",
      appSecret: "app-secret",
      baseUrl: "https://graph.facebook.test",
      fetch: transport,
      resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token" }),
    });

    const created = await connector.createPost(base);
    const verified = await connector.readPublishedPost(base, created.externalPostId);

    expect(created.externalPostId).toBe("page-1_42");
    expect(verified.liveUrl).toBe("https://www.facebook.com/page-1/posts/42");
    const createUrl = new URL(String(transport.mock.calls[0]![0]));
    expect(createUrl.pathname).toBe("/v26.0/page-1/feed");
    expect(createUrl.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
    expect(createUrl.searchParams.get("appsecret_time")).toMatch(/^\d{10}$/);
    expect(transport.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer page-token" });
  });

  it("uses the returned Page post ID for a single-photo post", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "photo-1", post_id: "page-1_99" }));
    const connector = new FacebookPageOfficialConnector({
      apiVersion: "v26.0",
      appSecret: "app-secret",
      baseUrl: "https://graph.facebook.test",
      fetch: transport,
      resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token" }),
    });
    const created = await connector.createPost({ ...base, format: "image", media: [{ id: "media-1", type: "image", url: "https://media.example/photo.jpg", mimeType: "image/jpeg", sha256: "a".repeat(64), sizeBytes: 1024, inspectionStatus: "ready", widthPixels: 1080, heightPixels: 1350, altText: "Photo" }] });
    expect(created.externalPostId).toBe("page-1_99");
    expect(new URL(String(transport.mock.calls[0]![0])).pathname).toBe("/v26.0/page-1/photos");
  });

  it("does not invent a permalink when Facebook omits it", async () => {
    const connector = new FacebookPageOfficialConnector({
      apiVersion: "v26.0",
      appSecret: "app-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ id: "page-1_42", from: { id: "page-1" }, is_published: true })),
      resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token" }),
    });
    await expect(connector.readPublishedPost(base, "page-1_42")).rejects.toThrow("verified HTTPS permalink");
  });

  it("treats a lost response as uncertain instead of retry-safe", async () => {
    const connector = new FacebookPageOfficialConnector({
      apiVersion: "v26.0",
      appSecret: "app-secret",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")),
      resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token" }),
    });
    await expect(connector.createPost(base)).rejects.toThrow("may have received");
  });
});
