import { chromium } from "playwright";
import { expect, it } from "vitest";
import { extractWebsiteStories } from "../src/website-extraction.js";

it("extracts wrapped headline cards without treating counters or relative ages as news copy", async () => {
  const browser = await chromium.launch({
    ...(process.env.WEBSITE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEBSITE_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<main>
        <a href="/gu/story" aria-label="ગુજરાતમાં લોકમેળાનો આજથી શુભારંભ">
          <p class="hrTime">13 કલાક પહેલા</p><p class="eyeView">8</p>
          <h2>ગુજરાતમાં લોકમેળાનો...</h2><p class="blogDisc">મેળાની શરૂઆત થઈ.</p>
        </a>
        <a href="/gu/story"><h3>ગુજરાતમાં લોકમેળાનો આજથી શુભારંભ</h3><p class="date">14 સપ્ટેમ્બર 2026 | 7:33 પી એમ(PM)</p></a>
        <article><h2><a href="/other">Another source headline</a></h2>
          <time datetime="2026-09-14T12:00:00+05:30"></time><p>Article excerpt.</p></article>
        <a href="https://other.example/story"><h2>External article headline</h2></a>
        <a href="/gu/"><h2>Current listing headline</h2></a>
      </main>`,
    }));
    await page.goto("https://publisher.example/gu/", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(extractWebsiteStories);
    expect(result.stories).toEqual([
      { title: "ગુજરાતમાં લોકમેળાનો આજથી શુભારંભ", url: "https://publisher.example/gu/story", excerpt: "મેળાની શરૂઆત થઈ." },
      { title: "Another source headline", url: "https://publisher.example/other", excerpt: "Article excerpt.", publishedAt: "2026-09-14T06:30:00.000Z" },
    ]);
    await page.evaluate(() => { document.querySelector("main")!.style.opacity = "0"; });
    const hidden = await page.evaluate(extractWebsiteStories);
    expect(hidden.stories).toEqual([]);
  } finally {
    await browser.close();
  }
}, 20_000);
