import 'reflect-metadata';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { startE2eApp } from './test-app.js';
import { AgentRuntimeService } from '../src/agent-runtimes/agent-runtime.service.js';
import { languageSkills, type ContentItem } from '@originpost/domain';
import { AudioService } from '../src/audio/audio.service.js';
import { ElevenLabsAudioProvider } from '../src/audio/audio-provider.js';
import { INFRASTRUCTURE } from '../src/common/tokens.js';
import type { OriginPostInfrastructure } from '../src/infrastructure/infrastructure.types.js';
import { GenerateAudioDto, SaveAudioProfileDto } from '../src/audio/audio.dto.js';
import { adminNetworkAllowed, isCredentialMutation } from '../src/common/admin-network.js';

const owner={id:'audio-owner',name:'Audio Owner',role:'owner' as const};
const models=[{id:'eleven_v3',name:'Eleven v3',languages:[{code:'gu',name:'Gujarati'},{code:'hi',name:'Hindi'},{code:'en',name:'English'}],maxCharacters:5000}];
const provider={id:'elevenlabs',models:vi.fn(async()=>models),voices:vi.fn(async()=>({voices:[{id:'fixture_voice',name:'Fixture voice',category:'premade'}]})),synthesize:vi.fn(async()=>new Uint8Array(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(100)])))};
describe('secure audio workflow',()=>{
  let app:NestFastifyApplication;let service:AudioService;let profileId:string;
  beforeAll(async()=>{
    Object.assign(process.env,{NODE_ENV:'test',AUTH_MODE:'single-user',DATABASE_URL:'',REDIS_URL:'',BOOTSTRAP_USER_ID:owner.id,BOOTSTRAP_USER_NAME:owner.name,REVIEW_LINK_SECRET:'audio-review-fixture-more-than-32-characters',MEDIA_DELIVERY_SECRET:'audio-media-fixture-more-than-32-characters',CREDENTIAL_ENCRYPTION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',AUTOMATION_DELIVERY_ENABLED:'false',MEDIA_MALWARE_SCAN_MODE:'disabled',ADMIN_ALLOWED_IPS:''});
    const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(ElevenLabsAudioProvider).useValue(provider).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({logger:false}));configureApp(app,app.get(ConfigService));await startE2eApp(app);service=app.get(AudioService);
  });
  afterAll(async()=>{await app.close();});
  const settings=()=>Object.assign(new SaveAudioProfileDto(),{workspaceId:'default',brandId:'brand_default',name:'Narration test',model:'eleven_v3',apiKey:'sk_audio_provider_test_placeholder',dailyRequests:1});
  const generation=(id=profileId)=>Object.assign(new GenerateAudioDto(),{workspaceId:'default',brandId:'brand_default',profileId:id,voiceId:'fixture_voice',language:'gu',text:'આ ચકાસેલા સમાચાર છે.',requestId:'audio-test-request-001',rightsConfirmed:true});
  it('encrypts keys, only returns metadata, and validates configuration DTOs',async()=>{
    const created=await request(app.getHttpServer()).post('/v1/audio/profiles').send(settings()).expect(201);profileId=created.body.id;
    const list=await request(app.getHttpServer()).get('/v1/audio?workspaceId=default&brandId=brand_default').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('sk_audio_provider_test_placeholder');expect(list.body.profiles[0].credentialConfigured).toBe(true);
    const infra=app.get<OriginPostInfrastructure>(INFRASTRUCTURE);const stored=await infra.audioRepository.getProfile('default',profileId);
    expect(JSON.stringify(stored)).not.toContain('sk_audio_provider_test_placeholder');expect(stored?.credential.algorithm).toBe('aes-256-gcm');
    await request(app.getHttpServer()).post('/v1/audio/profiles').send({...settings(),apiKey:'key-id-placeholder-not-a-secret'}).expect(400);
    await request(app.getHttpServer()).post('/v1/audio/profiles').send({...settings(),baseUrl:'http://localhost/secrets'}).expect(400);
    await request(app.getHttpServer()).post('/v1/audio/generations').send({...generation(),rightsConfirmed:false}).expect(400);
  });
  it('denies managers, creators, viewers, agents, and cross-brand calls by default',async()=>{
    for(const role of ['manager','creator','viewer'] as const) {
      const actor={...owner,role};await expect(service.save('default',undefined,settings(),actor)).rejects.toThrow(/owner/);
      await expect(service.generate('default',generation(),actor)).rejects.toThrow(/role cannot/);
    }
    await expect(service.save('default',undefined,settings(),{...owner,actorType:'agent'})).rejects.toThrow(/owner/);
    await expect(service.generate('another-workspace',generation(),owner)).rejects.toThrow();
    await request(app.getHttpServer()).get(`/v1/audio/profiles/${profileId}/catalogue?workspaceId=default&brandId=unrelated`).expect(404);
  });
  it('rejects oversized short samples and foreign profiles before reserving usage',async()=>{
    const before=provider.synthesize.mock.calls.length;
    const infra=app.get<OriginPostInfrastructure>(INFRASTRUCTURE);
    const runs=await infra.audioRepository.listRuns('default','brand_default');
    await request(app.getHttpServer()).post('/v1/audio/generations').send({...generation(),sample:true,text:'અ'.repeat(101)}).expect(400);
    await request(app.getHttpServer()).post('/v1/audio/generations').send({...generation(),projectTemplateId:'foreign-template'}).expect(400);
    expect(provider.synthesize.mock.calls.length).toBe(before);
    expect(await infra.audioRepository.listRuns('default','brand_default')).toEqual(runs);
  });
  it('drafts from supported facts and selected locale without calling speech',async()=>{
    const infra=app.get<OriginPostInfrastructure>(INFRASTRUCTURE),runtime=app.get(AgentRuntimeService);
    const item={id:'audio-news',brandId:'brand_default',claims:[{id:'c1',text:'The library opened.',status:'supported',sourceIds:['s1']},{id:'c2',text:'Unverified claim',status:'disputed',sourceIds:[]}],sources:[{id:'s1',title:'Council',url:'https://example.org/library'}]} as ContentItem;
    const get=vi.spyOn(infra.repository,'get').mockResolvedValue(item);
    const templates=vi.spyOn(infra.agentPostRepository,'templates').mockResolvedValue([{id:'template-audio',languageSkills,logoMediaId:'private-logo-reference'}] as never);
    const draft=vi.spyOn(runtime,'runDraft').mockResolvedValue({text:'પુસ્તકાલય ખુલ્યું.',model:'fixture'} as never);
    const before=provider.synthesize.mock.calls.length;
    try {
      const dto={workspaceId:'default',brandId:'brand_default',profileId,requestId:'draft-script-test-001',contentItemId:item.id,language:'gu',sample:true,projectTemplateId:'template-audio'};
      const response=await request(app.getHttpServer()).post('/v1/audio/draft-script').send(dto).expect(201);
      expect(response.body).toMatchObject({status:'ready',text:'પુસ્તકાલય ખુલ્યું.',reviewRequired:true});
      const replay=await request(app.getHttpServer()).post('/v1/audio/draft-script').send(dto).expect(201);
      expect(replay.body).toMatchObject({id:response.body.id,replayed:true,text:response.body.text});
      await request(app.getHttpServer()).post('/v1/audio/draft-script').send({...dto,language:'hi'}).expect(409);
      const packet=JSON.parse(draft.mock.calls[0]![0].messages[1]!.content as string);
      expect(packet.maxCharacters).toBe(100);expect(packet.claims).toHaveLength(1);
      expect(packet.projectLanguageSkills.every((s:{language:string})=>s.language==='gu')).toBe(true);
      expect(JSON.stringify(packet)).not.toContain('private-logo-reference');expect(JSON.stringify(packet)).not.toContain('sk_audio');
      await request(app.getHttpServer()).post('/v1/audio/draft-script').send({...dto,projectTemplateId:'foreign'}).expect(400);
      get.mockResolvedValue({...item,brandId:'foreign'});
      await request(app.getHttpServer()).post('/v1/audio/draft-script').send(dto).expect(404);
      get.mockResolvedValue({...item,claims:[]});
      await request(app.getHttpServer()).post('/v1/audio/draft-script').send(dto).expect(400);
      expect(draft).toHaveBeenCalledTimes(1);expect(provider.synthesize.mock.calls.length).toBe(before);
    } finally {get.mockRestore();templates.mockRestore();draft.mockRestore();}
  });
  it('reserves script budgets across concurrent calls and retains failures without retry',async()=>{
    const infra=app.get<OriginPostInfrastructure>(INFRASTRUCTURE),runtime=app.get(AgentRuntimeService);
    const configured=await service.save('default',undefined,{...settings(),dailyDraftRequests:1},owner);
    const get=vi.spyOn(infra.repository,'get').mockResolvedValue({id:'draft-budget-news',brandId:'brand_default',claims:[{id:'c1',text:'Library opened',status:'supported',sourceIds:[]}],sources:[]} as unknown as ContentItem);
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const draft=vi.spyOn(runtime,'runDraft').mockImplementation(async()=>{await gate;throw new Error('upstream private details');});
    const dto={workspaceId:'default',brandId:'brand_default',profileId:configured.id,contentItemId:'draft-budget-news',language:'gu',sample:true,requestId:'draft-budget-request-001'};
    try {
      const first=service.draft('default',dto,owner);
      await vi.waitFor(()=>expect(draft).toHaveBeenCalledTimes(1));
      expect(await service.draft('default',dto,owner)).toMatchObject({status:'generating',replayed:true});
      await expect(service.draft('default',{...dto,requestId:'draft-budget-request-002'},owner)).rejects.toThrow('daily script-draft limit');
      release();
      const failed=await first;expect(failed.status).toBe('failed');expect(JSON.stringify(failed)).not.toContain('upstream private');
      expect(await service.draft('default',dto,owner)).toMatchObject({id:failed.id,status:'failed',replayed:true});
      expect(draft).toHaveBeenCalledTimes(1);
      expect((await infra.audioRepository.listRuns('default','brand_default')).some(r=>r.id===failed.id)).toBe(false);
      for(const role of ['creator','viewer'] as const) await expect(service.draft('default',dto,{...owner,role})).rejects.toThrow();
    } finally {release();get.mockRestore();draft.mockRestore();}
  });
  it('saves Gujarati narration with provenance, permits downloads, and deduplicates paid calls',async()=>{
    await request(app.getHttpServer()).get(`/v1/audio/profiles/${profileId}/catalogue?workspaceId=default&brandId=brand_default`).expect(200);
    const first=await request(app.getHttpServer()).post('/v1/audio/generations').send(generation()).expect(201);
    expect(first.body.status).toBe('ready');expect(first.body).not.toHaveProperty('text');expect(provider.synthesize).toHaveBeenCalledTimes(1);
    const replay=await request(app.getHttpServer()).post('/v1/audio/generations').send(generation()).expect(201);
    expect(replay.body.id).toBe(first.body.id);expect(replay.body.replayed).toBe(true);expect(provider.synthesize).toHaveBeenCalledTimes(1);
    const infra=app.get<OriginPostInfrastructure>(INFRASTRUCTURE);const media=await infra.mediaRepository.get('default',first.body.mediaId);
    expect(media).toMatchObject({kind:'audio',status:'ready',syntheticLineage:{provider:'elevenlabs',disclosureRequired:true},brandId:'brand_default'});
    await request(app.getHttpServer()).get(`/v1/media-assets/${first.body.mediaId}/download-url?workspaceId=default&brandId=brand_default`).expect(200);
    await request(app.getHttpServer()).post('/v1/audio/generations').send({...generation(),text:'Changed script'}).expect(409);
    await request(app.getHttpServer()).post('/v1/audio/generations').send({...generation(),requestId:'audio-test-request-002'}).expect(429);
  });
  it('allows explicit creator access, blocks unsupported language, and never retries provider errors',async()=>{
    const configured=await service.save('default',undefined,{...settings(),dailyRequests:5,allowedRoles:['creator']},owner);
    const actor={...owner,role:'creator' as const};
    const unsupported=await service.generate('default',{...generation(configured.id),requestId:'unsupported-language-001',language:'xx'},actor);expect(unsupported.status).toBe('failed');
    provider.synthesize.mockRejectedValueOnce(new Error('secret upstream token must never be returned'));
    const dto={...generation(configured.id),requestId:'failure-no-retry-001'};
    const failed=await service.generate('default',dto,actor);expect(failed.status).toBe('failed');expect(JSON.stringify(failed)).not.toContain('secret upstream');
    const calls=provider.synthesize.mock.calls.length;await service.generate('default',dto,actor);expect(provider.synthesize.mock.calls.length).toBe(calls);
    await expect(service.save('default',configured.id,{...settings(),version:0},owner)).rejects.toThrow(/Refresh/);
  });
  it('restricts credential mutations by peer network, ignoring spoofed forwarded headers',async()=>{
    const config=app.get(ConfigService),original=config.get.bind(config);
    const spy=vi.spyOn(config,'get').mockImplementation(((key:string)=>key==='ADMIN_ALLOWED_IPS'?'203.0.113.4':original(key)) as typeof config.get);
    try { await request(app.getHttpServer()).post('/v1/audio/profiles').set('x-forwarded-for','203.0.113.4').send(settings()).expect(403); }
    finally{spy.mockRestore();}
    expect(adminNetworkAllowed('192.0.2.0/24','192.0.2.10')).toBe(true);expect(adminNetworkAllowed('192.0.2.0/24','198.51.100.1')).toBe(false);
    expect(()=>adminNetworkAllowed('not-an-ip','127.0.0.1')).toThrow();expect(isCredentialMutation('POST','/v1/audio/generations')).toBe(false);expect(isCredentialMutation('PATCH','/v1/agent-runtimes/id')).toBe(true);
  });
});
