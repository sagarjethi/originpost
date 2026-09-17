import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { can, type Actor, type AudioProfile, type AudioRun, type AuditEvent } from '@originpost/domain';
import { decodeCredentialEncryptionKey, openEncryptedCredential } from '@originpost/connectors';
import type { OriginPostInfrastructure } from '../infrastructure/infrastructure.types.js';
import { INFRASTRUCTURE } from '../common/tokens.js';
import { CredentialVaultService } from '../channels/credential-vault.service.js';
import { MediaService } from '../media/media.service.js';
import { AudioProviders } from './audio-provider.js';
import type { GenerateAudioDto, SaveAudioProfileDto } from './audio.dto.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
@Injectable()
export class AudioService {
  constructor(@Inject(INFRASTRUCTURE) private readonly infra: OriginPostInfrastructure, private readonly config: ConfigService, private readonly vault: CredentialVaultService, private readonly providers: AudioProviders, private readonly media: MediaService) {}
  private read(actor: Actor) { if (!can(actor.role,'content:read')) throw new ForbiddenException(); }
  private owner(actor: Actor) { if (actor.role !== 'owner' || (actor.actorType && actor.actorType !== 'human')) throw new ForbiddenException('Only a human workspace owner can configure audio credentials and permissions.'); }
  private async brand(w: string,b: string) { const brand = await this.infra.organizationRepository.getBrand(w,b); if (!brand || brand.status !== 'active') throw new NotFoundException('Active brand not found.'); }
  private audit(w: string,actor: Actor,action: string,detail: Record<string,unknown>): AuditEvent { return { id: `evt_${randomUUID()}`,workspaceId:w,actorId:actor.id,actorType:actor.actorType ?? 'human',action,detail,createdAt:new Date().toISOString() }; }
  private async context(w: string,b: string,id: string,actor: Actor) {
    this.read(actor); await this.brand(w,b); const context = await this.infra.audioRepository.getProfile(w,id);
    if (!context || context.profile.brandId !== b) throw new NotFoundException('Audio provider not found in this brand.');
    return context;
  }
  private key(credential: Parameters<typeof openEncryptedCredential>[0]) { const key=decodeCredentialEncryptionKey(this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY')); if (!key) throw new BadRequestException('Credential encryption is not configured.'); try { return openEncryptedCredential(credential,key); } catch { throw new BadRequestException('The protected key cannot be opened. The owner must reconnect it.'); } }
  private use(profile: AudioProfile,actor: Actor) { if (!profile.enabled || !profile.allowedRoles.includes(actor.role) || !can(actor.role,'content:edit') || (actor.actorType && actor.actorType !== 'human')) throw new ForbiddenException('This audio provider is disabled or your role cannot use it.'); }
  async list(w: string,b: string,actor: Actor) { this.read(actor); await this.brand(w,b); return { profiles: await this.infra.audioRepository.listProfiles(w,b), runs: await this.infra.audioRepository.listRuns(w,b), encryptionConfigured:this.vault.configured(), adminIpRestricted:Boolean(this.config.get<string>('ADMIN_ALLOWED_IPS')?.trim()) }; }
  async save(w: string,id: string | undefined,dto: SaveAudioProfileDto,actor: Actor) {
    this.owner(actor); await this.brand(w,dto.brandId);
    const current = id ? await this.context(w,dto.brandId,id,actor) : null;
    if ((!id && dto.version !== 0) || (id && dto.version !== current?.profile.version)) throw new BadRequestException('Refresh the provider settings before saving.');
    for (const skill of dto.skills) { const previous=current?.profile.skills.find(s=>s.id===skill.id); if (previous && previous.version===skill.version && JSON.stringify(previous)!==JSON.stringify(skill)) throw new BadRequestException('Increment the skill version when changing its instructions or limits.'); }
    if (new Set(dto.skills.map(s => s.id)).size !== dto.skills.length) throw new BadRequestException('Skill IDs must be unique.');
    const profile: AudioProfile = { id: id ?? `audio_profile_${randomUUID()}`,workspaceId:w,brandId:dto.brandId,version:dto.version+1,provider:dto.provider,name:dto.name.trim(),model:dto.model,enabled:dto.enabled,allowedRoles:dto.allowedRoles,maxCharacters:dto.maxCharacters,dailyRequests:dto.dailyRequests,skills:dto.skills,credentialConfigured:true,createdBy:current?.profile.createdBy ?? actor.id,updatedAt:new Date().toISOString() };
    const credential = dto.apiKey?.trim() ? this.vault.seal(w,'provider-token',dto.apiKey.trim()) : current?.credential;
    if (!credential) throw new BadRequestException('An API key is required for a new provider.');
    await this.infra.audioRepository.saveProfile(profile,credential,dto.version,this.audit(w,actor,'audio.profile-saved',{profileId:profile.id,version:profile.version,enabled:profile.enabled,allowedRoles:profile.allowedRoles}));
    return profile;
  }
  async catalogue(w: string,b: string,id: string,actor: Actor,cursor?: string) {
    const {profile,credential}=await this.context(w,b,id,actor);
    if (actor.role !== 'owner') this.use(profile,actor);
    const provider=this.providers.get(profile.provider), key=this.key(credential);
    const [models,voices]=await Promise.all([provider.models(key),provider.voices(key,cursor)]);
    return {models,...voices};
  }
  async generate(w: string,dto: GenerateAudioDto,actor: Actor) {
    const {profile,credential}=await this.context(w,dto.brandId,dto.profileId,actor); this.use(profile,actor);
    const text=dto.text.normalize('NFC').trim(), skill=dto.skillId ? profile.skills.find(s=>s.id===dto.skillId) : undefined;
    if (dto.skillId && (!skill || skill.language !== dto.language)) throw new BadRequestException('Select a skill matching the spoken language.');
    if (!text || text.length > Math.min(profile.maxCharacters,skill?.maxCharacters ?? 3000)) throw new BadRequestException('The script exceeds the configured character limit.');
    if (dto.contentItemId) { const item=await this.infra.repository.get(w,dto.contentItemId); if (!item || item.brandId!==dto.brandId) throw new NotFoundException('Content item not found in this brand.'); }
    const run: AudioRun={id:`audio_run_${randomUUID()}`,workspaceId:w,brandId:dto.brandId,profileId:profile.id,profileVersion:profile.version,...(dto.contentItemId?{contentItemId:dto.contentItemId}:{}),requestHash:hash(JSON.stringify({profileId:profile.id,version:profile.version,text,voiceId:dto.voiceId,language:dto.language,skillId:dto.skillId,contentItemId:dto.contentItemId,actorId:actor.id})),idempotencyHash:hash(dto.requestId),textHash:hash(text),characterCount:text.length,model:profile.model,voiceId:dto.voiceId,language:dto.language,...(skill?{skillId:skill.id,skillVersion:skill.version}:{}),status:'generating',createdBy:actor.id,createdAt:new Date().toISOString()};
    const reserved=await this.infra.audioRepository.reserve(run,this.audit(w,actor,'audio.requested',{runId:run.id,profileId:profile.id,characterCount:text.length,textHash:run.textHash,rightsConfirmed:true}));
    if (!reserved.created) return {...reserved.run,replayed:true};
    try {
      const provider=this.providers.get(profile.provider),key=this.key(credential),model=(await provider.models(key)).find(m=>m.id===profile.model);
      if (!model || !model.languages.some(l=>l.code===dto.language) || text.length>model.maxCharacters) throw new BadRequestException('The configured model does not support this language or script length. Ask the owner to choose a supported model.');
      const audio=await provider.synthesize(key,{text,voiceId:dto.voiceId,language:dto.language,model:profile.model});
      const media=await this.media.createGeneratedAudio({id:`media_${run.id}`,workspaceId:w,brandId:dto.brandId,...(dto.contentItemId?{contentItemId:dto.contentItemId}:{}),fileName:`narration-${dto.language}-${run.id}.mp3`,contentType:'audio/mpeg',bytes:audio,rights:'cleared',altText:`AI-generated narration (${dto.language})`,origin:{type:'ai-generation',generationId:run.id},syntheticLineage:{kind:'ai-generation',generationId:run.id,provider:'elevenlabs',model:profile.model,promptSha256:run.textHash,generatedAt:new Date().toISOString(),sourceEvidenceIds:[],disclosureRequired:true}},actor);
      const ready: AudioRun={...run,status:'ready',mediaId:media.id,completedAt:new Date().toISOString()};
      await this.infra.audioRepository.finish(ready,this.audit(w,actor,'audio.ready',{runId:run.id,mediaId:media.id})); return ready;
    } catch {
      const failed: AudioRun={...run,status:'failed',error:'Audio was not completed. Check the model language, key permissions and provider quota. A request may have been charged; it will not retry automatically.',completedAt:new Date().toISOString()};
      await this.infra.audioRepository.finish(failed,this.audit(w,actor,'audio.failed',{runId:run.id})); return failed;
    }
  }
}
