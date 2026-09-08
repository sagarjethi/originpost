import { describe, expect, it, vi } from "vitest";
import { LumaMumbaiSourcingProvider } from "../src/index.js";

function html(events: unknown[]): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { events } } } } })}</script></body></html>`;
}

function fixture(input: { title: string; slug: string; start: string; end?: string; visibility?: string; locationType?: string }) {
  return {
    event: {
      api_id: `evt-${input.slug}`,
      name: input.title,
      start_at: input.start,
      end_at: input.end ?? input.start,
      url: input.slug,
      visibility: input.visibility ?? "public",
      location_type: input.locationType ?? "offline",
      geo_address_visibility: "guests-only",
      geo_address_info: { sublocality: "BKC", city_state: "Mumbai, India", full_address: "Private exact address" },
    },
    calendar: { name: "Mumbai Builders" },
    hosts: [{ name: "Public Host", email: "host-private@example.test" }],
    guest_count: 400,
    guest_info: { name: "Private Guest", email: "guest@example.test" },
    featured_guests: [{ name: "Private Featured Guest" }],
    registration_availability: "open",
  };
}

describe("Luma Mumbai public sourcing", () => {
  it("keeps only upcoming public in-person events and strips guest data and non-public venue detail", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(html([
      fixture({ title: "Later event", slug: "later-event", start: "2026-09-11T12:00:00.000Z" }),
      fixture({ title: "Soon event", slug: "soon-event", start: "2026-09-10T12:00:00.000Z" }),
      fixture({ title: "Past event", slug: "past-event", start: "2026-09-08T12:00:00.000Z" }),
      fixture({ title: "Private event", slug: "private-event", start: "2026-09-12T12:00:00.000Z", visibility: "private" }),
      fixture({ title: "Online event", slug: "online-event", start: "2026-09-12T12:00:00.000Z", locationType: "online" }),
    ]), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
    const provider = new LumaMumbaiSourcingProvider({ fetchImpl, now: () => new Date("2026-09-09T00:00:00.000Z") });
    const result = await provider.research({ sessionKey: "mumbai", query: "Mumbai events", depth: "standard", languages: ["English"], sourceLimit: 2 });

    expect(result.provider).toBe("luma-public");
    expect(result.sources.map((source) => source.url)).toEqual(["https://luma.com/soon-event", "https://luma.com/later-event"]);
    expect(result.sources[0]?.excerpt).toContain("Venue: BKC");
    expect(result.sources[0]?.excerpt).toContain("Public organizer: Mumbai Builders");
    expect(result.sources[0]?.excerpt).not.toContain("Private exact address");
    expect(result.claims[0]?.text).toContain("Public Host");
    expect(result.toolsUsed).toEqual(["luma_public_city_page"]);
    expect(JSON.stringify(result.raw)).not.toMatch(/guest|attendee|private@example|Private exact address|400/iu);
  });

  it("fails health closed when the structured public payload is absent", async () => {
    const provider = new LumaMumbaiSourcingProvider({ fetchImpl: vi.fn().mockImplementation(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch });
    await expect(provider.health()).resolves.toBe(false);
    await expect(provider.research({ sessionKey: "mumbai", query: "Mumbai events", depth: "quick", languages: ["English"], sourceLimit: 2 })).rejects.toThrow("structured public-event payload");
  });

  it("rejects a declared response larger than the page limit before reading it", async () => {
    const provider = new LumaMumbaiSourcingProvider({ fetchImpl: vi.fn().mockResolvedValue(new Response("small", { status: 200, headers: { "content-type": "text/html", "content-length": String(5 * 1024 * 1024 + 1) } })) as typeof fetch });
    await expect(provider.research({ sessionKey: "mumbai", query: "Mumbai events", depth: "quick", languages: ["English"], sourceLimit: 2 })).rejects.toThrow("oversized page");
  });

  it("stops an undeclared response when its streamed bytes exceed the page limit", async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    const provider = new LumaMumbaiSourcingProvider({ fetchImpl: vi.fn().mockResolvedValue(new Response(oversized, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch });
    await expect(provider.research({ sessionKey: "mumbai", query: "Mumbai events", depth: "quick", languages: ["English"], sourceLimit: 2 })).rejects.toThrow("oversized page");
  });
});
