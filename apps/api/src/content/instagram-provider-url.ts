import { DomainError, type ContentFormat } from "@originpost/domain";

function invalid(): never {
  throw new DomainError("Use the real HTTPS Instagram link for this published media.", "invalid_provider_url");
}

/**
 * Accept only canonical Instagram media routes. Story recovery is additionally
 * bound to the provider media ID so an unrelated Story cannot become proof.
 */
export function assertInstagramProviderUrl(raw: string, format: ContentFormat, externalPostId: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { return invalid(); }
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== "443") || url.pathname.includes("//")) return invalid();
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
  catch { return invalid(); }
  const simplePart = (value: string | undefined) => Boolean(value && /^[A-Za-z0-9._-]+$/u.test(value));
  const feed = parts.length === 2 && parts[0] === "p" && simplePart(parts[1]);
  const reel = parts.length === 2 && parts[0] === "reel" && simplePart(parts[1]);
  const story = parts.length === 3 && parts[0] === "stories" && simplePart(parts[1]) && simplePart(parts[2]);
  const matchesFormat = format === "story"
    ? story && parts[2] === externalPostId
    : format === "reel"
      ? reel
      : format === "image" || format === "carousel"
        ? feed
        : false;
  if (!matchesFormat) return invalid();
  return url;
}
