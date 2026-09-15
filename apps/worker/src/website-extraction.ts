/** Runs in the isolated browser document; keep this function self-contained. */
export function extractWebsiteStories() {
  const plain = (value: string | null | undefined, limit: number) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const stamp = (value: string | null | undefined) =>
    value &&
    /\d{2}:\d{2}/.test(value) &&
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : undefined;
  const stories: Array<{
    title: string;
    url: string;
    excerpt: string;
    publishedAt?: string;
  }> = [];
  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    "main article a[href], article h2 a[href], article h3 a[href], main h2 a[href], main h3 a[href], [role=main] h2 a[href], main a[href]:has(h2), main a[href]:has(h3), [role=main] a[href]:has(h2)",
  );
  for (const anchor of Array.from(anchors).slice(0, 500)) {
    const title = plain(
      (anchor.querySelector("h2, h3")
        ? anchor.getAttribute("aria-label") || anchor.querySelector("h2, h3")?.textContent
        : anchor.innerText) || anchor.querySelector("img")?.alt,
      300,
    );
    let link: URL;
    try {
      link = new URL(anchor.href);
    } catch {
      continue;
    }
    if (
      title.length < 15 ||
      link.origin !== location.origin ||
      link.pathname === location.pathname ||
      !["http:", "https:"].includes(link.protocol)
    )
      continue;
    link.hash = "";
    const container = anchor.querySelector("h2, h3") ? anchor : anchor.closest("article");
    const article =
      container && container.querySelectorAll("a[href]").length <= 8
        ? container
        : null;
    const publishedAt = stamp(
      article?.querySelector("time[datetime]")?.getAttribute("datetime"),
    );
    stories.push({
      title,
      url: link.href,
      excerpt: plain(article?.querySelector("p:not(.hrTime):not(.eyeView):not(.date)")?.textContent, 1500),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  if (!stories.length) {
    const title = plain(
      document.querySelector("h1")?.textContent || document.title,
      300,
    );
    const text = plain(
      (
        (document.querySelector("article") ||
          document.querySelector("main") ||
          document.body) as HTMLElement
      ).innerText,
      1500,
    );
    const publishedAt = stamp(
      document
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute("content"),
    );
    if (title && text.length >= 80)
      stories.push({
        title,
        url: location.href,
        excerpt: text,
        ...(publishedAt ? { publishedAt } : {}),
      });
  }
  const unique = new Map<string, (typeof stories)[number]>();
  for (const story of stories) {
    const previous = unique.get(story.url);
    if (!previous || story.excerpt.length > previous.excerpt.length)
      unique.set(story.url, story);
  }
  return {
    title: document.title,
    stories: Array.from(unique.values()).slice(0, 40),
  };
}
