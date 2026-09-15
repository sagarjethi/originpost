import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { can } from "./permissions.js";
import type { Actor, AuditEvent } from "./types.js";

export type AgentRuntimePreset = "openai" | "openrouter" | "ollama" | "custom" | "codex-local";
export type AgentRuntimeStatus = "unverified" | "healthy" | "error" | "disabled";

export interface AgentRuntimeProfile {
  id: string;
  workspaceId: string;
  version: number;
  name: string;
  preset: AgentRuntimePreset;
  baseUrl: string;
  textModel: string;
  visionModel?: string;
  credentialConfigured: boolean;
  status: AgentRuntimeStatus;
  lastCheckedAt?: string;
  lastError?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntimeCredential {
  keyVersion: "v1";
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface AgentRuntimeAssignment {
  workspaceId: string;
  brandId: string;
  profileId: string;
  assignedBy: string;
  assignedAt: string;
}

export interface AgentRunLedgerEntry {
  id: string;
  workspaceId: string;
  brandId: string;
  profileId: string;
  contentItemId?: string;
  feature: "draft_assist" | "copy_review" | "image_review";
  model: string;
  status: "succeeded" | "failed";
  requestSha256: string;
  responseSha256?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  errorCode?: string;
  createdBy: string;
  createdAt: string;
}

export interface AgentRuntimeExecutionContext {
  profile: AgentRuntimeProfile;
  credential: AgentRuntimeCredential | null;
}

export interface AgentRuntimeRepository {
  listProfiles(workspaceId: string): Promise<AgentRuntimeProfile[]>;
  getProfile(workspaceId: string, id: string): Promise<AgentRuntimeProfile | null>;
  createProfile(profile: AgentRuntimeProfile, credential: AgentRuntimeCredential | null, event: AuditEvent): Promise<void>;
  updateProfile(profile: AgentRuntimeProfile, expectedVersion: number, credential: AgentRuntimeCredential | undefined, event: AuditEvent): Promise<AgentRuntimeProfile | null>;
  removeProfile(workspaceId: string, id: string, expectedVersion: number, event: AuditEvent): Promise<boolean>;
  updateHealth(workspaceId: string, id: string, expectedVersion: number, input: { status: "healthy" | "error"; checkedAt: string; error?: string }, event: AuditEvent): Promise<AgentRuntimeProfile | null>;
  assign(assignment: AgentRuntimeAssignment, event: AuditEvent): Promise<void>;
  unassign(workspaceId: string, brandId: string, event: AuditEvent): Promise<boolean>;
  getAssignment(workspaceId: string, brandId: string): Promise<AgentRuntimeAssignment | null>;
  getProfileExecutionContext(workspaceId: string, profileId: string): Promise<AgentRuntimeExecutionContext | null>;
  getExecutionContext(workspaceId: string, brandId: string): Promise<AgentRuntimeExecutionContext | null>;
  recordRun(run: AgentRunLedgerEntry, event: AuditEvent): Promise<void>;
  listRuns(workspaceId: string, profileId?: string, limit?: number): Promise<AgentRunLedgerEntry[]>;
}

const clean = (value: string, maximum: number, label: string) => {
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum) throw new DomainError(`${label} must contain 1–${maximum} characters.`, "agent_runtime_invalid");
  return result;
};

export function normalizeAgentRuntimeBaseUrl(preset: AgentRuntimePreset, raw?: string): string {
  const fixed = preset === "codex-local" ? "http://127.0.0.1:8765/v1" : preset === "openai" ? "https://api.openai.com/v1" : preset === "openrouter" ? "https://openrouter.ai/api/v1" : undefined;
  const value = fixed ?? raw?.trim();
  if (!value) throw new DomainError("Add the provider base URL.", "agent_runtime_url_required");
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError("Use a valid provider base URL.", "agent_runtime_url_invalid"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DomainError("Provider URL must use HTTP(S) without credentials, query text, or a fragment.", "agent_runtime_url_invalid");
  return url.toString().replace(/\/$/u, "");
}

export function createAgentRuntimeProfile(input: { id?: string; workspaceId: string; name: string; preset: AgentRuntimePreset; baseUrl?: string; textModel: string; visionModel?: string; credentialConfigured: boolean; actor: Actor; now?: string }): { profile: AgentRuntimeProfile; event: AuditEvent } {
  if (input.actor.actorType && input.actor.actorType !== "human" || !can(input.actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can add an AI runtime.", "permission_denied", 403);
  if ((["openai", "openrouter", "codex-local"].includes(input.preset)) && !input.credentialConfigured) throw new DomainError("This provider needs an API key.", "agent_runtime_key_required", 409);
  const now = input.now ?? new Date().toISOString();
  const profile: AgentRuntimeProfile = {
    id: input.id ?? `agent_runtime_${randomUUID()}`,
    workspaceId: clean(input.workspaceId, 100, "Workspace ID"),
    version: 1,
    name: clean(input.name, 100, "Runtime name"),
    preset: input.preset,
    baseUrl: normalizeAgentRuntimeBaseUrl(input.preset, input.baseUrl),
    textModel: clean(input.textModel, 160, "Text model"),
    ...(input.visionModel?.trim() ? { visionModel: clean(input.visionModel, 160, "Vision model") } : {}),
    credentialConfigured: input.credentialConfigured,
    status: "unverified",
    createdBy: input.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  return { profile, event: { id: `evt_${randomUUID()}`, workspaceId: profile.workspaceId, actorId: input.actor.id, actorType: "human", action: "agent-runtime.created", detail: { profileId: profile.id, preset: profile.preset, baseUrl: profile.baseUrl, textModel: profile.textModel, credentialConfigured: profile.credentialConfigured }, createdAt: now } };
}

export function reviseAgentRuntimeProfile(current: AgentRuntimeProfile, input: { name?: string; baseUrl?: string; textModel?: string; visionModel?: string; credentialConfigured?: boolean; disabled?: boolean; actor: Actor; now?: string }): { profile: AgentRuntimeProfile; event: AuditEvent } {
  if (input.actor.actorType && input.actor.actorType !== "human" || !can(input.actor.role, "workspace:manage")) throw new DomainError("Only a workspace owner can change an AI runtime.", "permission_denied", 403);
  const now = input.now ?? new Date().toISOString();
  const credentialConfigured = input.credentialConfigured ?? current.credentialConfigured;
  if ((["openai", "openrouter", "codex-local"].includes(current.preset)) && !credentialConfigured) throw new DomainError("This provider needs an API key.", "agent_runtime_key_required", 409);
  const changedConnection = input.baseUrl !== undefined || input.textModel !== undefined || input.visionModel !== undefined || input.credentialConfigured !== undefined;
  const profile: AgentRuntimeProfile = { ...current, version: current.version + 1, name: input.name === undefined ? current.name : clean(input.name, 100, "Runtime name"), baseUrl: input.baseUrl === undefined ? current.baseUrl : normalizeAgentRuntimeBaseUrl(current.preset, input.baseUrl), textModel: input.textModel === undefined ? current.textModel : clean(input.textModel, 160, "Text model"), credentialConfigured, status: input.disabled === true ? "disabled" : input.disabled === false ? "unverified" : current.status === "disabled" ? "disabled" : changedConnection ? "unverified" : current.status, updatedAt: now };
  if (input.visionModel !== undefined) {
    if (input.visionModel.trim()) profile.visionModel = clean(input.visionModel, 160, "Vision model");
    else delete profile.visionModel;
  }
  if (profile.status !== "error") delete profile.lastError;
  return { profile, event: { id: `evt_${randomUUID()}`, workspaceId: profile.workspaceId, actorId: input.actor.id, actorType: "human", action: "agent-runtime.updated", detail: { profileId: profile.id, version: profile.version, status: profile.status, credentialChanged: input.credentialConfigured !== undefined }, createdAt: now } };
}

export function agentRunHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class InMemoryAgentRuntimeRepository implements AgentRuntimeRepository {
  private readonly profiles = new Map<string, AgentRuntimeProfile>();
  private readonly credentials = new Map<string, AgentRuntimeCredential>();
  private readonly assignments = new Map<string, AgentRuntimeAssignment>();
  private readonly runs: AgentRunLedgerEntry[] = [];
  private readonly events: AuditEvent[] = [];
  async listProfiles(workspaceId: string) { return [...this.profiles.values()].filter((row) => row.workspaceId === workspaceId).sort((a,b)=>a.name.localeCompare(b.name)).map((row)=>structuredClone(row)); }
  async getProfile(workspaceId: string,id: string){const row=this.profiles.get(id);return row?.workspaceId===workspaceId?structuredClone(row):null;}
  async createProfile(profile:AgentRuntimeProfile,credential:AgentRuntimeCredential|null,event:AuditEvent){if(this.profiles.has(profile.id))throw new DomainError("AI runtime already exists.","agent_runtime_exists",409);this.profiles.set(profile.id,structuredClone(profile));if(credential)this.credentials.set(profile.id,structuredClone(credential));this.events.push(structuredClone(event));}
  async updateProfile(profile:AgentRuntimeProfile,expectedVersion:number,credential:AgentRuntimeCredential|undefined,event:AuditEvent){const current=this.profiles.get(profile.id);if(!current||current.workspaceId!==profile.workspaceId||current.version!==expectedVersion)return null;this.profiles.set(profile.id,structuredClone(profile));if(credential)this.credentials.set(profile.id,structuredClone(credential));this.events.push(structuredClone(event));return structuredClone(profile);}
  async removeProfile(workspaceId:string,id:string,expectedVersion:number,event:AuditEvent){const current=this.profiles.get(id);if(!current||current.workspaceId!==workspaceId||current.version!==expectedVersion)return false;this.profiles.delete(id);this.credentials.delete(id);for(const [key,value] of this.assignments)if(value.profileId===id)this.assignments.delete(key);this.events.push(structuredClone(event));return true;}
  async updateHealth(workspaceId:string,id:string,expectedVersion:number,input:{status:"healthy"|"error";checkedAt:string;error?:string},event:AuditEvent){const current=this.profiles.get(id);if(!current||current.workspaceId!==workspaceId||current.version!==expectedVersion)return null;const next={...current,version:current.version+1,status:input.status,lastCheckedAt:input.checkedAt,updatedAt:input.checkedAt,...(input.error?{lastError:input.error}:{})};if(!input.error)delete next.lastError;this.profiles.set(id,structuredClone(next));this.events.push(structuredClone(event));return structuredClone(next);}
  async assign(value:AgentRuntimeAssignment,event:AuditEvent){const profile=this.profiles.get(value.profileId);if(!profile||profile.workspaceId!==value.workspaceId||profile.status!=="healthy")throw new DomainError("Test this AI runtime before assigning it.","agent_runtime_not_ready",409);this.assignments.set(`${value.workspaceId}:${value.brandId}`,structuredClone(value));this.events.push(structuredClone(event));}
  async unassign(workspaceId:string,brandId:string,event:AuditEvent){const removed=this.assignments.delete(`${workspaceId}:${brandId}`);if(removed)this.events.push(structuredClone(event));return removed;}
  async getAssignment(workspaceId:string,brandId:string){const value=this.assignments.get(`${workspaceId}:${brandId}`);return value?structuredClone(value):null;}
  async getProfileExecutionContext(workspaceId:string,profileId:string){const profile=this.profiles.get(profileId);if(!profile||profile.workspaceId!==workspaceId)return null;return{profile:structuredClone(profile),credential:this.credentials.has(profile.id)?structuredClone(this.credentials.get(profile.id)!):null};}
  async getExecutionContext(workspaceId:string,brandId:string){const assignment=await this.getAssignment(workspaceId,brandId);if(!assignment)return null;const profile=this.profiles.get(assignment.profileId);if(!profile||profile.status!=="healthy")return null;return{profile:structuredClone(profile),credential:this.credentials.has(profile.id)?structuredClone(this.credentials.get(profile.id)!):null};}
  async recordRun(run:AgentRunLedgerEntry,event:AuditEvent){this.runs.push(structuredClone(run));this.events.push(structuredClone(event));}
  async listRuns(workspaceId:string,profileId?:string,limit=100){return this.runs.filter((row)=>row.workspaceId===workspaceId&&(!profileId||row.profileId===profileId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,Math.min(200,limit)).map((row)=>structuredClone(row));}
}
