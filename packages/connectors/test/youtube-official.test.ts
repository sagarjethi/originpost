import { describe, expect, it } from "vitest";
import { YouTubeOfficialConnector, type AnalyticsRequest, type PublishRequest } from "../src/index.js";

function publishRequest(settings: Record<string, unknown> = {}): PublishRequest {
  return {
    workspaceId: "workspace-1",
    contentItemId: "content-1",
    targetId: "target-1",
    accountId: "account-1",
    platform: "youtube",
    format: "short",
    caption: "A checked YouTube Short\nWith a source-backed description.",
    media: [{ id: "video-1", type: "video", url: "https://media.test/video", mimeType: "video/mp4", sha256: "a".repeat(64), sizeBytes: 12, inspectionStatus: "ready", widthPixels: 1080, heightPixels: 1920, durationMs: 60_000 }],
    idempotencyKey: "publish:target-1:v1",
    settings: { title: "A checked YouTube Short", description: "With a source-backed description.", madeForKids: false, containsSyntheticMedia: false, ...settings },
  };
}

const analyticsRequest: AnalyticsRequest = {
  workspaceId: "workspace-1",
  contentItemId: "content-1",
  proofId: "proof-1",
  accountId: "account-1",
  platform: "youtube",
  externalPostId: "video-123",
  publishedAt: "2026-08-27T12:00:00.000Z",
};

describe("official YouTube connector", () => {
  it("creates a private resumable session and streams the approved video without leaking the token", async () => {
    const sessionUri = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("notifySubscribers=")) return new Response(null, { status: 200, headers: { location: sessionUri } });
      if (url === "https://media.test/video") return new Response(new Uint8Array(12), { status: 200, headers: { "content-length": "12", "content-type": "video/mp4" } });
      if (url === sessionUri) return new Response(JSON.stringify({ id: "video-123" }), { status: 201 });
      return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    };
    const connector = new YouTubeOfficialConnector({ fetch: transport as typeof fetch, uploadBaseUrl: "https://www.googleapis.com/upload/youtube/v3", resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "server-only-token" }) });
    const result = await connector.publish(publishRequest({ madeForKids: false }));
    expect(result).toMatchObject({ status: "published", externalPostId: "video-123", liveUrl: "https://www.youtube.com/watch?v=video-123" });
    const metadataCall = calls.find((call) => call.url.includes("uploadType=resumable"))!;
    expect(JSON.parse(String(metadataCall.init?.body))).toMatchObject({ status: { privacyStatus: "private", selfDeclaredMadeForKids: false } });
    expect(calls.every((call) => !call.url.includes("server-only-token"))).toBe(true);
    expect(new Headers(calls.at(-1)?.init?.headers).get("authorization")).toBe("Bearer server-only-token");
    expect(calls.filter((call) => call.url !== "https://media.test/video").every((call) => call.init?.redirect === "error")).toBe(true);
  });

  it("queries and resumes from the byte confirmed by YouTube", async () => {
    const sessionUri = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-2";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let query = true;
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url === sessionUri && query) {
        query = false;
        return new Response(null, { status: 308, headers: { range: "bytes=0-4" } });
      }
      if (url === "https://media.test/video") return new Response(new Uint8Array(7), { status: 206, headers: { "content-range": "bytes 5-11/12", "content-length": "7" } });
      if (url === sessionUri) return new Response(JSON.stringify({ id: "video-resumed" }), { status: 201 });
      return new Response(null, { status: 404 });
    };
    const connector = new YouTubeOfficialConnector({ fetch: transport as typeof fetch, resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token" }) });
    const request = publishRequest();
    await expect(connector.queryUploadSession(request, sessionUri)).resolves.toEqual({ status: "incomplete", uploadedBytes: 5 });
    await expect(connector.uploadFromSession(request, sessionUri, 5)).resolves.toMatchObject({ status: "published", videoId: "video-resumed" });
    const mediaCall = calls.find((call) => call.url === "https://media.test/video")!;
    expect(new Headers(mediaCall.init?.headers).get("range")).toBe("bytes=5-");
    const uploadCall = calls.at(-1)!;
    expect(new Headers(uploadCall.init?.headers).get("content-range")).toBe("bytes 5-11/12");
  });

  it("rejects an untrusted resumable session before forwarding a bearer token", async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    };
    const connector = new YouTubeOfficialConnector({ fetch: transport as typeof fetch, resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token" }) });
    await expect(connector.queryUploadSession(publishRequest(), "https://attacker.example/upload?uploadType=resumable&upload_id=stolen")).rejects.toThrow("untrusted");
    expect(calls).toBe(0);
  });

  it("rejects an inexact resumed source response", async () => {
    const sessionUri = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-3";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://media.test/video") return new Response(new Uint8Array(12), { status: 200, headers: { "content-length": "12" } });
      return new Response(null, { status: 500 });
    };
    const connector = new YouTubeOfficialConnector({ fetch: transport as typeof fetch, resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token" }) });
    await expect(connector.uploadFromSession(publishRequest(), sessionUri, 5)).rejects.toThrow("exact resume range");
    expect(calls.some((call) => call.url === sessionUri)).toBe(false);
  });

  it("checks YouTube processing before calling the result ready", async () => {
    const transport = async () => new Response(JSON.stringify({ items: [{ id: "video-1", status: { uploadStatus: "processed", privacyStatus: "private" }, processingDetails: { processingStatus: "succeeded" } }] }), { status: 200 });
    const connector = new YouTubeOfficialConnector({ fetch: transport as typeof fetch, resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token" }) });
    await expect(connector.checkProcessing(publishRequest(), "video-1")).resolves.toEqual({ status: "ready", privacyStatus: "private" });
  });

  it("parses analytics through column headers and keeps views separate from engaged views", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        columnHeaders: [
          { name: "shares", columnType: "METRIC", dataType: "INTEGER" },
          { name: "engagedViews", columnType: "METRIC", dataType: "INTEGER" },
          { name: "averageViewDuration", columnType: "METRIC", dataType: "INTEGER" },
          { name: "views", columnType: "METRIC", dataType: "INTEGER" },
          { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "FLOAT" },
          { name: "likes", columnType: "METRIC", dataType: "INTEGER" },
          { name: "comments", columnType: "METRIC", dataType: "INTEGER" },
          { name: "subscribersGained", columnType: "METRIC", dataType: "INTEGER" },
        ],
        rows: [[3, 80, 22, 140, 12.5, 17, 2, 4]],
      }), { status: 200 });
    };
    const connector = new YouTubeOfficialConnector({ analyticsBaseUrl: "https://youtube-analytics.test/v2", fetch: transport as typeof fetch, resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "server-only-token" }) });
    const result = await connector.readPostAnalytics(analyticsRequest);

    expect(result.status).toBe("ready");
    expect(result.metrics).toMatchObject([
      { key: "views", value: 140, unit: "count" },
      { key: "engaged_views", value: 80, unit: "count" },
      { key: "watch_time_seconds", value: 750, unit: "seconds" },
      { key: "average_view_duration_seconds", value: 22, unit: "seconds" },
      { key: "likes", value: 17, unit: "count" },
      { key: "comments", value: 2, unit: "count" },
      { key: "shares", value: 3, unit: "count" },
      { key: "subscribers_gained", value: 4, unit: "count" },
    ]);
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.pathname).toBe("/v2/reports");
    expect(url.searchParams.get("ids")).toBe("channel==MINE");
    expect(url.searchParams.get("filters")).toBe("video==video-123");
    expect(url.searchParams.get("startDate")).toBe("2026-08-27");
    expect(call.url).not.toContain("server-only-token");
    expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer server-only-token");
  });

  it("returns unavailable rather than fake zeroes when YouTube omits rows", async () => {
    const connector = new YouTubeOfficialConnector({
      fetch: (async () => new Response(JSON.stringify({ columnHeaders: [{ name: "views" }] }), { status: 200 })) as typeof fetch,
      resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token" }),
    });
    await expect(connector.readPostAnalytics(analyticsRequest)).resolves.toMatchObject({ status: "unavailable", metrics: [] });
  });

  it.each([
    [401, { error: { code: 401, errors: [{ reason: "authError" }] } }, "permission_missing"],
    [403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, "permission_missing"],
    [400, { error: { code: 400, errors: [{ reason: "badRequest" }] } }, "unsupported"],
    [429, { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } }, "provider_failed"],
    [503, { error: { code: 503, errors: [{ reason: "backendError" }] } }, "provider_failed"],
  ] as const)("classifies analytics provider errors with HTTP %s", async (status, body, code) => {
    const connector = new YouTubeOfficialConnector({
      fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
      resolveCredential: async () => ({ externalAccountId: "channel-1", accessToken: "token" }),
    });
    await expect(connector.readPostAnalytics(analyticsRequest)).rejects.toMatchObject({ name: "ProviderAnalyticsError", code });
  });
});
