import { DomainError } from "./errors.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent, ContentItem, MonitorRule, ResearchDepth, SourceEvidence } from "./types.js";
import { createHash } from "node:crypto";
import { createContentItem } from "./workflow.js";
import { prepareSourceIntelligenceConfig, type SourceIntelligenceInput } from "./source-intelligence.js";

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src"]);

export function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function sourceFingerprint(value: string): string {
  return createHash("sha256").update(canonicalSourceUrl(value)).digest("hex");
}

export function createMonitorSuggestion(input: {
  workspaceId: string;
  brandId?: string | undefined;
  monitorId: string;
  monitorRunId: string;
  title: string;
  summary: string;
  query: string;
  depth: ResearchDepth;
  languages: string[];
  region?: string | undefined;
  freshnessHours: number;
  sourceLimit: number;
  sources: Array<Omit<SourceEvidence, "id" | "capturedAt">>;
  claims: Array<{ text: string; status: "unverified" | "supported" | "disputed" | "rejected"; sourceUrls: string[] }>;
  provider: string;
  model: string;
  responseId?: string | undefined;
  toolsUsed: string[];
}, actor: Actor, now = new Date().toISOString()): { item: ContentItem; event: AuditEvent } {
  if (!input.sources.length) throw new DomainError("A monitor suggestion needs at least one source.", "monitor_source_required");
  const created = createContentItem({ workspaceId: input.workspaceId, brandId: input.brandId, title: input.title, summary: input.summary, actor, researchDepth: input.depth, riskLevel: "medium", now });
  const sourceIdsByUrl = new Map<string, string>();
  const sources = input.sources.map((source) => {
    const id = `source_${crypto.randomUUID()}`;
    if (source.url) sourceIdsByUrl.set(source.url, id);
    return { ...source, id, capturedAt: now };
  });
  const claims = input.claims.map((claim) => ({ id: `claim_${crypto.randomUUID()}`, text: claim.text, status: claim.status, sourceIds: [...new Set(claim.sourceUrls.map((url) => sourceIdsByUrl.get(url)).filter((id): id is string => Boolean(id)))] }));
  const researchRun = {
    id: `research_${crypto.randomUUID()}`, query: input.query, depth: input.depth, languages: input.languages, ...(input.region ? { region: input.region } : {}),
    sourceLimit: input.sourceLimit, freshnessHours: input.freshnessHours, status: "completed" as const, provider: input.provider, model: input.model,
    ...(input.responseId ? { responseId: input.responseId } : {}), toolsUsed: input.toolsUsed, sourceCount: sources.length, claimCount: claims.length,
    createdBy: actor.id, createdAt: now, startedAt: now, completedAt: now,
  };
  const item: ContentItem = { ...created.item, tags: ["monitor", sources.length >= 2 ? "multi-source" : "single-source"], sources, claims, researchRuns: [researchRun] };
  const event: AuditEvent = { ...created.event, actorType: "agent", detail: { ...created.event.detail, monitorId: input.monitorId, monitorRunId: input.monitorRunId, sourceCount: sources.length, claimCount: claims.length } };
  return { item, event };
}

export function createMonitorRule(
  input: Omit<MonitorRule, "id" | "createdBy" | "createdAt" | "updatedAt" | "sourceIntelligence"> & { sourceIntelligence?: SourceIntelligenceInput | undefined },
  actor: Actor,
  now = new Date().toISOString(),
): MonitorRule {
  if (!can(actor.role, "automation:manage")) throw new DomainError("This role cannot create monitors.", "permission_denied", 403);
  const sourceIntelligence = input.sourceIntelligence ? prepareSourceIntelligenceConfig(input.sourceIntelligence) : undefined;
  const { sourceIntelligence: _sourceIntelligence, ...baseInput } = input;
  return {
    ...baseInput,
    id: `monitor_${crypto.randomUUID()}`,
    intervalMinutes: Math.max(10, Math.min(1440, input.intervalMinutes)),
    languages: [...new Set(input.languages.map((language) => language.trim()).filter(Boolean))],
    sourceLimit: Math.max(2, Math.min(20, input.sourceLimit)),
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
    ...(sourceIntelligence ? { sourceIntelligence } : {}),
  };
}

export function updateMonitorRule(
  rule: MonitorRule,
  patch: { [K in keyof Omit<MonitorRule, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt" | "sourceIntelligence">]?: Omit<MonitorRule, "id" | "workspaceId" | "createdBy" | "createdAt" | "updatedAt" | "sourceIntelligence">[K] | undefined } & { sourceIntelligence?: SourceIntelligenceInput | undefined },
  actor: Actor,
  now = new Date().toISOString(),
): MonitorRule {
  if (!can(actor.role, "automation:manage")) throw new DomainError("This role cannot edit monitors.", "permission_denied", 403);
  const { sourceIntelligence: _sourceIntelligence, ...plainPatch } = patch;
  const definedPatch = Object.fromEntries(Object.entries(plainPatch).filter(([, value]) => value !== undefined)) as Partial<MonitorRule>;
  const sourceIntelligence = patch.sourceIntelligence ? prepareSourceIntelligenceConfig(patch.sourceIntelligence) : rule.sourceIntelligence;
  return {
    ...rule,
    ...definedPatch,
    intervalMinutes: Math.max(10, Math.min(1440, patch.intervalMinutes ?? rule.intervalMinutes)),
    languages: patch.languages ? [...new Set(patch.languages.map((language) => language.trim()).filter(Boolean))] : rule.languages,
    sourceLimit: Math.max(2, Math.min(20, patch.sourceLimit ?? rule.sourceLimit)),
    updatedAt: now,
    ...(sourceIntelligence ? { sourceIntelligence } : {}),
  };
}
