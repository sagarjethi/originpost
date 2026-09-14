import { describe, expect, it } from "vitest";
import { isPublicFeedAddress, parsePublicFeed, RssAtomSourcingProvider } from "../src/feed.js";
const source = {url:"https://publisher.example/feed.xml",label:"Publisher"};
const rss = (items:string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const item = (title:string,date:string,url="/story") => `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><description><![CDATA[<p>Original report</p>]]></description></item>`;
describe("public feed collection", () => {
 it("parses RSS text, entities, relative links and exact publication timestamps", () => {
  expect(parsePublicFeed(rss(item("News &amp; facts","Mon, 14 Sep 2026 12:00:00 GMT")),source)[0]).toMatchObject({title:"News & facts",url:"https://publisher.example/story",publishedAt:"2026-09-14T12:00:00.000Z",excerpt:"Original report",feedUrl:source.url});
 });
 it("keeps missing timezone and day-only dates unknown", () => {
  expect(parsePublicFeed(rss(item("Unknown","Fri, 11 Sep 2026 21:40:00")),source)[0]?.publishedAt).toBeUndefined();
  expect(parsePublicFeed(rss(item("Day only","14 Sep, 2026 +0530")),source)[0]?.publishedAt).toBeUndefined();
 });
 it("parses Atom alternate links and never treats update time as publication time", () => {
  const result = parsePublicFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Report</title><link rel="self" href="/api"/><link rel="alternate" href="/report"/><updated>2026-09-14T12:00:00Z</updated></entry></feed>',source);
  expect(result[0]?.url).toBe("https://publisher.example/report"); expect(result[0]?.publishedAt).toBeUndefined();
 });
 it("rejects unsafe XML, invalid formats, oversized payloads, and private article links", () => {
  expect(() => parsePublicFeed('<!DOCTYPE rss [<!ENTITY x "x">]>'+rss(""),source)).toThrow();
  expect(() => parsePublicFeed('<html>Not a feed</html>',source)).toThrow();
  expect(() => parsePublicFeed('x'.repeat(3*1024*1024),source)).toThrow();
  expect(parsePublicFeed(rss(item("Private","","http://127.0.0.1/secret")),source)).toEqual([]);
 });
 it("rejects loopback, private, mapped and reserved network addresses", () => {
  for (const ip of ["127.0.0.1","10.1.1.1","169.254.169.254","192.168.1.1","100.64.0.1","::1","::ffff:127.0.0.1","fc00::1","2002:7f00:1::"]) expect(isPublicFeedAddress(ip),ip).toBe(false);
  expect(isPublicFeedAddress("8.8.8.8")).toBe(true); expect(isPublicFeedAddress("2606:4700:4700::1111")).toBe(true);
 });
 it("collects healthy feeds through partial failures, sorts dates, drops future/stale entries, and keeps claims unverified", async () => {
  const provider = new RssAtomSourcingProvider([source,{url:"https://down.example/feed",label:"Down"}], async url => {
   if (url.includes("down")) throw new Error("offline");
   return rss(item("Old","Sun, 13 Sep 2026 01:00:00 GMT","/old")+item("Morning","Mon, 14 Sep 2026 08:00:00 GMT","/morning")+item("Latest","Mon, 14 Sep 2026 11:00:00 GMT","/latest")+item("Future","Tue, 15 Sep 2026 11:00:00 GMT","/future")+item("Unknown","","/unknown"));
  }, () => new Date("2026-09-14T12:00:00Z"));
  const result = await provider.research({sessionKey:"test",query:"news",depth:"standard",languages:["English"],sourceLimit:20,freshnessHours:24});
  expect(result.sources.map(source => source.title)).toEqual(["Latest","Morning","Unknown"]);
  expect(result.toolsUsed).toContain("feed_failed:Down"); expect(result.claims.every(claim=>claim.status==="unverified")).toBe(true);
 });
});
