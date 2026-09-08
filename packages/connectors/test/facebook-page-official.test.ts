import { describe, expect, it, vi } from "vitest";
import { FacebookPageOfficialConnector, ProviderAnalyticsError, type AnalyticsRequest } from "../src/index.js";

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

const analyticsBase: AnalyticsRequest = {
  workspaceId: "workspace-1",
  contentItemId: "content-1",
  proofId: "proof-1",
  accountId: "account-1",
  platform: "facebook",
  externalPostId: "page-1_42",
  publishedAt: "2026-09-01T11:00:00.000Z",
};

function analyticsProbe() {
  return {
    apiVersion: "v26.0",
    appId: "app-1",
    appReviewSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    verifiedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  };
}

function analyticsConnector(transport: typeof fetch, credential: { scope?: string; pageTasks?: string[] } = {}) {
  return new FacebookPageOfficialConnector({
    apiVersion: "v26.0",
    appId: "app-1",
    appSecret: "app-secret",
    baseUrl: "https://graph.facebook.test",
    analyticsContractProbe: analyticsProbe(),
    fetch: transport,
    resolveCredential: async () => ({
      externalAccountId: "page-1",
      accessToken: "page-token",
      scope: credential.scope ?? "pages_show_list pages_read_engagement read_insights",
      pageTasks: credential.pageTasks ?? ["CREATE_CONTENT", "ANALYZE"],
    }),
  });
}

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

  it("reads only the pinned Page Post Insights allowlist and keeps unique viewers non-additive", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { name: "post_media_view", period: "lifetime", values: [{ value: 120 }] },
      { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 87 }] },
      { name: "post_clicks", period: "lifetime", values: [{ value: 9 }] },
    ] }));
    const connector = analyticsConnector(transport);

    const result = await connector.readPostAnalytics(analyticsBase);

    expect(connector.manifest.capabilities.analytics).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.metrics).toEqual([
      expect.objectContaining({ key: "views", value: 120, rawMetric: "post_media_view", source: "facebook_page_post_insights", coverage: "paid_and_organic", aggregation: "sum" }),
      expect.objectContaining({ key: "reach", value: 87, rawMetric: "post_total_media_view_unique", aggregation: "non_additive" }),
      expect.objectContaining({ key: "clicks", value: 9, rawMetric: "post_clicks", coverage: "unknown", aggregation: "sum" }),
    ]);
    const url = new URL(String(transport.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v26.0/page-1_42/insights");
    expect(url.searchParams.get("metric")).toBe("post_media_view,post_total_media_view_unique,post_clicks");
    expect(url.searchParams.get("period")).toBe("lifetime");
    expect(url.searchParams.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/u);
    expect(url.toString()).not.toMatch(/post_impressions/u);
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer page-token" } });
  });

  it("retries an omitted metric once and preserves a measured zero", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [
        { name: "post_media_view", period: "lifetime", values: [{ value: 10 }] },
        { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 8 }] },
      ] }))
      .mockResolvedValueOnce(response({ data: [{ name: "post_clicks", period: "lifetime", values: [{ value: 0 }] }] }));
    const result = await analyticsConnector(transport).readPostAnalytics(analyticsBase);
    expect(result.metrics.find((metric) => metric.key === "clicks")?.value).toBe(0);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(new URL(String(transport.mock.calls[1]![0])).searchParams.get("metric")).toBe("post_clicks");
  });

  it("keeps an empty authorized response unavailable instead of inventing zeros", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: [] }));
    const result = await analyticsConnector(transport).readPostAnalytics(analyticsBase);
    expect(result.status).toBe("unavailable");
    expect(result.metrics).toEqual([]);
    expect(result.caveats?.join(" ")).toMatch(/not zero/i);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("keeps publishing usable while analytics fails closed without ANALYZE", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "page-1_42" }));
    const connector = analyticsConnector(transport, { pageTasks: ["CREATE_CONTENT"] });
    await expect(connector.createPost(base)).resolves.toMatchObject({ externalPostId: "page-1_42" });
    await expect(connector.readPostAnalytics(analyticsBase)).rejects.toMatchObject({ code: "permission_missing" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["map value", { name: "post_media_view", period: "lifetime", values: [{ value: { paid: 1 } }] }],
    ["negative value", { name: "post_media_view", period: "lifetime", values: [{ value: -1 }] }],
    ["wrong period", { name: "post_media_view", period: "day", values: [{ value: 1 }] }],
    ["unexpected name", { name: "post_impressions", period: "lifetime", values: [{ value: 1 }] }],
  ])("rejects a provider schema mismatch: %s", async (_name, insight) => {
    const connector = analyticsConnector(vi.fn<typeof fetch>().mockResolvedValue(response({ data: [insight] })));
    await expect(connector.readPostAnalytics(analyticsBase)).rejects.toMatchObject({ code: "provider_failed" });
  });

  it.each([
    [190, 401, "permission_missing"],
    [200, 403, "permission_missing"],
    [80001, 429, "rate_limited"],
    [2, 503, "transient"],
  ])("classifies Graph error %s without exposing provider text", async (code, status, expectedCode) => {
    const connector = analyticsConnector(vi.fn<typeof fetch>().mockResolvedValue(response({ error: { code, message: "token=never-expose" } }, status)));
    let caught: unknown;
    try { await connector.readPostAnalytics(analyticsBase); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderAnalyticsError);
    expect(caught).toMatchObject({ code: expectedCode });
    expect((caught as Error).message).not.toContain("never-expose");
  });

  it("rejects oversized analytics responses before parsing them", async () => {
    const oversized = new Response("{}", { headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } });
    const connector = analyticsConnector(vi.fn<typeof fetch>().mockResolvedValue(oversized));
    await expect(connector.readPostAnalytics(analyticsBase)).rejects.toMatchObject({ code: "provider_failed" });
  });

  it("keeps analytics disabled when no reviewed probe is configured", async () => {
    const connector = new FacebookPageOfficialConnector({ apiVersion: "v26.0", appId: "app-1", appSecret: "app-secret", resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token" }) });
    expect(connector.manifest.capabilities.analytics).toBe(false);
    await expect(connector.readPostAnalytics(analyticsBase)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("re-evaluates probe expiry whenever capabilities are read", () => {
    const probe = analyticsProbe();
    const connector = new FacebookPageOfficialConnector({ apiVersion: "v26.0", appId: "app-1", appSecret: "app-secret", analyticsContractProbe: probe, resolveCredential: async () => ({ externalAccountId: "page-1", accessToken: "page-token" }) });
    expect(connector.manifest.capabilities.analytics).toBe(true);
    probe.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(connector.manifest.capabilities.analytics).toBe(false);
  });
});
