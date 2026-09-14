import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { SourcingProvider, SourcingRequest, SourcingResult } from "./research.js";

const maxBytes = 2 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6"); blocked.addSubnet("2001:db8::",32,"ipv6"); blocked.addSubnet("2002::",16,"ipv6");
export function isPublicFeedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
function publicUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["https:","http:"].includes(url.protocol) || url.username || url.password || url.port || value.length > 2048 || (isIP(hostname) && !isPublicFeedAddress(hostname))) throw new Error("Feed requires a public HTTP(S) URL on its standard port.");
  return url;
}
/** Pin DNS validation to the actual socket lookup; never fetch internal addresses or forward credentials. */
export async function fetchPublicFeed(value: string, redirects = 0): Promise<string> {
  const url = publicUrl(value);
  if (redirects > 3) throw new Error("Feed redirected too many times.");
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      agent: false, signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "user-agent": "OriginPost/0.1 (+public-feed-reader)", "accept-encoding": "identity" },
      lookup: (hostname, _options, callback) => lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, "", 4);
        if (!addresses.length || addresses.some(({address}) => !isPublicFeedAddress(address))) return callback(new Error("Feed DNS resolved to a non-public address."), "", 4);
        if (typeof _options === "object" && _options.all) { callback(null, addresses as never); return; }
        const address = addresses[0]!; callback(null, address.address, address.family);
      }),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status) && response.headers.location) {
        response.resume(); void fetchPublicFeed(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`Feed returned HTTP ${status}.`)); return; }
      if (Number(response.headers["content-length"] ?? 0) > maxBytes) { response.destroy(); reject(new Error("Feed exceeds 2 MB.")); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > maxBytes) { response.destroy(new Error("Feed exceeds 2 MB.")); return; } chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject); req.end();
  });
}
export type FeedSource = { url: string; label: string; publisher?: string | undefined };
type Entry = { title: string; url: string; excerpt: string; publishedAt?: string; stableId?: string; feedUrl: string; publisher: string };
const array = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
const plain = (value: any, max: number): string => String(typeof value === "object" ? value?.["#text"] ?? "" : value ?? "").replace(/<[^>]*>/g," ").replace(/[\u0000-\u001f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
export function parsePublicFeed(xml: string, source: FeedSource): Entry[] {
  if (Buffer.byteLength(xml) > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(xml) || (xml.match(/</g)?.length ?? 0) > 20000) throw new Error("Feed XML exceeds supported limits or contains a document entity declaration.");
  if (XMLValidator.validate(xml) !== true) throw new Error("Feed is not valid XML.");
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: true }).parse(xml);
  const root = parsed.rss?.channel ?? parsed.feed;
  if (!root) throw new Error("Expected an RSS 2.0 or Atom feed.");
  const items = array(root.item ?? root.entry).slice(0, 500);
  const unique = new Map<string, Entry>();
  for (const item of items) {
    const title = plain(item.title, 300);
    const link = array(item.link).find((entry) => typeof entry === "string" || (!entry["@_rel"] || entry["@_rel"] === "alternate"));
    const raw = typeof link === "string" ? link : link?.["@_href"];
    if (!title || !raw) continue;
    let url: string; try { url = publicUrl(new URL(raw, source.url).href).href; } catch { continue; }
    const rawDate = plain(item.pubDate ?? item.published ?? item.date, 100);
    // A date without a clock and explicit timezone is not an intraday timestamp.
    const hasClockAndZone = /\d{2}:\d{2}/.test(rawDate) && /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(rawDate);
    const date = hasClockAndZone ? Date.parse(rawDate) : Number.NaN;
    const excerpt = plain(item.description ?? item.summary ?? item.content, 1500);
    const stableId = plain(item.guid ?? item.id, 500);
    unique.set(url, { title, url, excerpt, ...(Number.isFinite(date) ? { publishedAt: new Date(date).toISOString() } : {}), ...(stableId ? {stableId} : {}), feedUrl: source.url, publisher: source.publisher ?? source.label });
  }
  return [...unique.values()];
}
export class RssAtomSourcingProvider implements SourcingProvider {
  readonly id = "public-feeds";
  constructor(private readonly sources: FeedSource[], private readonly load = fetchPublicFeed, private readonly now = () => new Date()) {}
  async health() { return this.sources.length > 0; }
  async research(request: SourcingRequest): Promise<SourcingResult> {
    const entries: Entry[] = []; const failures: string[] = [];
    // Bounded fan-out; one unavailable publisher must not hide successful sources.
    for (let offset = 0; offset < this.sources.length; offset += 4) {
      await Promise.all(this.sources.slice(offset, offset + 4).map(async (source) => {
        try { entries.push(...parsePublicFeed(await this.load(source.url), source)); }
        catch { failures.push(source.label); }
      }));
    }
    if (failures.length === this.sources.length) throw new Error(`All ${failures.length} feeds failed. Check the configured feed URLs and source availability.`);
    const now = this.now().getTime();
    const selected = entries.filter(entry => !entry.publishedAt || (Date.parse(entry.publishedAt) <= now && now - Date.parse(entry.publishedAt) <= (request.freshnessHours ?? 24) * 3600000))
      .sort((a,b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.url.localeCompare(b.url));
    const unique = [...new Map(selected.map(entry => [entry.url, entry])).values()].slice(0, 500);
    return { provider: this.id, model: "rss-atom-v1", summary: `Collected ${unique.length} feed entries. ${failures.length} feeds failed. Entries require independent verification.`,
      sources: unique.map(entry => ({ ...entry, confidence: 50 })),
      suggestions: unique.map(entry => ({ title: entry.title, summary: entry.excerpt || "Open the publisher link to read the full report.", sourceUrls: [entry.url] })),
      claims: unique.map(entry => ({ text: entry.title, status: "unverified" as const, sourceUrls: [entry.url] })),
      toolsUsed: ["public_rss_atom", ...failures.map(label => `feed_failed:${label}`)],
      raw: { feedCount: this.sources.length, failedSources: failures, fetchedAt: this.now().toISOString(), truncated: selected.length > 500 },
    };
  }
}
