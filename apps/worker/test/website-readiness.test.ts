import { expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@originpost/agents", async (original) => ({ ...await original<object>(), fetchPublicResource: transport.fetch }));
import { capturePublicWebsite } from "../src/website-sourcing.js";

it("captures readable news and a desktop screenshot while an image and web font stall", async () => {
  transport.fetch.mockImplementation(async (url: string, options: { signal: AbortSignal }) => {
    if ((url.endsWith("/slow.png") || url.endsWith("/slow.woff2"))) {
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    }
    return {
      url, status: 200,
      contentType: url.endsWith("robots.txt") ? "text/plain" : "text/html; charset=utf-8",
      body: Buffer.from(url.endsWith("robots.txt") ? "User-agent: *\nDisallow:" : `<style>@font-face { font-family: Stalled; src: url(/slow.woff2); } body { font-family: Stalled, sans-serif; }</style><main><article><h2><a href="/story">A readable source headline</a></h2><p>Source excerpt.</p><img src="/slow.png"></article></main>`),
    };
  });
  const capture = await capturePublicWebsite("https://publisher.example/news");
  expect(capture.stories).toEqual([{ title: "A readable source headline", url: "https://publisher.example/story", excerpt: "Source excerpt." }]);
  expect(capture.resourceFailures).toBeGreaterThan(0);
  expect(capture.screenshot.subarray(1, 4).toString()).toBe("PNG");
  expect(capture.screenshot.readUInt32BE(16)).toBe(1440);
  expect(capture.screenshot.readUInt32BE(20)).toBe(1000);
}, 15_000);
