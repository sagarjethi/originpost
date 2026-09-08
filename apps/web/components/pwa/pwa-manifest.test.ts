import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import manifest from "../../app/manifest";
import { shouldShowIosInstallHelp } from "./pwa-platform";

describe("OriginPost PWA", () => {
  it("publishes a standalone manifest with normal and maskable icons", () => {
    const value = manifest();
    expect(value).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", theme_color: "#37413e" });
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]));
  });

  it("accepts one governed media file plus URL and text through the installed Share Target", () => {
    const value = manifest() as ReturnType<typeof manifest> & { share_target: { action: string; method: string; enctype: string; params: { title: string; text: string; url: string; files: Array<{ name: string; accept: string[] }> } } };
    expect(value.share_target).toMatchObject({ action: "/v1/share-captures/intake", method: "POST", enctype: "multipart/form-data", params: { title: "title", text: "text", url: "url" } });
    expect(value.share_target.params.files).toEqual([{ name: "media", accept: expect.arrayContaining(["image/jpeg", ".jpeg", "video/mp4", ".mov", "video/webm"]) }]);
    expect(value.share_target.params.files).toHaveLength(1);
  });

  it("never intercepts private API navigation", () => {
    const handlers = loadWorker().handlers;
    for (const path of ["/v1/content-items", "/public/v1/imports/preview"]) {
      const respondWith = vi.fn();
      handlers.fetch({ request: { method: "GET", mode: "navigate", url: `https://originpost.test${path}` }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it("pre-caches only the generic offline shell and reviewed public icons", async () => {
    const worker = loadWorker();
    const waitUntil = vi.fn();
    worker.handlers.install!({ waitUntil });
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]![0];
    expect(worker.cache.addAll).toHaveBeenCalledWith([
      "/offline.html",
      "/icons/originpost-180.png",
      "/icons/originpost-192.png",
      "/icons/originpost-512.png",
      "/icons/originpost-512-maskable.png",
    ]);
    expect(worker.cache.addAll.mock.calls[0]![0].join(" ")).not.toMatch(/v1|review|media|auth/u);
  });

  it("removes old OriginPost shell caches without deleting unrelated storage", async () => {
    const worker = loadWorker();
    const waitUntil = vi.fn();
    worker.handlers.activate!({ waitUntil });
    await waitUntil.mock.calls[0]![0];
    expect(worker.caches.delete).toHaveBeenCalledWith("originpost-public-shell-old");
    expect(worker.caches.delete).toHaveBeenCalledWith("originpost-shell-v1");
    expect(worker.caches.delete).not.toHaveBeenCalledWith("originpost-public-shell-v1");
    expect(worker.caches.delete).not.toHaveBeenCalledWith("unrelated-cache");
  });

  it("uses the generic cached document only after an app or review navigation loses the network", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const offline = new Response("OriginPost is offline", { status: 200, headers: { "cache-control": "no-cache, no-store, must-revalidate" } });
    const worker = loadWorker(fetch, offline);
    for (const path of ["/", "/review/private-token"]) {
      let responsePromise: Promise<Response> | undefined;
      worker.handlers.fetch({ request: { method: "GET", mode: "navigate", url: `https://originpost.test${path}` }, respondWith(value: Promise<Response>) { responsePromise = value; } });
      const response = await responsePromise;
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
      expect(await response?.text()).toContain("OriginPost is offline");
    }
    expect(worker.caches.match).toHaveBeenCalledWith("/offline.html", { cacheName: "originpost-public-shell-v1", ignoreSearch: true });
  });

  it("keeps the offline document free of executable inline behavior", () => {
    const source = readFileSync(new URL("../../public/offline.html", import.meta.url), "utf8");
    expect(source).not.toMatch(/<script|\son\w+\s*=/iu);
    expect(source).toContain('<a href="">Try again</a>');
  });

  it("shows manual install help only for non-installed iPhone and iPad sessions", () => {
    expect(shouldShowIosInstallHelp({ userAgent: "Mozilla/5.0 (iPhone)", platform: "iPhone", maxTouchPoints: 5, standalone: false })).toBe(true);
    expect(shouldShowIosInstallHelp({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5, standalone: false })).toBe(true);
    expect(shouldShowIosInstallHelp({ userAgent: "Mozilla/5.0 (iPhone)", platform: "iPhone", maxTouchPoints: 5, standalone: true })).toBe(false);
    expect(shouldShowIosInstallHelp({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux", maxTouchPoints: 0, standalone: false })).toBe(false);
  });
});

type WorkerHandlers = Record<string, (event: any) => void>;

function loadWorker(fetch = vi.fn(), offline = new Response("offline")) {
  const handlers: WorkerHandlers = {};
  const cache = { addAll: vi.fn().mockResolvedValue(undefined) };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([
      "unrelated-cache",
      "originpost-public-shell-v1",
      "originpost-public-shell-old",
      "originpost-shell-v1",
    ]),
    delete: vi.fn().mockResolvedValue(true),
    match: vi.fn().mockImplementation(async () => offline.clone()),
  };
  const self = {
    location: { origin: "https://originpost.test" },
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    addEventListener(type: string, handler: (event: any) => void) { handlers[type] = handler; },
  };
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, caches, fetch, Response, URL });
  return { handlers: handlers as WorkerHandlers & { fetch: (event: any) => void }, cache, caches, self };
}
