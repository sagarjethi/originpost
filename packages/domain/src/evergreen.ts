import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent, ContentItem, PlatformDraft, PublishProof, PublishTarget } from "./types.js";

export type EvergreenMode = "review_first" | "auto_schedule";
export type EvergreenStatus = "active" | "paused" | "completed";
export type EvergreenOccurrenceStatus = "processing" | "review_ready" | "scheduled" | "published" | "action_required" | "failed";

export interface EvergreenEntry {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  name: string;
  sourceContentItemId: string;
  sourceProofId: string;
  sourceDraftId: string;
  sourceDraftSha256: string;
  sourceTargetId: string;
  platform: PublishProof["platform"];
  accountId: string;
  mode: EvergreenMode;
  intervalDays: number;
  timezone: string;
  nextPublishAt: string;
  endAt: string;
  maxOccurrences: number;
  occurrenceCount: number;
  status: EvergreenStatus;
  approvedBy: string;
  approvedByName: string;
  approvedAt: string;
  policySha256: string;
  manualReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  claimId?: string;
  claimOwner?: string;
  claimLeaseExpiresAt?: string;
  pendingOccurrenceNo?: number;
  pendingContentItemId?: string;
}

export interface EvergreenOccurrence {
  id: string;
  workspaceId: string;
  brandId: string;
  entryId: string;
  occurrenceNo: number;
  scheduledFor: string;
  mode: EvergreenMode;
  status: EvergreenOccurrenceStatus;
  contentItemId: string;
  targetId?: string;
  proofId?: string;
  freshnessFlags?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvergreenCandidate {
  contentItemId: string;
  proofId: string;
  title: string;
  platform: PublishProof["platform"];
  accountId: string;
  publishedAt: string;
  score?: number;
  metricLabel?: string;
  metricValue?: number;
  autoEligible: boolean;
  blockers: string[];
}

export interface EvergreenRepository {
  list(input: { workspaceId: string; brandId?: string; status?: EvergreenStatus; limit?: number }): Promise<EvergreenEntry[]>;
  get(workspaceId: string, id: string): Promise<EvergreenEntry | null>;
  save(entry: EvergreenEntry, event: AuditEvent): Promise<void>;
  update(input: { workspaceId: string; id: string; expectedVersion: number; action: "pause" | "resume"; actorId: string; at: string; event: AuditEvent }): Promise<EvergreenEntry | null>;
  claimDue(input: { owner: string; before: string; limit: number; leaseSeconds: number }): Promise<EvergreenEntry[]>;
  completeClaim(input: { workspaceId: string; id: string; claimId: string; occurrence: EvergreenOccurrence; nextPublishAt: string; completed: boolean; at: string }): Promise<EvergreenEntry | null>;
  failClaim(input: { workspaceId: string; id: string; claimId: string; occurrence: EvergreenOccurrence; at: string }): Promise<EvergreenEntry | null>;
  listOccurrences(workspaceId: string, entryId: string, limit?: number): Promise<EvergreenOccurrence[]>;
  listOccurrencesAwaitingProof(limit?: number): Promise<EvergreenOccurrence[]>;
  linkPublishedOccurrence(input: { workspaceId: string; id: string; proofId: string; at: string }): Promise<EvergreenOccurrence | null>;
}

const forbiddenAutoTags = new Set(["news", "breaking", "signal", "tracked-source", "monitor", "high-signal"]);
const clean = (value: string, maximum: number, field: string) => {
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum) throw new DomainError(`${field} must contain 1–${maximum} characters.`, "evergreen_invalid");
  return result;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stableId = (prefix: string, ...parts: unknown[]) => `${prefix}_${hash(parts).slice(0, 32)}`;

function exactSource(item: ContentItem, proofId: string) {
  if (item.status !== "published") throw new DomainError("Only a published post can enter the reuse library.", "evergreen_source_not_published", 409);
  const proof = item.proofs.find((entry) => entry.id === proofId);
  if (!proof) throw new DomainError("Publish proof not found on this Content Item.", "evergreen_proof_not_found", 404);
  const draft = item.drafts.find((entry) => entry.id === proof.draftId && entry.contentSha256 === proof.draftSha256);
  const target = item.targets.findLast((entry) => entry.platform === proof.platform && entry.accountId === proof.accountId && entry.draftId === proof.draftId && entry.status === "published");
  if (!draft || !target) throw new DomainError("The source post no longer has exact draft and target lineage.", "evergreen_lineage_invalid", 409);
  return { proof, draft, target };
}

export function evergreenAutoBlockers(item: ContentItem, proof: PublishProof, target: PublishTarget): string[] {
  const blockers: string[] = [];
  if (item.riskLevel !== "low") blockers.push("Only low-risk content can run automatically.");
  if (item.tags.some((tag) => forbiddenAutoTags.has(tag.toLocaleLowerCase("en-US")))) blockers.push("News, breaking, monitor, and signal content always needs a fresh review.");
  if (proof.disclosure === "synthetic-media") blockers.push("Synthetic-media posts need a fresh review.");
  if (target.platform === "instagram" && target.settings && "collaborators" in target.settings && Array.isArray(target.settings.collaborators) && target.settings.collaborators.length) blockers.push("Instagram collaborator invitations need a new approval.");
  if (target.deliveryMode !== "auto_publish") blockers.push("The original target was not approved for automatic publishing.");
  return blockers;
}

export function evergreenFreshnessFlags(item:ContentItem):string[]{
  const text=[item.title,item.summary,...item.drafts.map((draft)=>`${draft.title} ${draft.caption}`),...item.claims.map((claim)=>claim.text)].join(" ").toLocaleLowerCase("en-US");
  const flags:string[]=[];
  if(/\b(today|tonight|tomorrow|yesterday|this week|breaking|live score)\b/u.test(text))flags.push("Check relative dates and live references.");
  if(/(?:₹|\$|€|£)\s?\d|\b(price|offer|discount|sale)\b/u.test(text))flags.push("Check prices and offers.");
  if(/\b(election|weather|earthquake|box office|office holder|minister|president|chief minister|health advice|legal advice|financial advice)\b/u.test(text))flags.push("Check changing public facts with current sources.");
  if(item.sources.some((source)=>source.rights==="reference-only"))flags.push("Reference-only sources do not grant media reuse rights.");
  return [...new Set(flags)];
}

export function createEvergreenEntry(input: {
  id?: string;
  source: ContentItem;
  proofId: string;
  name: string;
  mode: EvergreenMode;
  intervalDays: number;
  timezone: string;
  firstPublishAt: string;
  endAt: string;
  maxOccurrences: number;
  manualReason?: string;
  actor: Actor;
  now?: string;
}): { entry: EvergreenEntry; event: AuditEvent } {
  if ((input.actor.actorType && input.actor.actorType !== "human") || !can(input.actor.role, "automation:manage")) throw new DomainError("Only a manager or owner can create a reuse cycle.", "permission_denied", 403);
  const now = input.now ?? new Date().toISOString();
  const { proof, draft, target } = exactSource(input.source, input.proofId);
  if (!Number.isInteger(input.intervalDays) || input.intervalDays < 7 || input.intervalDays > 365) throw new DomainError("Repeat interval must be between 7 and 365 days.", "evergreen_interval_invalid");
  if (!Number.isInteger(input.maxOccurrences) || input.maxOccurrences < 1 || input.maxOccurrences > 52) throw new DomainError("Choose 1–52 repeats.", "evergreen_count_invalid");
  const first = Date.parse(input.firstPublishAt); const end = Date.parse(input.endAt); const nowMs = Date.parse(now);
  if (!Number.isFinite(first) || first < nowMs + 15 * 60_000) throw new DomainError("First reuse time must be at least 15 minutes from now.", "evergreen_first_time_invalid");
  if (!Number.isFinite(end) || end < first || end > nowMs + 366 * 24 * 60 * 60_000) throw new DomainError("Reuse must end after the first post and within one year.", "evergreen_end_invalid");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(new Date()); } catch { throw new DomainError("Choose a valid timezone.", "evergreen_timezone_invalid"); }
  const blockers = evergreenAutoBlockers(input.source, proof, target);
  if (input.mode === "auto_schedule") throw new DomainError("Every reuse cycle creates a fresh draft for human approval. Automatic reposting is not enabled.", "evergreen_human_approval_required", 409);
  const manualReason=input.manualReason?.normalize("NFC").trim();if(manualReason&&manualReason.length>300)throw new DomainError("Manual selection reason must be 300 characters or less.","evergreen_reason_invalid");
  const policy = { schemaVersion: "originpost.evergreen.v1", sourceContentItemId: input.source.id, sourceProofId: proof.id, sourceDraftSha256: draft.contentSha256, sourceTargetId: target.id, platform: proof.platform, accountId: proof.accountId, mode: input.mode, intervalDays: input.intervalDays, timezone: input.timezone, firstPublishAt: new Date(first).toISOString(), endAt: new Date(end).toISOString(), maxOccurrences: input.maxOccurrences,...(manualReason?{manualReason}:{}) };
  const entry: EvergreenEntry = { id: input.id ?? `evergreen_${randomUUID()}`, workspaceId: input.source.workspaceId, brandId: input.source.brandId, version: 1, name: clean(input.name, 120, "Reuse cycle name"), sourceContentItemId: input.source.id, sourceProofId: proof.id, sourceDraftId: draft.id, sourceDraftSha256: draft.contentSha256, sourceTargetId: target.id, platform: proof.platform, accountId: proof.accountId, mode: input.mode, intervalDays: input.intervalDays, timezone: input.timezone, nextPublishAt: policy.firstPublishAt, endAt: policy.endAt, maxOccurrences: input.maxOccurrences, occurrenceCount: 0, status: "active", approvedBy: input.actor.id, approvedByName: input.actor.name, approvedAt: now, policySha256: hash(policy),...(manualReason?{manualReason}:{}), createdBy: input.actor.id, createdAt: now, updatedAt: now };
  return { entry, event: { id: `evt_${randomUUID()}`, workspaceId: entry.workspaceId, contentItemId: entry.sourceContentItemId, actorId: input.actor.id, actorType: "human", action: "evergreen.created", detail: { evergreenEntryId: entry.id, mode: entry.mode, intervalDays: entry.intervalDays, maxOccurrences: entry.maxOccurrences, policySha256: entry.policySha256, autoBlockers: blockers }, createdAt: now } };
}

export function materializeEvergreenOccurrence(entry: EvergreenEntry, source: ContentItem, now = new Date().toISOString()): { item: ContentItem; occurrence: EvergreenOccurrence; event: AuditEvent } {
  if (entry.status !== "active" || !entry.claimId || !entry.pendingOccurrenceNo || !entry.pendingContentItemId) throw new DomainError("This reuse cycle does not hold an active occurrence claim.", "evergreen_claim_required", 409);
  const { proof, draft, target } = exactSource(source, entry.sourceProofId);
  if (source.workspaceId !== entry.workspaceId || source.brandId !== entry.brandId || draft.id !== entry.sourceDraftId || draft.contentSha256 !== entry.sourceDraftSha256 || target.id !== entry.sourceTargetId || proof.accountId !== entry.accountId || proof.platform !== entry.platform) throw new DomainError("The original post no longer matches the approved reuse policy.", "evergreen_policy_stale", 409);
  if (entry.mode === "auto_schedule") throw new DomainError("Automatic reposting is not enabled. Create a human-reviewed refresh cycle.", "evergreen_human_approval_required", 409);
  const occurrenceNo = entry.pendingOccurrenceNo; const scheduledFor = entry.nextPublishAt;
  const draftId = stableId("draft", entry.id, occurrenceNo); const itemId = entry.pendingContentItemId;
  const newDraft: PlatformDraft = { ...structuredClone(draft), id: draftId, revision: 1, createdBy: entry.approvedBy, createdAt: now };
  const item: ContentItem = { id: itemId, workspaceId: entry.workspaceId, brandId: entry.brandId, version: 1, title: source.title, summary: source.summary, status: "drafting", researchDepth: source.researchDepth, riskLevel: source.riskLevel, tags: [...new Set([...source.tags.filter((tag) => !["breaking", "high-signal"].includes(tag)), "evergreen-reuse", `evergreen:${entry.id}`])], sources: structuredClone(source.sources), claims: structuredClone(source.claims), researchRuns: [], drafts: [newDraft], approvals: [], reviewComments: [], reviewLinks: [], targets: [], publishAttempts: [], proofs: [], createdBy: entry.createdBy, createdAt: now, updatedAt: now };
  const occurrence: EvergreenOccurrence = { id: stableId("evergreen_occurrence", entry.id, occurrenceNo), workspaceId: entry.workspaceId, brandId: entry.brandId, entryId: entry.id, occurrenceNo, scheduledFor, mode: entry.mode, status: "review_ready", contentItemId: item.id, freshnessFlags: evergreenFreshnessFlags(source), createdAt: now, updatedAt: now };
  const event: AuditEvent = { id: `evt_${randomUUID()}`, workspaceId: item.workspaceId, contentItemId: item.id, actorId: "originpost-evergreen", actorType: "system", action: "evergreen.review-draft-created", detail: { evergreenEntryId: entry.id, occurrenceId: occurrence.id, occurrenceNo, sourceContentItemId: source.id, sourceProofId: proof.id, sourceTargetId: target.id, policySha256: entry.policySha256 }, createdAt: now };
  return { item, occurrence, event };
}

export function nextEvergreenTime(entry: EvergreenEntry): { nextPublishAt: string; completed: boolean } {
  const nextCount = entry.occurrenceCount + 1;
  const current=new Date(entry.nextPublishAt);const formatter=new Intl.DateTimeFormat("en-CA",{timeZone:entry.timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});const values=Object.fromEntries(formatter.formatToParts(current).filter((part)=>part.type!=="literal").map((part)=>[part.type,Number(part.value)]));const desired=Date.UTC(values.year!,values.month!-1,values.day!+entry.intervalDays,values.hour!,values.minute!,values.second!);let guess=desired;for(let index=0;index<3;index+=1){const local=Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part)=>part.type!=="literal").map((part)=>[part.type,Number(part.value)]));const represented=Date.UTC(local.year!,local.month!-1,local.day!,local.hour!,local.minute!,local.second!);guess+=desired-represented;}const next=new Date(guess).toISOString();
  return { nextPublishAt: next, completed: nextCount >= entry.maxOccurrences || Date.parse(next) > Date.parse(entry.endAt) };
}

export function deterministicEvergreenContentId(entryId: string, occurrenceNo: number): string { return stableId("content_evergreen", entryId, occurrenceNo); }

export class InMemoryEvergreenRepository implements EvergreenRepository {
  private readonly entries = new Map<string, EvergreenEntry>();
  private readonly occurrences = new Map<string, EvergreenOccurrence>();
  private readonly events: AuditEvent[] = [];
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async list(input: { workspaceId: string; brandId?: string; status?: EvergreenStatus; limit?: number }) { return [...this.entries.values()].filter((entry) => entry.workspaceId === input.workspaceId && (!input.brandId || entry.brandId === input.brandId) && (!input.status || entry.status === input.status)).sort((a,b) => a.nextPublishAt.localeCompare(b.nextPublishAt)).slice(0, Math.min(200,input.limit ?? 100)).map((entry)=>structuredClone(entry)); }
  async get(workspaceId: string,id: string){const entry=this.entries.get(id);return entry?.workspaceId===workspaceId?structuredClone(entry):null;}
  async save(entry: EvergreenEntry,event: AuditEvent){if(this.entries.has(entry.id)||[...this.entries.values()].some((value)=>value.workspaceId===entry.workspaceId&&value.sourceProofId===entry.sourceProofId&&value.status!=="completed"))throw new DomainError("This proof already has an active or paused reuse cycle.","evergreen_exists",409);this.entries.set(entry.id,structuredClone(entry));this.events.push(structuredClone(event));}
  async update(input:{workspaceId:string;id:string;expectedVersion:number;action:"pause"|"resume";actorId:string;at:string;event:AuditEvent}){const current=this.entries.get(input.id);if(!current||current.workspaceId!==input.workspaceId||current.version!==input.expectedVersion)return null;if(input.action==="resume"&&current.status==="completed")return null;const resumedAt=input.action==="resume"?nextEvergreenTime({...current,nextPublishAt:input.at}).nextPublishAt:current.nextPublishAt;const status:EvergreenStatus=input.action==="pause"?"paused":Date.parse(resumedAt)>Date.parse(current.endAt)?"completed":"active";const next={...current,version:current.version+1,status,nextPublishAt:resumedAt,updatedAt:input.at};this.entries.set(input.id,structuredClone(next));this.events.push(structuredClone(input.event));return structuredClone(next);}
  async claimDue(input:{owner:string;before:string;limit:number;leaseSeconds:number}){const now=this.clock();const values=[...this.entries.values()].filter((entry)=>entry.status==="active"&&Date.parse(entry.nextPublishAt)<=Date.parse(input.before)&&(!entry.claimLeaseExpiresAt||Date.parse(entry.claimLeaseExpiresAt)<=now.getTime())).sort((a,b)=>a.nextPublishAt.localeCompare(b.nextPublishAt)).slice(0,input.limit);return values.map((entry)=>{const occurrenceNo=entry.occurrenceCount+1;const claimed:EvergreenEntry={...entry,version:entry.version+1,claimId:`evergreen-claim-${randomUUID()}`,claimOwner:input.owner,claimLeaseExpiresAt:new Date(now.getTime()+input.leaseSeconds*1000).toISOString(),pendingOccurrenceNo:occurrenceNo,pendingContentItemId:deterministicEvergreenContentId(entry.id,occurrenceNo),updatedAt:now.toISOString()};this.entries.set(entry.id,structuredClone(claimed));return structuredClone(claimed);});}
  async completeClaim(input:{workspaceId:string;id:string;claimId:string;occurrence:EvergreenOccurrence;nextPublishAt:string;completed:boolean;at:string}){const current=this.entries.get(input.id);if(!current||current.workspaceId!==input.workspaceId||current.claimId!==input.claimId||Date.parse(current.claimLeaseExpiresAt??"")<=this.clock().getTime())return null;this.occurrences.set(input.occurrence.id,structuredClone(input.occurrence));const next:EvergreenEntry={...current,version:current.version+1,occurrenceCount:current.occurrenceCount+1,nextPublishAt:input.nextPublishAt,status:input.completed?"completed":"active",updatedAt:input.at};delete next.claimId;delete next.claimOwner;delete next.claimLeaseExpiresAt;delete next.pendingOccurrenceNo;delete next.pendingContentItemId;this.entries.set(next.id,structuredClone(next));return structuredClone(next);}
  async failClaim(input:{workspaceId:string;id:string;claimId:string;occurrence:EvergreenOccurrence;at:string}){const current=this.entries.get(input.id);if(!current||current.workspaceId!==input.workspaceId||current.claimId!==input.claimId||Date.parse(current.claimLeaseExpiresAt??"")<=this.clock().getTime())return null;this.occurrences.set(input.occurrence.id,structuredClone(input.occurrence));const next:EvergreenEntry={...current,version:current.version+1,status:"paused",updatedAt:input.at};delete next.claimId;delete next.claimOwner;delete next.claimLeaseExpiresAt;delete next.pendingOccurrenceNo;delete next.pendingContentItemId;this.entries.set(next.id,structuredClone(next));return structuredClone(next);}
  async listOccurrences(workspaceId:string,entryId:string,limit=100){return [...this.occurrences.values()].filter((row)=>row.workspaceId===workspaceId&&row.entryId===entryId).sort((a,b)=>b.occurrenceNo-a.occurrenceNo).slice(0,limit).map((row)=>structuredClone(row));}
  async listOccurrencesAwaitingProof(limit=100){return [...this.occurrences.values()].filter((row)=>row.status==="review_ready"||row.status==="scheduled").sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,Math.min(200,limit)).map((row)=>structuredClone(row));}
  async linkPublishedOccurrence(input:{workspaceId:string;id:string;proofId:string;at:string}){const current=this.occurrences.get(input.id);if(!current||current.workspaceId!==input.workspaceId||!(current.status==="review_ready"||current.status==="scheduled"))return null;const next:EvergreenOccurrence={...current,status:"published",proofId:input.proofId,updatedAt:input.at};this.occurrences.set(input.id,structuredClone(next));return structuredClone(next);}
}
