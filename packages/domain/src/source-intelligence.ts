import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent, ContentItem, MonitorRule, SourceEvidence } from "./types.js";
import { createContentItem } from "./workflow.js";

export const trackedSourceKinds = ["rss_atom", "luma_city", "publisher_site", "public_profile"] as const;
export type TrackedSourceKind = (typeof trackedSourceKinds)[number];
export type TrackedSourcePriority = "primary" | "trusted" | "context";
export type SourceSignalState = "new" | "saving" | "saved" | "dismissed";
export type SourceSignalUrgency = "low" | "normal" | "high";

export interface TrackedPublicSource {
  id: string;
  label: string;
  url: string;
  kind: TrackedSourceKind;
  publisher?: string | undefined;
  priority: TrackedSourcePriority;
  enabled: boolean;
}

export interface SourceIntelligenceConfig {
  mode: "tracked_sources";
  sources: TrackedPublicSource[];
  includeTerms: string[];
  excludeTerms: string[];
  minimumScore: number;
}

export interface SourceIntelligenceInput {
  mode?: "tracked_sources" | undefined;
  sources: Array<Omit<TrackedPublicSource, "id" | "priority"> & { id?: string | undefined; priority?: TrackedSourcePriority | undefined }>;
  includeTerms?: string[] | undefined;
  excludeTerms?: string[] | undefined;
  minimumScore?: number | undefined;
}

export interface SourceSignal {
  id: string;
  workspaceId: string;
  brandId: string;
  monitorId: string;
  monitorRunId: string;
  version: number;
  state: SourceSignalState;
  urgency: SourceSignalUrgency;
  score: number;
  rankReasons: string[];
  eventFingerprint: string;
  title: string;
  summary: string;
  sources: SourceEvidence[];
  claims: Array<{ id: string; text: string; status: "unverified" | "supported" | "disputed" | "rejected"; sourceIds: string[] }>;
  discovery: { query: string; provider: string; model: string; responseId?: string | undefined; toolsUsed: string[] };
  occurrenceCount: number;
  publishedAt?: string | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  contentItemId?: string | undefined;
  savedBy?: string | undefined;
  savedAt?: string | undefined;
  dismissedBy?: string | undefined;
  dismissedAt?: string | undefined;
  dismissReason?: string | undefined;
  pendingContentItemId?: string | undefined;
  saveClaimId?: string | undefined;
  saveLeaseExpiresAt?: string | undefined;
}

export interface SourceSignalListQuery {
  workspaceId: string; brandId?: string | undefined; state?: SourceSignalState | undefined;
  monitorId?: string | undefined; search?: string | undefined; limit?: number | undefined; offset?: number | undefined;
  publishedAfter?: string | undefined; publishedBefore?: string | undefined; sort?: "priority" | "newest" | "discovered" | undefined;
}

export interface SourceSignalRepository {
  ingest(signals: SourceSignal[]): Promise<{ signals: SourceSignal[]; newCount: number; updatedCount: number }>;
  list(input: SourceSignalListQuery): Promise<SourceSignal[]>;
  get(workspaceId: string, id: string): Promise<SourceSignal | null>;
  claimSave(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; claimId: string; leaseExpiresAt: string; contentItemId: string }): Promise<SourceSignal | null>;
  finishSave(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; claimId: string; contentItemId: string }): Promise<SourceSignal | null>;
  triage(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; action: "dismissed" | "restored"; reason?: string | undefined }): Promise<SourceSignal | null>;
  summary(workspaceId: string, brandId?: string): Promise<{ new: number; saving: number; saved: number; dismissed: number; highUrgency: number }>;
}

export interface SourceIntelligenceDiscovery {
  monitorRunId: string;
  provider: string;
  model: string;
  responseId?: string | undefined;
  toolsUsed: string[];
  suggestions: Array<{ title: string; summary: string; sourceUrls: string[] }>;
  sources: Array<{ title: string; url: string; publisher?: string | undefined; publishedAt?: string | undefined; excerpt?: string | undefined; confidence: number; stableId?: string | undefined; feedUrl?: string | undefined }>;
  claims: Array<{ text: string; status: "unverified" | "supported" | "disputed" | "rejected"; sourceUrls: string[] }>;
}

function clean(value: string, max: number, field: string): string {
  const result = value.normalize("NFC").replace(/\u0000/gu, "").trim();
  if (!result || result.length > max) throw new DomainError(`${field} must contain 1–${max} characters.`, "source_intelligence_invalid");
  return result;
}

function canonicalPublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new DomainError("Tracked sources need a valid web address.", "tracked_source_url_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw new DomainError("Tracked sources must use a normal HTTP or HTTPS address without embedded credentials.", "tracked_source_url_invalid");
  url.hash = ""; url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_") || ["fbclid", "gclid", "igshid"].includes(key.toLowerCase())) url.searchParams.delete(key);
  url.searchParams.sort(); if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function normalizedTerms(values: string[] | undefined, max: number): string[] {
  const terms = [...new Set((values ?? []).map((value) => value.normalize("NFC").trim().toLocaleLowerCase("en-US")).filter(Boolean))];
  if (terms.length > max || terms.some((term) => term.length > 80)) throw new DomainError(`Use at most ${max} terms, each no longer than 80 characters.`, "source_intelligence_terms_invalid");
  return terms;
}

export function prepareSourceIntelligenceConfig(input: SourceIntelligenceInput): SourceIntelligenceConfig {
  if (input.sources.length < 1 || input.sources.length > 50) throw new DomainError("A tracked-source monitor needs 1–50 public sources.", "tracked_source_count_invalid");
  const urls = new Set<string>();
  const sources = input.sources.map((source, index) => {
    const url = canonicalPublicUrl(source.url); if (urls.has(url)) throw new DomainError("The same public source cannot be tracked twice.", "tracked_source_duplicate"); urls.add(url);
    if (!trackedSourceKinds.includes(source.kind)) throw new DomainError("Tracked source kind is not supported.", "tracked_source_kind_invalid");
    if ((source.kind === "publisher_site" || source.kind === "public_profile") && source.enabled !== false) throw new DomainError("Website pages and social profiles stay off until a separately approved official adapter is configured.", "tracked_source_official_connector_required", 409);
    if (source.kind === "luma_city" && url !== "https://luma.com/mumbai") throw new DomainError("The first Luma source supports the official Mumbai city page only.", "luma_city_unsupported", 409);
    const priority = source.priority ?? "trusted";
    if (!["primary", "trusted", "context"].includes(priority)) throw new DomainError("Source priority must be primary, trusted, or context.", "tracked_source_priority_invalid");
    return { id: source.id?.trim() || `tracked_${createHash("sha256").update(url).digest("hex").slice(0, 20)}_${index + 1}`, label: clean(source.label, 120, "Source label"), url, kind: source.kind, ...(source.publisher?.trim() ? { publisher: clean(source.publisher, 120, "Publisher") } : {}), priority, enabled: source.enabled !== false };
  });
  if (!sources.some((source) => source.enabled)) throw new DomainError("Keep at least one tracked source enabled.", "tracked_source_enabled_required");
  const minimumScore = input.minimumScore ?? 45;
  if (!Number.isInteger(minimumScore) || minimumScore < 0 || minimumScore > 100) throw new DomainError("Minimum signal score must be between 0 and 100.", "source_intelligence_score_invalid");
  return { mode: "tracked_sources", sources, includeTerms: normalizedTerms(input.includeTerms, 30), excludeTerms: normalizedTerms(input.excludeTerms, 30), minimumScore };
}

export function sourceIntelligenceResearchContext(config: SourceIntelligenceConfig): string {
  const sources = config.sources.filter((source) => source.enabled).map((source) => `- ${source.label} [${source.kind}; ${source.priority}]: ${source.url}`).join("\n");
  const lumaRules = config.sources.some((source) => source.enabled && source.kind === "luma_city")
    ? "For Luma Mumbai, report only upcoming public events visibly listed on the official Mumbai page. Include the public event URL, date/time, venue, and public host or organizer names. Never collect attendee or guest-list identities."
    : "";
  return ["Tracked-source intelligence run. RSS/Atom feeds are machine-readable sources; do not crawl their publisher websites. Website pages and social profiles are unsupported unless a dedicated provider adapter is named. Do not bypass login, rate limits, robots controls, or private groups. Do not claim complete coverage.", lumaRules, sources, config.includeTerms.length ? `Prefer items matching: ${config.includeTerms.join(", ")}.` : "", config.excludeTerms.length ? `Exclude items matching: ${config.excludeTerms.join(", ")}.` : ""].filter(Boolean).join("\n");
}

function urlWithinSource(candidate: string, source: TrackedPublicSource): boolean {
  try {
    const target = new URL(canonicalPublicUrl(candidate)); const base = new URL(source.url);
    if (source.kind === "luma_city") return base.href === "https://luma.com/mumbai" && target.origin === "https://luma.com" && /^\/[a-z0-9][a-z0-9-]{2,80}$/iu.test(target.pathname);
    if (target.origin !== base.origin) return false;
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return target.pathname === base.pathname || target.pathname.startsWith(basePath);
  } catch { return false; }
}

function signalSha256(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function rankSourceSignals(monitor: MonitorRule, discovery: SourceIntelligenceDiscovery, now = new Date().toISOString()): SourceSignal[] {
  const config = monitor.sourceIntelligence;
  if (!config || config.mode !== "tracked_sources") return [];
  const candidates: SourceSignal[] = [];
  const matchesTracked = (source: SourceIntelligenceDiscovery["sources"][number], tracked: TrackedPublicSource) =>
    tracked.enabled && ((["public-feeds", "public-tracked"].includes(discovery.provider) && tracked.kind === "rss_atom" && source.feedUrl === tracked.url) || urlWithinSource(source.url, tracked));
  for (const suggestion of discovery.suggestions.slice(0, 500)) {
    const selected = discovery.sources.filter((source) => suggestion.sourceUrls.includes(source.url)).filter((source) => config.sources.some((tracked) => matchesTracked(source, tracked))).slice(0, 20);
    if (!selected.length) continue;
    const combined = [suggestion.title, suggestion.summary, ...selected.map((source) => `${source.title} ${source.excerpt ?? ""}`)].join(" ").normalize("NFC").toLocaleLowerCase("en-US");
    if (config.excludeTerms.some((term) => combined.includes(term))) continue;
    const matchedTerms = config.includeTerms.filter((term) => combined.includes(term));
    const publisherCount = new Set(selected.map((source) => source.publisher?.toLocaleLowerCase("en-US")).filter(Boolean)).size;
    const nowTime = Date.parse(now);
    const fresh = selected.some((source) => {
      const published = source.publishedAt ? Date.parse(source.publishedAt) : Number.NaN;
      return Number.isFinite(published) && published <= nowTime && nowTime - published <= monitor.freshnessHours * 3_600_000;
    });
    const selectedTrackedSources = config.sources.filter((tracked) => selected.some((source) => matchesTracked(source, tracked)));
    const sourcePriority = selectedTrackedSources.some((source) => source.priority === "primary") ? "primary" : selectedTrackedSources.some((source) => source.priority === "trusted") ? "trusted" : "context";
    const priorityScore = sourcePriority === "primary" ? 10 : sourcePriority === "trusted" ? 5 : 0;
    let score = 35 + priorityScore + Math.min(30, matchedTerms.length * 10) + (selected.length >= 2 && publisherCount >= 2 ? 15 : 0) + (fresh ? 10 : 0);
    score = Math.min(100, score); if (score < config.minimumScore) continue;
    const eventReferences = selected.map((source) => source.stableId?.trim() || canonicalPublicUrl(source.url)).sort();
    const normalizedTitle = suggestion.title.normalize("NFC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
    const feedEntry = selected.some(source => source.feedUrl) && ["public-feeds", "public-tracked"].includes(discovery.provider);
    const eventFingerprint = signalSha256(feedEntry ? { schemaVersion: "originpost.feed-event.v1", references: selected.map(source => canonicalPublicUrl(source.url)).sort() } : { schemaVersion: "originpost.source-event.v1", title: normalizedTitle, references: eventReferences });
    const publishedAt = selected.map(source => source.publishedAt).filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)) && Date.parse(value!) <= nowTime).sort().at(-1);
    const sourceIds = new Map<string, string>();
    const sources: SourceEvidence[] = selected.map((source) => { const id = `source_${signalSha256(canonicalPublicUrl(source.url)).slice(0, 24)}`; sourceIds.set(source.url, id); return { id, kind: "url", title: source.title.slice(0, 300), url: source.url, ...(source.publisher ? { publisher: source.publisher } : {}), ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}), confidence: Math.max(0, Math.min(100, Math.round(source.confidence))), rights: "reference-only", capturedAt: now, ...(source.excerpt ? { notes: source.excerpt.slice(0, 1500) } : {}) }; });
    const claims = discovery.claims.filter((claim) => claim.sourceUrls.some((url) => sourceIds.has(url))).slice(0, 50).map((claim) => ({ id: `claim_${signalSha256([claim.text, ...claim.sourceUrls]).slice(0, 24)}`, text: claim.text.slice(0, 1000), status: claim.status, sourceIds: [...new Set(claim.sourceUrls.map((url) => sourceIds.get(url)).filter((id): id is string => Boolean(id)))] }));
    const rankReasons = ["Tracked source", ...(sourcePriority === "primary" ? ["Primary source"] : sourcePriority === "trusted" ? ["Trusted source"] : []), ...(matchedTerms.length ? [`Matched ${matchedTerms.slice(0, 3).join(", ")}`] : []), ...(selected.length >= 2 && publisherCount >= 2 ? ["Multiple publishers"] : []), ...(fresh ? ["Fresh result"] : [])];
    candidates.push({ id: `signal_${signalSha256([monitor.workspaceId, monitor.id, eventFingerprint]).slice(0, 32)}`, workspaceId: monitor.workspaceId, brandId: monitor.brandId, monitorId: monitor.id, monitorRunId: discovery.monitorRunId, version: 1, state: "new", urgency: score >= 80 ? "high" : score >= 60 ? "normal" : "low", score, rankReasons, eventFingerprint, title: suggestion.title.trim().slice(0, 300), summary: suggestion.summary.trim().slice(0, 2000), sources, claims, discovery: { query: monitor.query, provider: discovery.provider, model: discovery.model, ...(discovery.responseId ? { responseId: discovery.responseId } : {}), toolsUsed: [...new Set(discovery.toolsUsed)].slice(0, 30) }, occurrenceCount: 1, ...(publishedAt ? {publishedAt} : {}), firstSeenAt: now, lastSeenAt: now });
  }
  return candidates.sort((a, b) => b.score - a.score || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function signalToContentItem(signal: SourceSignal, actor: Actor, now = new Date().toISOString()): { item: ContentItem; event: AuditEvent } {
  if (actor.actorType && actor.actorType !== "human") throw new DomainError("A person must choose which signal becomes content.", "human_required", 403);
  if (!can(actor.role, "content:create")) throw new DomainError("This role cannot save signals to the Content Inbox.", "permission_denied", 403);
  const created = createContentItem({ contentId: `content_signal_${signal.id.replace(/^signal_/u, "")}`, workspaceId: signal.workspaceId, brandId: signal.brandId, title: signal.title, summary: signal.summary, actor, researchDepth: "standard", riskLevel: "medium", now });
  const item: ContentItem = { ...created.item, tags: ["signal", "tracked-source", signal.urgency === "high" ? "high-signal" : "triaged"], sources: structuredClone(signal.sources), claims: structuredClone(signal.claims), researchRuns: [{ id: `research_${signal.id.replace(/^signal_/u, "")}`, query: signal.discovery.query, depth: "standard", languages: [], sourceLimit: signal.sources.length, freshnessHours: 24, status: "completed", provider: signal.discovery.provider, model: signal.discovery.model, ...(signal.discovery.responseId ? { responseId: signal.discovery.responseId } : {}), toolsUsed: signal.discovery.toolsUsed, sourceCount: signal.sources.length, claimCount: signal.claims.length, createdBy: actor.id, createdAt: now, startedAt: signal.firstSeenAt, completedAt: now }] };
  return { item, event: { ...created.event, detail: { ...created.event.detail, sourceSignalId: signal.id, monitorId: signal.monitorId, monitorRunId: signal.monitorRunId, signalScore: signal.score, eventFingerprint: signal.eventFingerprint } } };
}

export class InMemorySourceSignalRepository implements SourceSignalRepository {
  private readonly records = new Map<string, SourceSignal>();
  async ingest(signals: SourceSignal[]) { let newCount = 0; let updatedCount = 0; const stored: SourceSignal[] = []; for (const signal of signals) { const existing = this.records.get(signal.id); if (!existing) { this.records.set(signal.id, structuredClone(signal)); stored.push(structuredClone(signal)); newCount += 1; continue; } const next = { ...signal, version: existing.version + 1, state: existing.state, occurrenceCount: existing.occurrenceCount + 1, firstSeenAt: existing.firstSeenAt, ...(existing.contentItemId ? { contentItemId: existing.contentItemId, savedBy: existing.savedBy, savedAt: existing.savedAt } : {}), ...(existing.dismissedBy ? { dismissedBy: existing.dismissedBy, dismissedAt: existing.dismissedAt, dismissReason: existing.dismissReason } : {}), ...(existing.state === "saving" ? { pendingContentItemId: existing.pendingContentItemId, saveClaimId: existing.saveClaimId, saveLeaseExpiresAt: existing.saveLeaseExpiresAt } : {}) }; this.records.set(signal.id, structuredClone(next)); stored.push(structuredClone(next)); updatedCount += 1; } return { signals: stored, newCount, updatedCount }; }
  async list(input: SourceSignalListQuery) { const search = input.search?.trim().toLocaleLowerCase("en-US"); return [...this.records.values()].filter((signal) => signal.workspaceId === input.workspaceId && (!input.brandId || signal.brandId === input.brandId) && (!input.state || signal.state === input.state) && (!input.monitorId || signal.monitorId === input.monitorId) && (!input.publishedAfter || Boolean(signal.publishedAt && signal.publishedAt >= input.publishedAfter)) && (!input.publishedBefore || !signal.publishedAt || signal.publishedAt <= input.publishedBefore) && (!search || `${signal.title} ${signal.summary} ${signal.sources.map((source) => source.publisher ?? source.title).join(" ")}`.toLocaleLowerCase("en-US").includes(search))).sort((a, b) => (input.sort === "newest" ? (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") : input.sort === "discovered" ? b.firstSeenAt.localeCompare(a.firstSeenAt) : b.score - a.score) || b.firstSeenAt.localeCompare(a.firstSeenAt) || a.id.localeCompare(b.id)).slice(input.offset ?? 0, (input.offset ?? 0) + Math.min(200, input.limit ?? 100)).map((signal) => structuredClone(signal)); }
  async get(workspaceId: string, id: string) { const signal = this.records.get(id); return signal?.workspaceId === workspaceId ? structuredClone(signal) : null; }
  async claimSave(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; claimId: string; leaseExpiresAt: string; contentItemId: string }) { const current = this.records.get(input.id); if (!current || current.workspaceId !== input.workspaceId || current.version !== input.expectedVersion) return null; if (current.state !== "new" && !(current.state === "saving" && Date.parse(current.saveLeaseExpiresAt ?? "") <= Date.parse(input.at))) return null; const next: SourceSignal = { ...current, version: current.version + 1, state: "saving", pendingContentItemId: input.contentItemId, saveClaimId: input.claimId, saveLeaseExpiresAt: input.leaseExpiresAt }; this.records.set(input.id, structuredClone(next)); return structuredClone(next); }
  async finishSave(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; claimId: string; contentItemId: string }) { const current = this.records.get(input.id); if (!current || current.workspaceId !== input.workspaceId || current.version !== input.expectedVersion || current.state !== "saving" || current.saveClaimId !== input.claimId || current.pendingContentItemId !== input.contentItemId) return null; const next: SourceSignal = { ...current, version: current.version + 1, state: "saved", contentItemId: input.contentItemId, savedBy: input.actorId, savedAt: input.at }; delete next.pendingContentItemId; delete next.saveClaimId; delete next.saveLeaseExpiresAt; this.records.set(input.id, structuredClone(next)); return structuredClone(next); }
  async triage(input: { workspaceId: string; id: string; expectedVersion: number; actorId: string; at: string; action: "dismissed" | "restored"; reason?: string }) { const current = this.records.get(input.id); if (!current || current.workspaceId !== input.workspaceId || current.version !== input.expectedVersion) return null; let next: SourceSignal; if (input.action === "dismissed") { if (current.state !== "new") return null; next = { ...current, version: current.version + 1, state: "dismissed", dismissedBy: input.actorId, dismissedAt: input.at, ...(input.reason?.trim() ? { dismissReason: input.reason.trim().slice(0, 300) } : {}) }; } else { if (current.state !== "dismissed") return null; next = { ...current, version: current.version + 1, state: "new" }; delete next.dismissedBy; delete next.dismissedAt; delete next.dismissReason; } this.records.set(input.id, structuredClone(next)); return structuredClone(next); }
  async summary(workspaceId: string, brandId?: string) { const values = [...this.records.values()].filter((signal) => signal.workspaceId === workspaceId && (!brandId || signal.brandId === brandId)); return { new: values.filter((signal) => signal.state === "new").length, saving: values.filter((signal) => signal.state === "saving").length, saved: values.filter((signal) => signal.state === "saved").length, dismissed: values.filter((signal) => signal.state === "dismissed").length, highUrgency: values.filter((signal) => signal.state === "new" && signal.urgency === "high").length }; }
}
