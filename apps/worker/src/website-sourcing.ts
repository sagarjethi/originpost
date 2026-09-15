import { extractWebsiteStories } from "./website-extraction.js";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import {
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  S3Client,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import {
  fetchPublicResource,
  type SourcingProvider,
  type SourcingRequest,
  type SourcingResult,
} from "@originpost/agents";
import {
  sourceSnapshotKey,
  type TrackedPublicSource,
} from "@originpost/domain";

const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  text: string,
) => {
  isAllowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
};

export type WebsiteCapture = {
  pageUrl: string;
  capturedAt: string;
  screenshot: Buffer;
  resourceFailures?: number;
  stories: Array<{
    title: string;
    url: string;
    excerpt: string;
    publishedAt?: string;
  }>;
};
export type CaptureWebsite = (url: string) => Promise<WebsiteCapture>;
const userAgent = "OriginPost";

export class PublisherCaptureError extends Error {
  constructor(
    readonly code: "robots_unavailable" | "robots_disallowed" | "crawl_delay",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublisherCaptureError";
  }
}

/** Fresh, unauthenticated desktop context. Every byte is fetched through the pinned public-address transport. */
export const capturePublicWebsite: CaptureWebsite = async (url) => {
  const abort = new AbortController();
  const timeout = AbortSignal.any([AbortSignal.timeout(45_000), abort.signal]);
  let activeRequests = 0;
  const waiting: Array<() => void> = [];
  timeout.addEventListener(
    "abort",
    () => waiting.splice(0).forEach((wake) => wake()),
    { once: true },
  );
  async function resource(target: string) {
    while (activeRequests >= 4 && !timeout.aborted)
      await new Promise<void>((resolve) => waiting.push(resolve));
    timeout.throwIfAborted();
    activeRequests++;
    try {
      return await fetchPublicResource(target, {
        maxBytes: 4 * 1024 * 1024,
        signal: timeout,
        followRedirects: false,
      });
    } finally {
      activeRequests--;
      waiting.shift()?.();
    }
  }
  const robots = new Map<string, ReturnType<typeof robotsParser>>();
  async function allowed(target: string) {
    const origin = new URL(target).origin;
    let rules = robots.get(origin);
    if (!rules) {
      const response = await fetchPublicResource(`${origin}/robots.txt`, {
        maxBytes: 512 * 1024,
        signal: timeout,
      }).catch((cause: unknown) => {
        throw new PublisherCaptureError("robots_unavailable", "Publisher robots.txt could not be retrieved. No page was collected; retry when the publisher is reachable.", { cause });
      });
      if (response.status !== 200 && response.status !== 404)
        throw new PublisherCaptureError("robots_unavailable", "Publisher robots policy is unavailable.");
      rules = robotsParser(
        `${origin}/robots.txt`,
        response.status === 404 ? "" : response.body.toString("utf8"),
      );
      robots.set(origin, rules);
    }
    if (rules.isAllowed(target, userAgent) === false)
      throw new PublisherCaptureError("robots_disallowed", "Publisher robots policy disallows this page.");
    // Collections already run on a schedule. A longer publisher-specific delay requires a dedicated adapter.
    if ((rules.getCrawlDelay(userAgent) ?? 0) > 1)
      throw new PublisherCaptureError("crawl_delay", "Publisher requires a slower dedicated collector.");
  }
  await allowed(url);
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          [
            "PATH",
            "HOME",
            "TMPDIR",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "SYSTEMROOT",
            "DISPLAY",
            "XDG_RUNTIME_DIR",
            "PLAYWRIGHT_BROWSERS_PATH",
          ].includes(key),
      ),
    ) as Record<string, string>,
    ...(process.env.WEBSITE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEBSITE_BROWSER_EXECUTABLE }
      : {}),
    args: [
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
    ],
    timeout: 15_000,
  });
  const closeOnTimeout = () => {
    void browser.close().catch(() => {});
  };
  timeout.addEventListener("abort", closeOnTimeout, { once: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
      userAgent: "OriginPost/0.1 (+public-source-reader)",
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    let requests = 0,
      bytes = 0,
      navigations = 0,
      failures = 0;
    await context.route("**/*", async (route) => {
      try {
        const request = route.request();
        if (
          request.method() !== "GET" ||
          !["document", "stylesheet", "image", "font"].includes(
            request.resourceType(),
          )
        )
          return await route.abort();
        if (++requests > 96 || bytes >= 24 * 1024 * 1024 || timeout.aborted) {
          failures++;
          return await route.abort();
        }
        if (request.isNavigationRequest()) {
          if (request.frame() !== page.mainFrame() || ++navigations > 4)
            return await route.abort();
          await allowed(request.url());
        }
        const result = await resource(request.url());
        bytes += result.body.length;
        if (bytes > 24 * 1024 * 1024)
          throw new Error("Page resource budget exceeded.");
        await route.fulfill({
          status: result.status,
          contentType: result.contentType,
          headers: {
            ...(result.location ? { location: result.location } : {}),
            "content-security-policy":
              "script-src 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'",
            "x-content-type-options": "nosniff",
          },
          body: result.body,
        });
      } catch {
        failures++;
        await route.abort().catch(() => {});
      }
    });
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: 30_000,
    });
    if (!response || !response.ok())
      throw new Error("Publisher page did not load successfully.");
    const extracted = await page.evaluate(extractWebsiteStories);
    if (
      /captcha|access denied|just a moment|sign in|log in/i.test(
        extracted.title,
      ) ||
      !extracted.stories.length
    )
      throw new Error(
        "Page needs a manual browser check; no usable public news text was visible.",
      );
    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false,
      timeout: 10_000,
    });
    if (screenshot.length > 4 * 1024 * 1024)
      throw new Error("Source snapshot is too large.");
    // Missing decorative assets are not a failed article capture; main navigation and text must succeed.
    return {
      pageUrl: page.url(),
      capturedAt: new Date().toISOString(),
      screenshot,
      resourceFailures: failures,
      stories: extracted.stories,
    };
  } finally {
    timeout.removeEventListener("abort", closeOnTimeout);
    abort.abort();
    await browser.close();
  }
};

export class WebsiteSourcingProvider implements SourcingProvider {
  readonly id = "public-websites";
  constructor(
    private readonly sources: TrackedPublicSource[],
    private readonly capture: CaptureWebsite,
    private readonly store: (capture: WebsiteCapture) => Promise<string>,
    private readonly now = () => new Date(),
  ) {}
  async health() {
    return this.sources.length > 0;
  }
  async research(request: SourcingRequest): Promise<SourcingResult> {
    const sources: SourcingResult["sources"] = [];
    const failed: string[] = [];
    const failureDetails: Array<{ label: string; code: string; message: string }> = [];
    for (const source of this.sources.slice(0, 20)) {
      try {
        const captured = await this.capture(source.url);
        const sha256 = await this.store(captured);
        const now = this.now().getTime();
        for (const story of captured.stories) {
          if (
            story.publishedAt &&
            (Date.parse(story.publishedAt) > now ||
              now - Date.parse(story.publishedAt) >
                (request.freshnessHours ?? 24) * 3600000)
          )
            continue;
          sources.push({
            ...story,
            publisher: source.publisher ?? source.label,
            confidence: 40,
            pageUrl: source.url,
            snapshot: {
              sha256,
              capturedAt: captured.capturedAt,
              pageUrl: captured.pageUrl,
              width: 1440,
              height: 1000,
              ...(captured.resourceFailures
                ? { resourceFailures: captured.resourceFailures }
                : {}),
            },
          });
        }
      } catch (error) {
        failed.push(source.label);
        failureDetails.push({
          label: source.label,
          code: error instanceof PublisherCaptureError ? error.code : "capture_failed",
          message: error instanceof PublisherCaptureError ? error.message : "Page capture or snapshot storage failed. Check browser installation, storage and public page availability.",
        });
      }
    }
    if (failed.length === this.sources.length)
      throw new Error(
        `All publisher pages failed. ${[...new Set(failureDetails.map((failure) => failure.message))].join(" ")}`,
      );
    const unique = [
      ...new Map(sources.map((source) => [source.url, source])).values(),
    ].slice(0, 500);
    return {
      provider: this.id,
      model: "desktop-public-page-v1",
      summary: `${unique.length} public-page leads; ${failed.length} pages failed. Screenshots show the source page, not independently verified events.`,
      sources: unique,
      claims: unique.map((source) => ({
        text: source.title,
        status: "unverified",
        sourceUrls: [source.url],
      })),
      suggestions: unique.map((source) => ({
        title: source.title,
        summary:
          source.excerpt || "Open the publisher report and source screenshot.",
        sourceUrls: [source.url],
      })),
      toolsUsed: [
        "desktop_website_capture",
        ...failed.map((label) => `collector_failed:${label}`),
      ],
      raw: { failed, failureDetails, capturedAt: this.now().toISOString() },
    };
  }
}
export async function ensureSourceSnapshotBucket(
  client: Pick<S3Client, "send">,
  bucket: string,
  region: string,
) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode !== 404
    )
      throw error;
    try {
      await client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(region !== "us-east-1"
            ? {
                CreateBucketConfiguration: {
                  LocationConstraint: region as BucketLocationConstraint,
                },
              }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
    } catch (creationError) {
      if (
        (creationError as { name?: string })?.name !== "BucketAlreadyOwnedByYou"
      )
        throw creationError;
    }
  }
}

export function configuredWebsiteProvider(
  sources: TrackedPublicSource[],
  workspaceId: string,
  brandId: string,
): SourcingProvider {
  const endpoint = process.env.S3_ENDPOINT,
    accessKeyId = process.env.S3_ACCESS_KEY,
    secretAccessKey = process.env.S3_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey)
    return {
      id: "public-websites",
      health: async () => false,
      research: async () => {
        throw new Error("Private source screenshot storage is not configured.");
      },
    };
  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const provider = new WebsiteSourcingProvider(
    sources,
    capturePublicWebsite,
    async (capture) => {
      const sha256 = createHash("sha256")
        .update(capture.screenshot)
        .digest("hex");
      await client.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET ?? "originpost-media",
          Key: sourceSnapshotKey(workspaceId, brandId, sha256),
          Body: capture.screenshot,
          ContentType: "image/png",
          CacheControl: "private, max-age=0",
          Metadata: { sha256 },
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      return sha256;
    },
  );
  return {
    id: provider.id,
    health: () => provider.health(),
    research: async (request) => {
      try {
        await ensureSourceSnapshotBucket(
          client,
          process.env.S3_BUCKET ?? "originpost-media",
          process.env.S3_REGION ?? "us-east-1",
        );
        return await provider.research(request);
      } finally {
        client.destroy();
      }
    },
  };
}
