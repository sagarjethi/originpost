import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourcingProvider, SourcingRequest, SourcingResult } from "./research.js";

const LUMA_MUMBAI_URL = "https://luma.com/mumbai";
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

const addressSchema = z.object({
  mode: z.string().max(40).nullish(),
  city: z.string().max(120).nullish(),
  city_state: z.string().max(180).nullish(),
  sublocality: z.string().max(180).nullish(),
  address: z.string().max(240).nullish(),
  short_address: z.string().max(300).nullish(),
  full_address: z.string().max(500).nullish(),
});

const publicEventSchema = z.object({
  event: z.object({
    api_id: z.string().max(120).nullish(),
    name: z.string().min(1).max(300),
    start_at: z.iso.datetime(),
    end_at: z.iso.datetime().nullish(),
    url: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/iu),
    visibility: z.literal("public"),
    location_type: z.literal("offline"),
    geo_address_visibility: z.string().max(40).nullish(),
    geo_address_info: addressSchema.nullish(),
  }),
  calendar: z.object({ name: z.string().min(1).max(160) }).nullish(),
  hosts: z.array(z.object({ name: z.string().min(1).max(160).nullish() })).max(24).default([]),
  registration_availability: z.string().max(60).nullish(),
});

const pageSchema = z.object({
  props: z.object({
    pageProps: z.object({
      initialData: z.object({
        data: z.object({ events: z.array(z.unknown()).max(100) }),
      }),
    }),
  }),
});

type PublicEvent = z.infer<typeof publicEventSchema>;

function clean(value: string | null | undefined, max: number): string | undefined {
  const result = value?.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return result ? result.slice(0, max) : undefined;
}

function venueFor(event: PublicEvent["event"]): string {
  const address = event.geo_address_info;
  if (!address) return "Mumbai";
  const approximate = clean(address.sublocality, 180) ?? clean(address.city_state, 180) ?? clean(address.city, 120) ?? "Mumbai";
  if (event.geo_address_visibility !== "public") return approximate;
  return clean(address.short_address, 300) ?? clean(address.address, 240) ?? clean(address.full_address, 500) ?? approximate;
}

function displayTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function registrationStatus(value: string | null | undefined): string | undefined {
  const status = clean(value, 60)?.replace(/-/gu, " ");
  return status ? status[0]!.toLocaleUpperCase("en-US") + status.slice(1) : undefined;
}

function extractPage(html: string): z.infer<typeof pageSchema> {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu);
  if (!match?.[1]) throw new Error("Luma Mumbai did not return its structured public-event payload.");
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]); }
  catch { throw new Error("Luma Mumbai returned an invalid structured public-event payload."); }
  return pageSchema.parse(parsed);
}

async function readBoundedHtml(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) throw new Error("Luma Mumbai returned an oversized page.");
  if (!response.body) return "";

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PAGE_BYTES) throw new Error("Luma Mumbai returned an oversized page.");
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class LumaMumbaiSourcingProvider implements SourcingProvider {
  readonly id = "luma-public";

  constructor(private readonly config: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  } = {}) {}

  private async load(): Promise<PublicEvent[]> {
    const response = await (this.config.fetchImpl ?? fetch)(LUMA_MUMBAI_URL, {
      headers: { accept: "text/html", "user-agent": "OriginPost/0.1 public-event-monitor" },
      redirect: "follow",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`Luma Mumbai returned HTTP ${response.status}.`);
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== "https://luma.com" || finalUrl.pathname !== "/mumbai") throw new Error("Luma Mumbai redirected outside its approved public city page.");
    }
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
    if (contentType && !contentType.includes("text/html")) throw new Error("Luma Mumbai returned an unexpected content type.");
    const page = extractPage(await readBoundedHtml(response));
    return page.props.pageProps.initialData.data.events.flatMap((candidate) => {
      const parsed = publicEventSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async health(): Promise<boolean> {
    try { await this.load(); return true; }
    catch { return false; }
  }

  async research(request: SourcingRequest): Promise<SourcingResult> {
    const now = (this.config.now ?? (() => new Date()))();
    const events = (await this.load())
      .filter(({ event }) => Date.parse(event.end_at ?? event.start_at) >= now.getTime())
      .sort((left, right) => left.event.start_at.localeCompare(right.event.start_at))
      .slice(0, Math.max(1, Math.min(20, request.sourceLimit)))
      .map(({ event, calendar, hosts, registration_availability }) => {
        const title = clean(event.name, 300)!;
        const url = `https://luma.com/${event.url}`;
        const venue = venueFor(event);
        const publicHosts = [...new Set(hosts.map((host) => clean(host.name, 160)).filter((name): name is string => Boolean(name)))].slice(0, 12);
        const startsAt = event.start_at;
        const endsAt = event.end_at ?? undefined;
        const status = registrationStatus(registration_availability);
        const calendarName = clean(calendar?.name, 160);
        const publicOrganizer = calendarName && calendarName !== "Personal" ? calendarName : undefined;
        const facts = [`Starts ${displayTime(startsAt)}`, `Venue: ${venue}`, ...(publicOrganizer ? [`Public organizer: ${publicOrganizer}`] : []), ...(publicHosts.length ? [`Public hosts: ${publicHosts.join(", ")}`] : []), ...(status ? [`Registration: ${status}`] : [])];
        return { title, url, venue, publicHosts, startsAt, endsAt, status, publicOrganizer, summary: facts.join(" · ") };
      });

    const fetchedAt = now.toISOString();
    const responseId = `luma_mumbai_${createHash("sha256").update(JSON.stringify(events.map((event) => [event.url, event.startsAt, event.status]))).digest("hex").slice(0, 24)}`;
    return {
      provider: this.id,
      model: "luma-public-city-page-v1",
      responseId,
      summary: events.length ? `Found ${events.length} upcoming public ${events.length === 1 ? "event" : "events"} on Luma's official Mumbai city page.` : "Luma's official Mumbai city page currently has no upcoming public events in the returned listing.",
      sources: events.map((event) => ({ title: event.title, url: event.url, publisher: "Luma", excerpt: event.summary, confidence: 95 })),
      claims: events.map((event) => ({ text: `Luma lists “${event.title}” as a public in-person event starting ${displayTime(event.startsAt)} in ${event.venue}${event.publicOrganizer ? `, organized by ${event.publicOrganizer}` : ""}${event.publicHosts.length ? `, with public hosts ${event.publicHosts.join(", ")}` : ""}.`, status: "supported" as const, sourceUrls: [event.url] })),
      suggestions: events.map((event) => ({ title: event.title, summary: event.summary, sourceUrls: [event.url] })),
      toolsUsed: ["luma_public_city_page"],
      raw: {
        city: "Mumbai",
        sourceUrl: LUMA_MUMBAI_URL,
        fetchedAt,
        eventCount: events.length,
        events: events.map(({ title, url, venue, publicHosts, startsAt, endsAt, status, publicOrganizer }) => ({ title, url, venue, publicHosts, startsAt, ...(endsAt ? { endsAt } : {}), ...(status ? { status } : {}), ...(publicOrganizer ? { publicOrganizer } : {}) })),
      },
    };
  }
}
