import { DomainError } from './errors.js';
import type { Actor, AuditEvent, EncryptedCredential } from './types.js';

export interface AudioSkill {
  id: string; version: string; name: string; language: string; instructions: string; maxCharacters: number;
}
export interface AudioProfile {
  id: string; workspaceId: string; brandId: string; version: number; provider: 'elevenlabs'; name: string; model: string;
  enabled: boolean; allowedRoles: Actor['role'][]; maxCharacters: number; dailyRequests: number;
  projectTemplateId?: string;
  skills: AudioSkill[]; credentialConfigured: boolean; createdBy: string; updatedAt: string;
}
export interface AudioRun {
  projectTemplateId?: string;
  id: string; workspaceId: string; brandId: string; profileId: string; profileVersion: number; contentItemId?: string;
  requestHash: string; idempotencyHash: string; textHash: string; characterCount: number; model: string; voiceId: string;
  language: string; skillId?: string; skillVersion?: string; status: 'generating' | 'ready' | 'failed';
  mediaId?: string; error?: string; createdBy: string; createdAt: string; completedAt?: string;
}
export interface AudioRepository {
  listProfiles(workspaceId: string, brandId: string): Promise<AudioProfile[]>;
  getProfile(workspaceId: string, id: string): Promise<{ profile: AudioProfile; credential: EncryptedCredential } | null>;
  saveProfile(profile: AudioProfile, credential: EncryptedCredential, expectedVersion: number, event: AuditEvent): Promise<void>;
  reserve(run: AudioRun, event: AuditEvent): Promise<{ run: AudioRun; created: boolean }>;
  finish(run: AudioRun, event: AuditEvent): Promise<void>;
  listRuns(workspaceId: string, brandId: string): Promise<AudioRun[]>;
}
export function assertAudioReplay(previous: AudioRun, next: AudioRun) {
  if (previous.requestHash !== next.requestHash) throw new DomainError('This request key was already used for different audio.', 'audio_idempotency_conflict', 409);
}
export function assertAudioBudget(profile: AudioProfile | undefined, run: AudioRun, used: number) {
  if (!profile || !profile.enabled || profile.version !== run.profileVersion) throw new DomainError('Audio settings changed. Refresh before generating.', 'audio_profile_changed', 409);
  if (used >= profile.dailyRequests) throw new DomainError('This provider has reached its daily request limit. The owner can change the limit.', 'audio_daily_limit', 429);
}
export class InMemoryAudioRepository implements AudioRepository {
  private profiles = new Map<string, { profile: AudioProfile; credential: EncryptedCredential }>();
  private runs = new Map<string, AudioRun>();
  readonly events: AuditEvent[] = [];
  async listProfiles(w: string, b: string) { return structuredClone([...this.profiles.values()].map(x => x.profile).filter(x => x.workspaceId === w && x.brandId === b)); }
  async getProfile(w: string, id: string) { const value = this.profiles.get(id); return value?.profile.workspaceId === w ? structuredClone(value) : null; }
  async saveProfile(profile: AudioProfile, credential: EncryptedCredential, version: number, event: AuditEvent) {
    const current = this.profiles.get(profile.id)?.profile;
    if ((current?.version ?? 0) !== version || (current && current.workspaceId !== profile.workspaceId)) throw new DomainError('Audio settings changed. Refresh.', 'version_conflict', 409);
    this.profiles.set(profile.id, structuredClone({ profile, credential })); this.events.push(event);
  }
  async reserve(run: AudioRun, event: AuditEvent) {
    const previous = [...this.runs.values()].find(x => x.workspaceId === run.workspaceId && x.idempotencyHash === run.idempotencyHash);
    if (previous) { assertAudioReplay(previous, run); return { run: structuredClone(previous), created: false }; }
    const used = [...this.runs.values()].filter(x => x.workspaceId === run.workspaceId && x.profileId === run.profileId && x.createdAt.slice(0, 10) === run.createdAt.slice(0, 10)).length;
    assertAudioBudget(this.profiles.get(run.profileId)?.profile, run, used);
    this.runs.set(run.id, structuredClone(run)); this.events.push(event); return { run, created: true };
  }
  async finish(run: AudioRun, event: AuditEvent) { const current = this.runs.get(run.id); if (current?.workspaceId === run.workspaceId && current.status === 'generating') { this.runs.set(run.id, structuredClone(run)); this.events.push(event); } }
  async listRuns(w: string, b: string) { return structuredClone([...this.runs.values()].filter(x => x.workspaceId === w && x.brandId === b).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,100)); }
}
